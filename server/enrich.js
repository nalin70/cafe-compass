import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import OpeningHours from 'opening_hours';

// Reads public business info (opening hours, phone, price range, menu link, Instagram) from a cafe's OWN website,
// mostly from its schema.org JSON-LD, to fill gaps in OpenStreetMap. Everything fetched is untrusted input:
//  - only public internet addresses (checked when connecting, so DNS tricks and redirects can't reach your network)
//  - robots.txt is respected, requests are small, slow and capped, and nothing from the page is ever executed.

const UA = 'cafe-finder/0.1 (personal project; reads public business info such as opening hours from cafe websites)';
const UA_TOKEN = 'cafe-finder';
const MAX_BYTES = 1_500_000, TOTAL_TIMEOUT_MS = 10_000, MAX_REDIRECTS = 3;
const allowLoopback = () => process.env.ENRICH_ALLOW_PRIVATE === '1'; // tests only: lets tests reach a fake site on this computer (loopback ONLY)

// ---------------------------------------------------------------- network safety
function isPrivateV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
}

function expandV6(ip) {
  ip = ip.split('%')[0];
  const tail = ip.match(/(\d+\.\d+\.\d+\.\d+)$/); // ::ffff:1.2.3.4
  if (tail) {
    const [a, b, c, d] = tail[1].split('.').map(Number);
    ip = ip.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, rest] = ip.split('::');
  const h = head ? head.split(':') : [], r = rest === undefined ? [] : rest ? rest.split(':') : [];
  const parts = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  return parts.map((x) => parseInt(x || '0', 16));
}

/** True for anything that isn't an ordinary public internet address (or isn't an IP at all). */
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip.split('.').map(Number));
  if (!net.isIPv6(ip)) return true;
  const h = expandV6(ip);
  const embedded = [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255];
  if (h.slice(0, 5).every((x) => x === 0) && (h[5] === 0xffff || h[5] === 0)) return isPrivateV4(embedded); // ::, ::1, ::ffff:a.b.c.d
  if (h[0] === 0x64 && h[1] === 0xff9b) return isPrivateV4(embedded); // NAT64
  if (h[0] === 0x2002) return true;                                    // 6to4
  if (h[0] === 0x2001 && (h[1] === 0 || h[1] === 0x0db8)) return true; // Teredo, documentation
  return (h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] & 0xff00) === 0xff00;
}

const isLoopback = (ip) => ip === '::1' || ip.startsWith('127.') || ip.toLowerCase().startsWith('::ffff:127.');
const blocked = (ip) => isPrivateAddress(ip) && !(allowLoopback() && isLoopback(ip));

// Used for every connection, so the address that is actually connected to is the one that was checked.
export function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.some((a) => blocked(a.address))) return cb(new Error('blocked: not a public address'));
    return options.all ? cb(null, addrs) : cb(null, addrs[0].address, addrs[0].family);
  });
}

function parseSafeUrl(s) {
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('blocked: not http(s)');
  if (u.username || u.password) throw new Error('blocked: credentials in URL');
  if (!allowLoopback() && u.port && u.port !== '80' && u.port !== '443') throw new Error('blocked: unusual port');
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(h) ? blocked(h) : !allowLoopback() && (h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h))) throw new Error('blocked: not a public address');
  return u;
}

function requestOnce(url, { accept, maxBytes = MAX_BYTES }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let done = false, timer;
    const finish = (err, value) => {
      if (done) return;
      done = true; clearTimeout(timer); req.destroy();
      err ? reject(err) : resolve(value);
    };
    const req = lib.request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined, path: url.pathname + url.search, method: 'GET',
      headers: { 'User-Agent': UA, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br', 'Accept-Language': 'en' },
      lookup: safeLookup,
    }, (res) => {
      const status = res.statusCode, type = String(res.headers['content-type'] || '');
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) return finish(null, { status, redirect: res.headers.location });
      if (status >= 400 || status < 200) return finish(null, { status, type, body: '' });
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', (c) => { // the cap applies to the decompressed size, so a "zip bomb" can't use up memory
        size += c.length;
        if (size > maxBytes) { chunks.push(c.subarray(0, c.length - (size - maxBytes))); finish(null, { status, type, body: Buffer.concat(chunks).toString('utf8'), truncated: true }); } else chunks.push(c);
      });
      stream.on('end', () => finish(null, { status, type, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', finish);
    });
    timer = setTimeout(() => finish(new Error('timeout')), TOTAL_TIMEOUT_MS);
    req.on('error', finish);
    req.end();
  });
}

