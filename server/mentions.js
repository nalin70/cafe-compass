import { normalizeWebsite } from './enrich.js';

// News, videos and reels that mention a cafe.
//  - Automatic news comes from GDELT (free, no key, last ~3 months). Automatic videos come from the YouTube Data API (optional key).
//  - Instagram has no official way to search by place, so reels come from links people paste in.
//  - We only keep a headline, source and date and always link out. Embeds are built by us from a validated ID, never from third-party HTML.
//  - Matching is deliberately strict: a story is shown only if it names the cafe AND its city (or the publisher is in the same country).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 24 * 3600e3;

// ---------------------------------------------------------------- names & matching
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['cafe', 'cafes', 'coffee', 'the', 'and', 'house', 'roasters', 'roastery', 'roasting', 'bakery', 'bar', 'co', 'company', 'kitchen', 'shop', 'restaurant', 'eatery', 'brew', 'brews', 'club', 'lounge', 'bistro', 'tea', 'cafeteria']);

/** The words that actually identify a cafe ("Blue Tokai Coffee Roasters" -> ["blue", "tokai"]). */
export function distinctiveTokens(name) {
  return norm(name).split(' ').filter((t) => t && !STOP.has(t));
}

/** Names like "Cafe", "The Coffee House" or a non-Latin name can't be matched reliably, so no automatic lookup. */
export function isGenericName(name) {
  const t = distinctiveTokens(name);
  return t.length === 0 || (t.length === 1 && t[0].length < 4);
}

const hasPhrase = (hay, phrase) => !!phrase && ` ${hay} `.includes(` ${phrase} `);
const slugOf = (url) => { try { return new URL(url).pathname; } catch { return ''; } };

/** Strict check for a news item: the cafe's name as a phrase in the headline/URL, plus the city or the same country. */
export function relevantNews(item, cafe, { city, cities = [], country } = {}) {
  const phrase = distinctiveTokens(cafe.name).join(' ');
  const hay = norm(`${item.title} ${slugOf(item.url)}`);
  if (!hasPhrase(hay, phrase)) return false;
  const cityMatch = [city, ...cities].some((p) => hasPhrase(hay, norm(p)));
  const countryMatch = !!country && !!item.country && norm(country) === norm(item.country);
  return cityMatch || countryMatch;
}

/** Strict check for a video: the name as a phrase in title/description/channel, and the city in title/description. */
export function relevantVideo(item, cafe, { city, cities = [] } = {}) {
  const phrase = distinctiveTokens(cafe.name).join(' ');
  if (!hasPhrase(norm(`${item.title} ${item.description} ${item.channel}`), phrase)) return false;
  const text = norm(`${item.title} ${item.description}`);
  return [city, ...cities].some((p) => hasPhrase(text, norm(p)));
}