/** GET a page as text, following up to 3 redirects, re-checking every hop. */
export async function fetchText(startUrl, opts = { accept: 'text/html,application/xhtml+xml' }) {
  let url = parseSafeUrl(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await requestOnce(url, opts);
    if (r.redirect) { url = parseSafeUrl(new URL(r.redirect, url).href); continue; }
    return { ...r, url: url.href };
  }
  throw new Error('too many redirects');
}

// ---------------------------------------------------------------- robots.txt
/** Does robots.txt allow `path` for us? (Longest matching rule wins; Allow beats Disallow on a tie.) */
export function robotsAllowed(txt, path) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase()); lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', pattern: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && UA_TOKEN.includes(a) && a.length > 0));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of chosen) for (const r of g.rules) {
    if (!r.pattern) continue; // "Disallow:" with nothing means allow everything
    const re = new RegExp('^' + r.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow))) best = r;
  }
  return best ? best.allow : true;
}

const robotsCache = new Map(); // origin -> { at, txt|null }
async function robotsAllows(url) {
  const origin = new URL(url).origin, hit = robotsCache.get(origin);
  let txt;
  if (hit && Date.now() - hit.at < 24 * 3600e3) txt = hit.txt;
  else {
    const r = await fetchText(`${origin}/robots.txt`, { accept: 'text/plain,*/*;q=0.5', maxBytes: 200_000 });
    if (r.status >= 500) throw new Error('robots.txt unavailable'); // can't tell, so don't crawl for now
    txt = r.status >= 400 ? '' : r.body; // no robots.txt (4xx) means everything is allowed
    robotsCache.set(origin, { at: Date.now(), txt });
    if (robotsCache.size > 500) robotsCache.delete(robotsCache.keys().next().value);
  }
  const u = new URL(url);
  return robotsAllowed(txt, u.pathname + u.search);
}

// ---------------------------------------------------------------- opening hours
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = { monday: 0, mon: 0, mo: 0, tuesday: 1, tue: 1, tues: 1, tu: 1, wednesday: 2, wed: 2, we: 2, thursday: 3, thu: 3, thur: 3, thurs: 3, th: 3, friday: 4, fri: 4, fr: 4, saturday: 5, sat: 5, sa: 5, sunday: 6, sun: 6, su: 6 };
const dayIndex = (v) => DAY_NAMES[String(v).replace(/^https?:\/\/schema\.org\//i, '').trim().toLowerCase()];

function hhmm(v) { // "8:00", "08:00:00", "8am", "5:30 PM" -> "08:00" / "17:30"
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?$/i.exec(String(v).trim());
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] ?? 0);
  if (m[3]) { h = h % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0); }
  if (h > 24 || mi > 59 || (h === 24 && mi > 0)) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function validHours(str) {
  try { new OpeningHours(str); return true; } catch { return false; }
}

// day index -> ["08:00-17:00", ...]  ==>  "Mo-Fr 08:00-17:00; Sa 09:00-14:00"
function composeHours(byDay) {
  const sig = (d) => (byDay[d] ? byDay[d].join(',') : '');
  const out = [];
  for (let d = 0; d < 7; ) {
    if (!sig(d)) { d++; continue; }
    let e = d;
    while (e + 1 < 7 && sig(e + 1) === sig(d)) e++;
    out.push(`${e > d ? `${DAYS[d]}-${DAYS[e]}` : DAYS[d]} ${sig(d)}`);
    d = e + 1;
  }
  return out.join('; ');
}