/** Keep the relevant ones, drop duplicates (same URL, or same headline on the same site), cap the count. */
export function selectRelevant(items, test, limit) {
  const urls = new Set(), titles = new Set(), out = [];
  for (const it of items) {
    if (!test(it)) continue;
    const u = it.url.replace(/[?#].*$/, ''), t = `${it.domain ?? ''}|${norm(it.title)}`;
    if (urls.has(u) || titles.has(t)) continue;
    urls.add(u); titles.add(t); out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------- search links (always available)
export function searchLinks(name, city) {
  const q = encodeURIComponent(`"${name}"${city ? ` ${city}` : ''}`);
  return {
    news: `https://www.google.com/search?q=${q}&tbm=nws`,
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    instagram: `https://www.google.com/search?q=${encodeURIComponent(`site:instagram.com "${name}"${city ? ` ${city}` : ''}`)}`,
    web: `https://www.google.com/search?q=${q}`,
  };
}

// ---------------------------------------------------------------- pasted links
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtu.be']);
const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
export const YT_ID = /^[A-Za-z0-9_-]{11}$/;
export const IG_REF = /^(reel|p|tv)\/[A-Za-z0-9_-]{5,40}$/;

/**
 * Turn a pasted URL into { platform: 'youtube'|'instagram'|'article', ref } or throw an Error with a friendly message.
 * The host must match exactly (so instagram.com.evil.example is just an "article" link, and never gets embedded).
 */
export function parseMediaLink(input) {
  let u;
  try { u = new URL(String(input).trim()); } catch { throw new Error('That doesn’t look like a web link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only web links can be added.');
  if (u.username || u.password) throw new Error('Links with a username or password can’t be added.');
  const host = u.hostname.toLowerCase();

  if (YT_HOSTS.has(host)) {
    let id = null;
    if (host.endsWith('youtu.be')) id = u.pathname.split('/')[1];
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/(?:shorts|embed|live)\/([^/?#]+)/.exec(u.pathname)?.[1];
    if (!id || !YT_ID.test(id)) throw new Error('That YouTube link doesn’t point to a specific video.');
    return { platform: 'youtube', ref: id };
  }
  if (IG_HOSTS.has(host)) {
    const m = /^\/(?:[A-Za-z0-9._]+\/)?(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,40})\/?$/.exec(u.pathname);
    if (!m) throw new Error('Paste the link of a specific Instagram reel or post, not a profile.');
    return { platform: 'instagram', ref: `${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}` };
  }
  u.hash = '';
  const safe = normalizeWebsite(u.href); // public internet addresses only
  if (!safe || safe.length > 500) throw new Error('That link can’t be added.');
  return { platform: 'article', ref: safe };
}

/** Is this platform+ref pair well-formed? (used when restoring a backup) */
export function validRef(platform, ref) {
  if (typeof ref !== 'string') return false;
  if (platform === 'youtube') return YT_ID.test(ref);
  if (platform === 'instagram') return IG_REF.test(ref);
  if (platform === 'article') return ref.length <= 500 && normalizeWebsite(ref) !== null;
  return false;
}

/** URLs to show for a saved link. The embed URL is built here from the validated ID. */
export function linkView({ platform, ref }) {
  if (platform === 'youtube') return { url: `https://www.youtube.com/watch?v=${ref}`, embedUrl: `https://www.youtube-nocookie.com/embed/${ref}`, thumb: `https://i.ytimg.com/vi/${ref}/hqdefault.jpg` };
  if (platform === 'instagram') return { url: `https://www.instagram.com/${ref}/`, embedUrl: `https://www.instagram.com/${ref}/embed`, thumb: null };
  return { url: ref, embedUrl: null, thumb: null };
}

// ---------------------------------------------------------------- GDELT news (free, no key)
const GDELT = () => process.env.GDELT_URL || 'https://api.gdeltproject.org/api/v2/doc/doc';
const GAP_MS = () => +process.env.GDELT_GAP_MS || 5500; // GDELT asks for roughly one request per 5 seconds
const GDELT_TIMEOUT_MS = () => +process.env.GDELT_TIMEOUT_MS || 8000; // it is often slow; give up sooner than before
let gdeltChain = Promise.resolve(), gdeltWaiting = 0, gdeltLast = 0;

// Everyone shares one line: requests start at least GAP_MS apart, and at most 5 may be waiting.
function gdeltSlot() {
  if (gdeltWaiting >= 5) return Promise.reject(Object.assign(new Error('busy'), { code: 'busy' }));
  gdeltWaiting++;
  const run = gdeltChain.then(async () => {
    const wait = gdeltLast + GAP_MS() - Date.now();
    if (wait > 0) await sleep(wait);
    gdeltLast = Date.now();
  }).finally(() => { gdeltWaiting--; });
  gdeltChain = run.catch(() => {});
  return run;
}

const isoFromGdelt = (s) => { const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s)); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null; };
const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const httpUrl = (v) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href.slice(0, 500) : null; } catch { return null; } };

/** @returns {Promise<{title:string,url:string,domain:string,date:string|null,country:string}[]>}; throws {code:'busy'|'unavailable'} */
export async function fetchGdelt(name, city) {
  const clean = (s) => String(s ?? '').replace(/[()"]/g, ' ').replace(/\s+/g, ' ').trim();
  const c = clean(city);
  const query = `"${clean(name)}"${c ? ` ${c.includes(' ') ? `"${c}"` : c}` : ''}`;
  await gdeltSlot();
  const params = new URLSearchParams({ query, mode: 'artlist', format: 'json', maxrecords: '50', sort: 'datedesc', timespan: '3months' });
  let body;
  try {
    const r = await fetch(`${GDELT()}?${params}`, { headers: { 'User-Agent': 'cafe-finder/0.1 (personal project)' }, signal: AbortSignal.timeout(GDELT_TIMEOUT_MS()) });
    if (r.status === 429) throw Object.assign(new Error('GDELT is rate-limiting requests'), { code: 'rate_limited' });
    if (!r.ok) throw new Error(`GDELT returned ${r.status}`);
    body = (await r.text()).trim();
  } catch (e) { throw Object.assign(new Error(e.message), { code: e.code === 'rate_limited' ? 'rate_limited' : 'unavailable' }); }
  if (!body) return []; // an empty body means no matches
  if (!body.startsWith('{')) throw Object.assign(new Error('GDELT is rate-limiting or unavailable'), { code: 'unavailable' }); // it answers throttling with plain text
  let data;
  try { data = JSON.parse(body); } catch { throw Object.assign(new Error('GDELT sent unreadable data'), { code: 'unavailable' }); }
  return (Array.isArray(data.articles) ? data.articles : []).map((a) => {
    const url = httpUrl(a?.url), title = text(a?.title, 200);
    return url && title ? { title, url, domain: text(a.domain, 80), date: isoFromGdelt(a.seendate), country: text(a.sourcecountry, 60) } : null;
  }).filter(Boolean);
}

// ---------------------------------------------------------------- YouTube (optional key)
const YT_SEARCH = () => process.env.YOUTUBE_API_URL || 'https://www.googleapis.com/youtube/v3/search';
const YT_OEMBED = () => process.env.YOUTUBE_OEMBED_URL || 'https://www.youtube.com/oembed';

/** Search YouTube. The key goes in a header (never in a URL) and never reaches the browser. */
export async function fetchYouTube(name, city, key) {
  const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '12', q: `${name}${city ? ` ${city}` : ''}` });
  let r;
  try { r = await fetch(`${YT_SEARCH()}?${params}`, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) }); }
  catch (e) { throw Object.assign(new Error(e.message), { code: 'unavailable' }); }
  if (!r.ok) throw Object.assign(new Error(`YouTube returned ${r.status}`), { code: r.status === 403 ? 'quota' : 'unavailable' });
  const data = await r.json().catch(() => ({}));
  return (Array.isArray(data.items) ? data.items : []).map((it) => {
    const id = it?.id?.videoId, s = it?.snippet ?? {};
    return typeof id === 'string' && YT_ID.test(id) && text(s.title, 150)
      ? { id, title: text(s.title, 150), description: text(s.description, 300), channel: text(s.channelTitle, 80), date: typeof s.publishedAt === 'string' ? s.publishedAt.slice(0, 10) : null } : null;
  }).filter(Boolean);
}

/** The title of a YouTube video via the public oEmbed endpoint (no key). Best effort. */
export async function youtubeTitle(id) {
  try {
    const r = await fetch(`${YT_OEMBED()}?${new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' })}`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? text((await r.json()).title, 150) || null : null;
  } catch { return null; }
}

export const MENTION_TTL = { news: DAY, videos: 7 * DAY };