/** schema.org openingHoursSpecification / openingHours -> an OpenStreetMap opening_hours string (validated), or null. */
export function hoursFromLd(node) {
  const byDay = {};
  const add = (d, a, b) => {
    const open = hhmm(a), close0 = hhmm(b);
    if (d == null || !open || !close0) return;
    const close = close0 === '00:00' && open !== '00:00' ? '24:00' : close0;
    (byDay[d] ??= []).push(`${open}-${close}`);
  };
  for (const spec of [].concat(node.openingHoursSpecification ?? [])) {
    if (!spec || typeof spec !== 'object' || spec.validFrom || spec.validThrough) continue; // skip seasonal / holiday rules
    for (const d of [].concat(spec.dayOfWeek ?? [])) add(dayIndex(d), spec.opens, spec.closes);
  }
  if (!Object.keys(byDay).length) { // the compact text form: "Mo-Fr 08:00-17:00" or "Mo,Tu 09:00-12:00,13:00-17:00"
    const re = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2}(?:,\d{1,2}:\d{2}-\d{1,2}:\d{2})*)$/;
    for (const item of [].concat(node.openingHours ?? [])) {
      const m = typeof item === 'string' ? re.exec(item.trim()) : null;
      if (!m) continue;
      const days = [];
      for (const part of m[1].split(',')) {
        const [a, b] = part.split('-');
        for (let d = DAYS.indexOf(a); d <= (b ? DAYS.indexOf(b) : DAYS.indexOf(a)); d++) days.push(d);
      }
      for (const range of m[2].split(',')) { const [a, b] = range.split('-'); for (const d of days) add(d, a, b); }
    }
  }
  const str = composeHours(byDay);
  return str && validHours(str) ? str : null;
}

// ---------------------------------------------------------------- HTML extraction
const clean = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = v.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }[e]));
const httpUrl = (u, base) => { try { const x = new URL(u, base); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href.slice(0, 500) : null; } catch { return null; } };
const phoneOk = (p) => (p && (p.match(/\d/g) || []).length >= 7 && /^[+\d\s().-]{7,30}$/.test(p) ? p.trim() : null);
const IG_RESERVED = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'tv', 'share', 'direct', 'about', 'legal', 'developer', 'privacy', 'web']);
const instagramFrom = (u) => {
  const m = /instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#]|$)/i.exec(String(u || ''));
  return m && !IG_RESERVED.has(m[1].toLowerCase()) ? `https://instagram.com/${m[1]}` : null;
};
const BUSINESS_TYPES = new Set(['cafeorcoffeeshop', 'restaurant', 'foodestablishment', 'bakery', 'localbusiness', 'barorpub', 'icecreamshop', 'fastfoodrestaurant', 'store']);

function* ldNodes(x) {
  if (Array.isArray(x)) for (const i of x) yield* ldNodes(i);
  else if (x && typeof x === 'object') { yield x; if (x['@graph']) yield* ldNodes(x['@graph']); }
}

function jsonLdBusinesses(html) {
  const found = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m, n = 0; (m = re.exec(html)) && n < 20; n++) {
    let data;
    try { data = JSON.parse(m[1].replace(/^\s*(?:\/\*\s*<!\[CDATA\[\s*\*\/|<!\[CDATA\[)/, '').replace(/(?:\/\*\s*\]\]>\s*\*\/|\]\]>)\s*$/, '')); } catch { continue; }
    for (const node of ldNodes(data)) {
      const types = [].concat(node['@type'] ?? []).map((t) => String(t).toLowerCase().replace(/^.*[/#]/, ''));
      if (types.some((t) => BUSINESS_TYPES.has(t))) found.push(node);
    }
  }
  return found;
}

/** Pull the useful public facts out of a homepage. Pure function (no network). Returns only the fields it found. */
export function extractFromHtml(html, baseUrl) {
  html = html.slice(0, MAX_BYTES);
  const out = {};
  const nodes = jsonLdBusinesses(html);
  // prefer the node that actually carries hours or a phone number
  const node = nodes.find((n) => n.openingHoursSpecification || n.openingHours) ?? nodes.find((n) => n.telephone) ?? nodes[0];
  if (node) {
    const hours = hoursFromLd(node); if (hours) out.hours = hours;
    const phone = phoneOk(clean(String(node.telephone ?? ''), 30)); if (phone) out.phone = phone;
    const price = clean(String(node.priceRange ?? ''), 30); if (price && /\S/.test(price)) out.priceRange = price;
    const cuisine = [].concat(node.servesCuisine ?? []).map((c) => clean(String(c), 40)).filter(Boolean).slice(0, 5); if (cuisine.length) out.cuisine = cuisine;
    const menu = httpUrl(typeof node.hasMenu === 'string' ? node.hasMenu : node.hasMenu?.url ?? (typeof node.menu === 'string' ? node.menu : ''), baseUrl); if (menu) out.menuUrl = menu;
    const email = clean(String(node.email ?? ''), 120)?.replace(/^mailto:/i, ''); if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.email = email;
    if (node.acceptsReservations !== undefined) out.reservations = node.acceptsReservations === true || /^(true|yes)$/i.test(String(node.acceptsReservations)) || /^https?:/i.test(String(node.acceptsReservations));
    const ig = [].concat(node.sameAs ?? []).map(instagramFrom).find(Boolean); if (ig) out.instagram = ig;
    const desc = clean(decode(String(node.description ?? '')), 220); if (desc) out.description = desc;
  }
  // fall back to ordinary page markup for whatever the structured data didn't give
  if (!out.phone) { const m = /href\s*=\s*["']tel:([^"']+)["']/i.exec(html); const p = m && phoneOk(decodeURIComponent(m[1]).replace(/[^\d+().\s-]/g, '')); if (p) out.phone = p; }
  if (!out.email) { const m = /href\s*=\s*["']mailto:([^"'?]+)/i.exec(html); const e = m && decodeURIComponent(m[1]).trim(); if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 120) out.email = e; }
  if (!out.instagram) { const m = /href\s*=\s*["']([^"']*instagram\.com\/[^"']*)["']/gi; for (let x; (x = m.exec(html)); ) { const ig = instagramFrom(x[1]); if (ig) { out.instagram = ig; break; } } }
  if (!out.menuUrl) {
    const a = /<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let weak = null;
    for (let m, n = 0; (m = a.exec(html)) && n < 600; n++) {
      if (/^(mailto|tel|javascript):/i.test(m[1])) continue;
      const url = httpUrl(decode(m[1]), baseUrl);
      if (!url) continue;
      if (/\bmenu\b/i.test(clean(m[2], 60) ?? '')) { out.menuUrl = url; break; }
      if (!weak && /menu/i.test(new URL(url).pathname)) weak = url;
    }
    if (!out.menuUrl && weak) out.menuUrl = weak;
  }
  if (!out.description) {
    const m = /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:description|description)["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html)
      ?? /<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*(?:property|name)\s*=\s*["'](?:og:description|description)["']/i.exec(html);
    const d = m && clean(decode(m[1]), 220); if (d && d.length > 20) out.description = d;
  }
  return out;
}

// ---------------------------------------------------------------- putting it together
/** Turn whatever OpenStreetMap has in `website` ("www.x.com", "https://x.com") into a safe URL, or null. */
export function normalizeWebsite(w) {
  if (typeof w !== 'string' || !w.trim() || w.length > 300) return null;
  try { return parseSafeUrl(/^[a-z][a-z0-9+.-]*:/i.test(w.trim()) ? w.trim() : `https://${w.trim()}`).href; } catch { return null; }
}

/** The title of a page, for labelling a pasted article link. Same safety rules as everything else here; null on any problem. */
export async function fetchPageTitle(url) {
  const safe = normalizeWebsite(url);
  if (!safe) return null;
  try {
    if (!(await robotsAllows(safe))) return null;
    const r = await fetchText(safe, { accept: 'text/html,application/xhtml+xml', maxBytes: 400_000 });
    if (r.status >= 400 || r.status < 200 || !/html/i.test(r.type)) return null;
    const og = /<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(r.body)
      ?? /<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i.exec(r.body);
    const t = og?.[1] ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(r.body)?.[1];
    return t ? clean(decode(t), 150) : null;
  } catch { return null; }
}

/** @returns {Promise<{status: 'ok'|'none'|'blocked'|'error', data: object|null, url: string|null}>} */
export async function enrichWebsite(website) {
  const url = normalizeWebsite(website);
  if (!url) return { status: 'none', data: null, url: null };
  try {
    if (!(await robotsAllows(url))) return { status: 'blocked', data: null, url };
    const r = await fetchText(url);
    if (r.status >= 400 || r.status < 200) return { status: 'error', data: null, url };
    if (!/html|xml/i.test(r.type)) return { status: 'none', data: null, url: r.url };
    const data = extractFromHtml(r.body, r.url);
    return Object.keys(data).length ? { status: 'ok', data, url: r.url } : { status: 'none', data: null, url: r.url };
  } catch {
    return { status: 'error', data: null, url };
  }
}

/** Fill gaps in a cafe from its website data. OpenStreetMap values are kept; new kinds of info are added. */
export function applyEnrichment(cafe, enr) {
  if (!enr?.data) return cafe;
  const d = enr.data, fields = [];
  const out = { ...cafe, details: { ...cafe.details } };
  const fill = (cond, apply, name) => { if (cond) { apply(); fields.push(name); } };
  fill(!out.hours && d.hours, () => { out.hours = d.hours; }, 'hours');
  fill(!out.details.phone && d.phone, () => { out.details.phone = d.phone; }, 'phone');
  fill(!out.details.email && d.email, () => { out.details.email = d.email; }, 'email');
  fill(!out.details.instagram && d.instagram, () => { out.details.instagram = d.instagram; }, 'instagram');
  fill(!out.details.description && d.description, () => { out.details.description = d.description; }, 'description');
  fill(!out.details.cuisine?.length && d.cuisine?.length, () => { out.details.cuisine = d.cuisine; }, 'cuisine');
  fill(!out.details.reservation && d.reservations != null, () => { out.details.reservation = d.reservations ? 'Reservations accepted' : 'No reservations'; }, 'reservations');
  fill(d.priceRange, () => { out.details.priceRange = d.priceRange; }, 'price range');
  fill(d.menuUrl, () => { out.details.menuUrl = d.menuUrl; }, 'menu');
  if (fields.length) out.enriched = { fields, url: enr.url, fetchedAt: enr.fetchedAt };
  return out;
}

// ---------------------------------------------------------------- background queue
/**
 * Reads websites in the background, politely: a few at a time, and never two at once on the same host.
 * `has(id)` says whether a recent result is already saved; `save(id, status, data, url)` stores one.
 */
export function createEnricher({ has, save, run = enrichWebsite, concurrency = 4, hostDelayMs = 1000, maxQueue = 150 }) {
  const queue = [], known = new Set(), hostFree = new Map();
  let running = 0, timer = null;
  // unref: a pending retry timer should never be the thing that keeps the process alive
  const schedule = (ms) => { if (!timer) { timer = setTimeout(() => { timer = null; pump(); }, ms); timer.unref?.(); } };

  function pump() {
    while (running < concurrency) {
      const now = Date.now();
      const i = queue.findIndex((t) => (hostFree.get(t.host) ?? 0) <= now);
      if (i < 0) break;
      const [task] = queue.splice(i, 1);
      running++; hostFree.set(task.host, Infinity);
      Promise.resolve().then(() => run(task.website))
        .then((r) => save(task.id, r.status, r.data, r.url), () => save(task.id, 'error', null, null))
        .catch(() => {})
        .finally(() => { running--; known.delete(task.id); hostFree.set(task.host, Date.now() + hostDelayMs); pump(); });
    }
    if (queue.length) schedule(Math.max(50, hostDelayMs / 4));
  }

  return {
    /** @param cafes in the order they should be read (nearest first). Returns how many were queued. */
    enqueue(cafes) {
      let added = 0;
      for (const c of cafes) {
        if (queue.length >= maxQueue) break;
        const website = normalizeWebsite(c.website);
        if (!website || known.has(c.id) || has(c.id)) continue;
        queue.push({ id: c.id, website, host: new URL(website).hostname });
        known.add(c.id); added++;
      }
      if (added) pump();
      return added;
    },
    pending: (ids) => ids.filter((id) => known.has(id)).length,
  };
}
