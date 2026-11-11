const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LABELS = { wifi: 'Wi‑Fi', power: 'Power outlets', outdoor: 'Outdoor seating', pets: 'Pet‑friendly', vegan: 'Vegan / veg options', specialty: 'Specialty coffee', food: 'Food & bakery', quiet: 'Quiet', cozy: 'Cozy', aesthetic: 'Aesthetic', lively: 'Lively', laptop: 'Laptop‑friendly' };
const ICON = { wifi: '📶', power: '🔌', outdoor: '🌳', pets: '🐕', vegan: '🌱', specialty: '☕', food: '🥐', quiet: '🤫', cozy: '🛋️', aesthetic: '📸', lively: '🎉', laptop: '💻' };
// Taste groups for the "My taste" page. AI_ONLY features only get data from the optional vibe analysis.
const GROUPS = [['Work & study', ['wifi', 'power', 'laptop', 'quiet']], ['Vibe', ['cozy', 'aesthetic', 'lively']], ['Coffee & food', ['specialty', 'food', 'vegan']], ['Practical', ['outdoor', 'pets']]];
const AI_ONLY = new Set(['laptop', 'cozy', 'aesthetic', 'lively']);

// Quick filters (client-side). Only cafes whose info is mapped on OpenStreetMap can match.
const FILTERS = [
  { key: 'open', label: '🟢 Open now', test: (c) => c.status?.state === 'open' },
  { key: 'new', label: '✨ Not visited yet', test: (c) => !c.visited },
  { key: 'wifi', label: '📶 Wi‑Fi', test: (c) => c.features?.wifi },
  { key: 'power', label: '🔌 Outlets', test: (c) => c.features?.power },
  { key: 'outdoor', label: '🌳 Outdoor', test: (c) => c.features?.outdoor },
  { key: 'indoor', label: '🛋️ Indoor', test: (c) => c.details?.indoorSeating === true },
  { key: 'aircon', label: '❄️ Air con', test: (c) => c.details?.airConditioning === true },
  { key: 'pets', label: '🐕 Pets', test: (c) => c.features?.pets },
  { key: 'vegan', label: '🌱 Vegan', test: (c) => c.features?.vegan },
  { key: 'takeaway', label: '🥡 Takeaway', test: (c) => c.details?.takeaway === true },
  { key: 'access', label: '♿ Accessible', test: (c) => c.details?.wheelchair === 'Wheelchair accessible' },
];

let cafes = [], lastSearch = null, vibeEnabled = false, partial = false, reviewsEnabled = false;
const reviewsCache = new Map(); // cafe id -> reviews data (or { error }) for this page session
const mentionsCache = new Map(); // cafe id -> press & mentions data for this page session
const filters = new Set();
let sortBy = 'match', nameQuery = '', atValue = '', pickedId = null, savedFilter = 'all';
const compare = new Map(); // cafe id -> cafe snapshot, at most 3

// localStorage can be missing or blocked (private windows), so never let it break the page.
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

// Only allow http(s) links. OpenStreetMap tags are user-entered, so a "website" could be a javascript: URL.
// A bare "www.example.com" gets https:// added.
function safeUrl(u) {
  if (!u) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

const api = async (url, opts) => {
  const r = await fetch(url, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), { code: j.code });
  return j;
};

// ---------- small UI helpers ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 3000);
}

function setStatus(msg, kind = 'info', retry, retryLabel = 'Try again') {
  const el = $('#status');
  el.className = kind; el.textContent = '';
  if (kind === 'loading') { const s = document.createElement('span'); s.className = 'spinner'; el.append(s); }
  el.append(document.createTextNode(msg));
  if (retry) { const b = document.createElement('button'); b.className = 'link'; b.textContent = retryLabel; b.onclick = retry; el.append(b); }
  el.hidden = !msg;
}

const skeleton = () => Array.from({ length: 4 }, () => `<div class="card skeleton"><div class="row"><i style="width:54px;height:54px;border-radius:50%"></i><div style="flex:1"><i style="height:18px;width:60%"></i><i style="height:12px;width:80%;margin-top:10px"></i></div></div><i style="height:22px;width:70%;margin-top:16px"></i></div>`).join('');
const emptyHtml = (icon, title, text, button = '') => `<div class="empty"><div class="big">${icon}</div><h2>${esc(title)}</h2><p>${esc(text)}</p>${button}</div>`;
const fmtDist = (km) => (km == null ? '' : km < 1 ? `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m` : `${km.toFixed(1)} km`);

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== b.dataset.tab));
  if (b.dataset.tab === 'saved') loadSaved();
  if (b.dataset.tab === 'prefs') loadPrefs();
});

// Deep links: /#saved and /#prefs open those tabs directly.
const hashTab = document.querySelector(`.tabs button[data-tab="${location.hash.slice(1)}"]`);
if (hashTab) hashTab.click();

// ---------- search & location ----------
// "3 hours ago" style age for saved results
function ago(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 2) return 'a moment ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// While the server reads cafe websites in the background, check back every few seconds (for about a minute)
// and refresh the list when new details arrive. Never while you're typing in a box.
let enrichPending = 0, enrichPolls = 0, enrichTimer = null;
function scheduleEnrichPoll() {
  clearTimeout(enrichTimer);
  if (!enrichPending || enrichPolls >= 10) return;
  enrichTimer = setTimeout(() => {
    enrichPolls++;
    const a = document.activeElement;
    if (a && a.closest?.('#list') && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName)) return scheduleEnrichPoll();
    if (lastSearch) search(lastSearch, { silent: true, poll: true });
  }, 6000);
}

async function search(params, { silent = false, refresh = false, poll = false } = {}) {
  if (!poll) enrichPolls = 0;
  lastSearch = params;
  if (!silent) { pickedId = null; setStatus('Searching for cafes… the free OpenStreetMap server can take up to 30 seconds.', 'loading'); $('#toolbar').hidden = true; $('#list').innerHTML = skeleton(); }
  try {
    const data = await api('/api/search?' + new URLSearchParams({ ...params, radius: $('#radius').value, ...(atValue ? { at: atValue } : {}), ...(refresh ? { refresh: '1' } : {}) }));
    if (params.q) rememberQuery(params.q);
    cafes = data.cafes; vibeEnabled = data.vibeEnabled; partial = data.partial; reviewsEnabled = data.reviewsEnabled;
    const where = data.origin.label.split(',').slice(0, 2).join(',');
    const f = data.freshness || {};
    const partialNote = partial ? ' · the main OpenStreetMap server is busy, so this shows up to 40 cafes within about 3 km; try again later for your full range' : '';
    if (f.from === 'stale') {
      setStatus(`The free OpenStreetMap servers aren’t responding, so this shows saved results from ${ago(f.cachedAt)}${f.limited ? ', covering a smaller area than you asked for' : ''}. Cafes near ${where}.`, 'error', () => search(params, { refresh: true }));
    } else if (f.from === 'cache' && Date.now() - f.cachedAt > 10 * 60e3) {
      setStatus(`Cafes near ${where} · saved results from ${ago(f.cachedAt)}${partialNote} `, 'info', () => search(params, { refresh: true }), 'Refresh');
    } else setStatus(`Cafes near ${where}${partialNote}`, 'info');
    enrichPending = data.enrichment?.pending ?? 0;
    render();
    loadWeather(data.origin);
    scheduleEnrichPoll();
  } catch (e) {
    setStatus(e.message, 'error', () => search(params));
    if (!silent) { $('#list').innerHTML = ''; $('#toolbar').hidden = true; }
  }
}

$('#search').onsubmit = (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return useMyLocation();
  search({ q });
};

// Ask the browser for your location; if it's unavailable or denied, ask the user to type one.
function useMyLocation() {
  if (!navigator.geolocation) return askForLocation('Your browser can’t share your location.');
  setStatus('Finding your location… allow access when your browser asks.', 'loading');
  navigator.geolocation.getCurrentPosition(
    (p) => { $('#q').value = ''; search({ lat: p.coords.latitude, lon: p.coords.longitude }); },
    (err) => askForLocation(err.code === 1 ? 'Location access is blocked.' : 'Couldn’t get your location.'),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 });
}
// Recent typed searches, offered as suggestions in the location box.
function rememberQuery(q) {
  store.set('recentQ', [q, ...store.get('recentQ', []).filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 6));
  renderRecent();
}
function renderRecent() {
  $('#recent').innerHTML = store.get('recentQ', []).map((q) => `<option value="${esc(q)}">`).join('');
}

function askForLocation(why) {
  const last = store.get('recentQ', [])[0];
  if (last) { // fall back to where you last searched instead of leaving you on an empty page
    $('#q').value = last;
    search({ q: last }).then(() => toast(`${why} Showing your last search: ${last}`));
    return;
  }
  setStatus(`${why} Type your area, city or address above and press Search.`, 'info');
  $('#toolbar').hidden = true;
  $('#list').innerHTML = emptyHtml('📍', 'Where should we look?', 'Share your location or type an area, city or address.', '<button class="btn primary" id="shareLoc">Use my location</button>');
  $('#shareLoc').onclick = useMyLocation;
  $('#q').focus();
}
$('#locate').onclick = useMyLocation;
// Radius slider: the label follows the thumb; the search re-runs when you let go. The choice is remembered.
const radiusEl = $('#radius');
try { const saved = +localStorage.getItem('radiusKm'); if (saved >= 1 && saved <= 15) radiusEl.value = saved; } catch { /* storage unavailable */ }
const paintRadius = () => { $('#radiusVal').textContent = `${radiusEl.value} km`; };
paintRadius();
radiusEl.oninput = paintRadius;
radiusEl.onchange = () => {
  paintRadius();
  try { localStorage.setItem('radiusKm', radiusEl.value); } catch { /* ignore */ }
  if (lastSearch) search(lastSearch);
};

// ---------- card rendering ----------
const gmapsPlace = (c) => 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(c.address ? `${c.name}, ${c.address}` : `${c.name} ${c.lat},${c.lon}`);
const gmapsDirections = (c) => `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lon}`;
const slim = ({ id, name, lat, lon, address, hours, website, features, rating, ratingCount, price, photo, mapsUrl, details, osmUrl }) => ({ id, name, lat, lon, address, hours, website, features, rating, ratingCount, price, photo, mapsUrl, details, osmUrl });

function chipList(c) {
  const d = c.details || {};
  return [
    ...Object.keys(ICON).filter((f) => c.features?.[f]).map((f) => `${ICON[f]} ${f === 'wifi' && d.freeWifi ? 'Free Wi‑Fi' : LABELS[f]}`),
    d.takeaway === true && '🥡 Takeaway', d.delivery === true && '🛵 Delivery',
    d.toilets === true && '🚻 Toilets', d.airConditioning === true && '❄️ Air con', d.priceRange && `💰 ${d.priceRange}`,
    d.wheelchair === 'Wheelchair accessible' && '♿ Accessible',
    ...(d.diets || []).filter((x) => !/^Veg/.test(x)).map((x) => `🥗 ${x}`),
    ...(d.cuisine || []).slice(0, 3),
  ].filter(Boolean);
}

// Rough walking time (5 km/h with a 30% detour allowance); only useful for short distances.
const walkTime = (km) => (km != null && km <= 1.6 ? `🚶 ${Math.max(1, Math.round(km * 15.6))} min` : '');

function statusHtml(c) {
  const s = c.status;
  const fromSite = c.enriched?.fields?.includes('hours') ? ' title="Based on opening hours published on the cafe’s own website"' : '';
  return s && s.state !== 'unknown' && s.label ? `<div class="open ${s.state}${s.soon ? ' soon' : ''}"${fromSite}><i></i>${esc(s.label)}</div>` : '';
}

function moreHtml(c) {
  const d = c.details || {};
  const parts = [];
  if (c.hours) parts.push(`<div><h4>Opening hours${c.enriched?.fields?.includes('hours') ? ' <span class="muted">(from the cafe’s website)</span>' : ''}</h4><ul>${c.hours.split(';').map((h) => `<li>${esc(h.trim())}</li>`).join('')}</ul></div>`);
  const facts = [
    d.indoorSeating === true && 'Indoor seating', d.capacity && `Seats about ${d.capacity}`, d.reservation,
    d.wheelchair && d.wheelchair !== 'Wheelchair accessible' && d.wheelchair, d.smoking, d.brand && `Part of ${d.brand}`,
    d.diets?.length && `Dietary: ${d.diets.join(', ')}`,
  ].filter(Boolean);
  if (facts.length) parts.push(`<div><h4>Good to know</h4><ul>${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>`);
  if (d.payment?.length) parts.push(`<div><h4>Payment</h4><div>💳 ${esc(d.payment.join(', '))}</div></div>`);
  const contact = [
    d.email && `<a href="mailto:${esc(d.email)}">✉ ${esc(d.email)}</a>`,
    d.instagram && `<a href="https://instagram.com/${esc(d.instagram.replace(/^@|^.*instagram\.com\//g, '').replace(/\/$/, ''))}" target="_blank" rel="noopener">Instagram</a>`,
    c.osmUrl && `<a href="${esc(c.osmUrl)}" target="_blank" rel="noopener">View or fix on OpenStreetMap</a>`,
  ].filter(Boolean);
  if (contact.length) parts.push(`<div><h4>More</h4>${contact.join(' · ')}</div>`);
  if (d.description) parts.push(`<div>${esc(d.description)}</div>`);
  if (d.checked) parts.push(`<div class="muted">Details last checked on OpenStreetMap: ${esc(d.checked)}</div>`);
  if (c.enriched?.fields?.length) {
    const src = safeUrl(c.enriched.url);
    parts.push(`<div class="muted">Some details were read from the cafe’s own website (${esc(c.enriched.fields.join(', '))})${src ? ` · <a href="${esc(src)}" target="_blank" rel="noopener">source</a>` : ''}.</div>`);
  }
  parts.push(`<div><h4>My notes</h4><textarea data-notes maxlength="1000" placeholder="e.g. try the cardamom bun" aria-label="Your notes about ${esc(c.name)}">${esc(c.notes || '')}</textarea></div>`);
  return `<details class="more"><summary>Hours, notes &amp; more${c.notes ? ' · 📝' : ''}</summary><div class="more-body">${parts.join('')}</div></details>`;
}

function vibeHtml(c, mode) {
  if (c.vibe) {
    const v = c.vibe;
    return `<div class="vibe"><div>✨ ${esc(v.summary)}</div><div class="tags">${v.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>${v.caveats ? `<div class="muted">⚠ ${esc(v.caveats)}</div>` : ''}<div class="muted">AI summary of ${v.reviewCount} Google reviews · ${esc(v.confidence)} confidence</div></div>`;
  }
  return mode === 'results' && vibeEnabled && c.id.startsWith('g/') ? '<div class="links"><button class="btn small" data-vibe>✨ Analyze vibe</button></div>' : '';
}

const clip = (t, n) => (t.length > n ? t.slice(0, n).trimEnd() + '…' : t);

// ---------- press & mentions: news, videos, and reels/articles that hoppers paste in ----------
const fmtDate = (iso) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : ''; };
// Only these exact embed/thumbnail URLs are ever put into the page (the server builds them from validated IDs; this is a second check).
const EMBED_OK = [/^https:\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{11}$/, /^https:\/\/www\.instagram\.com\/(reel|p|tv)\/[\w-]{5,40}\/embed$/];
const embedOk = (u) => typeof u === 'string' && EMBED_OK.some((re) => re.test(u));
const thumbOk = (u) => typeof u === 'string' && /^https:\/\/i\.ytimg\.com\/vi\/[\w-]{11}\/hqdefault\.jpg$/.test(u);
const PLATFORM = { youtube: '▶ YouTube', instagram: '📷 Instagram', article: '🔗 Article' };

function playerHtml(item) { // a click-to-play placeholder; nothing from YouTube/Instagram loads until it is clicked
  if (!embedOk(item.embedUrl)) return '';
  return `<button class="mn-play" data-embed="${esc(item.embedUrl)}" aria-label="Play here">${thumbOk(item.thumb) ? `<img src="${esc(item.thumb)}" alt="" loading="lazy">` : ''}<span>▶ Play here</span></button>`;
}

function playEmbed(btn) {
  const src = btn.dataset.embed;
  if (!embedOk(src)) return;
  const f = document.createElement('iframe');
  f.src = src; f.className = 'mn-frame'; f.loading = 'lazy'; f.title = 'Embedded video or reel';
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-presentation');
  f.setAttribute('allow', 'encrypted-media; picture-in-picture; fullscreen');
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  btn.replaceWith(f);
}

function mentionsBlock(c) {
  const m = mentionsCache.get(c.id);
  if (!m) return '';
  const hide = (url) => `<button class="link" data-hide="${esc(url)}">Not about this cafe</button>`;
  const out = [];
  const sl = m.searchLinks || {};
  const find = [['📰 News', sl.news], ['▶ YouTube', sl.youtube], ['📷 Instagram', sl.instagram], ['🔎 Web', sl.web]]
    .map(([label, u]) => (safeUrl(u) ? `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${label}</a>` : '')).join('');
  out.push(`<div class="mn-find"><span class="muted">Search for this cafe:</span> ${find}</div>`);

  if (m.generic) out.push('<p class="muted">This cafe’s name is very common, so we can’t reliably match news or videos to it automatically. The search links above are your best bet.</p>');
  else if (m.newsStatus === 'no_location') out.push('<p class="muted">We couldn’t work out which city this cafe is in, so automatic matching is switched off.</p>');
  else {
    if (cafes.filter((x) => x.name === c.name).length > 1) out.push('<p class="muted">This name has several branches nearby, so results may be about other branches.</p>');
    out.push('<h4>In the news</h4>');
    if (m.newsStatus === 'ok') {
      out.push(m.news?.length
        ? `<ul class="mn-list">${m.news.map((n) => `<li class="mn-item"><a href="${esc(safeUrl(n.url) || '#')}" target="_blank" rel="noopener nofollow">${esc(n.title)}</a><div class="muted">${esc(n.domain)}${n.date ? ` · ${esc(fmtDate(n.date))}` : ''} · ${hide(n.url)}</div></li>`).join('')}</ul>`
        : '<p class="muted">No news about this cafe found in roughly the last 3 months.</p>');
    } else out.push(`<p class="muted">${m.newsStatus === 'busy' || m.newsStatus === 'slow' ? 'The free news service is slow, busy or rate-limiting requests right now. Try again in a minute; the search links above work in the meantime.' : 'The news service isn’t responding right now.'}</p>`);

    if (m.youtubeEnabled) {
      out.push('<h4>Videos</h4>');
      if (m.videosStatus === 'ok') {
        out.push(m.videos?.length
          ? `<ul class="mn-list">${m.videos.map((v) => `<li class="mn-item">${playerHtml(v)}<a href="${esc(safeUrl(v.url) || '#')}" target="_blank" rel="noopener nofollow">${esc(v.title)}</a><div class="muted">${esc(v.channel)}${v.date ? ` · ${esc(fmtDate(v.date))}` : ''} · ${hide(v.url)}</div></li>`).join('')}</ul>`
          : '<p class="muted">No matching videos found.</p>');
      } else out.push(`<p class="muted">${m.videosStatus === 'limit' ? 'The daily YouTube lookup limit has been reached.' : m.videosStatus === 'slow' ? 'YouTube is slow right now. Try again in a minute.' : 'YouTube isn’t responding right now.'}</p>`);
    }
  }

  out.push('<h4>Added by hoppers</h4>');
  out.push(m.links?.length
    ? `<ul class="mn-list">${m.links.map((l) => `<li class="mn-item">${playerHtml(l)}<a href="${esc(safeUrl(l.url) || '#')}" target="_blank" rel="noopener nofollow">${esc(l.title || (l.platform === 'instagram' ? 'Instagram reel or post' : l.platform === 'youtube' ? 'YouTube video' : l.url))}</a><div class="muted">${PLATFORM[l.platform] || ''} · <button class="link" data-rmlink="${l.id}">Remove</button></div></li>`).join('')}</ul>`
    : '<p class="muted">Nothing added yet. Seen a reel, video or article about this cafe? Paste its link:</p>');
  out.push('<form class="mn-add" data-addlink><input type="url" maxlength="600" required placeholder="Paste an Instagram reel, YouTube video or article link" aria-label="Link to add"><button class="btn small">Add</button></form>');
  out.push(`<p class="muted mn-credit">News headlines via <a href="https://www.gdeltproject.org/" target="_blank" rel="noopener">GDELT</a>${m.youtubeEnabled ? ' · videos via YouTube' : ''}. We only show headlines and link to the original.${m.youtubeEnabled ? '' : ' Add a YouTube API key to also find videos automatically (see README).'}</p>`);
  return `<div class="mentions">${out.join('')}</div>`;
}

// Google reviews panel: rating, the foods/drinks reviewers mention, and quoted snippets (with attribution).
function reviewsBlock(c) {
  const r = reviewsCache.get(c.id);
  if (!r) return '';
  if (r.error) return `<div class="reviews"><p class="muted">${esc(r.error)}</p></div>`;
  const head = r.rating != null ? `⭐ <b>${r.rating}</b> · ${r.ratingCount.toLocaleString()} reviews on Google` : 'Google reviews';
  const pop = r.popular?.length
    ? `<div class="popular"><h4>Mentioned in these reviews</h4><div class="tags">${r.popular.map((p) => `<span class="tag">${esc(p.item)} · ${p.mentions} of ${r.reviews.length}</span>`).join('')}</div></div>` : '';
  const quotes = r.reviews.map((v) => `<blockquote><p>“${esc(clip(v.text, 280))}”</p><cite>${v.rating ? '★'.repeat(Math.round(v.rating)) + ' · ' : ''}${v.authorUrl ? `<a href="${esc(v.authorUrl)}" target="_blank" rel="noopener">${esc(v.author)}</a>` : esc(v.author)}${v.when ? ' · ' + esc(v.when) : ''}</cite></blockquote>`).join('');
  return `<div class="reviews"><div class="rv-head">${head}${r.mapsUrl ? ` · <a href="${esc(r.mapsUrl)}" target="_blank" rel="noopener">All reviews on Google Maps</a>` : ''}</div>${pop}${quotes || '<p class="muted">No written reviews yet.</p>'}<p class="muted">Reviews are from Google users. Showing up to 5 of the most relevant.</p></div>`;
}

// Only mention reasons that come from the user's taste or ratings, not just proximity.
const why = (c) => (c.reasons || []).filter((r) => r !== 'Very close').join(' · ');

function cardHtml(c, mode = 'results') {
  const tier = c.score >= 70 ? 'hi' : c.score >= 45 ? 'mid' : 'lo';
  const lead = mode === 'saved'
    ? (c.userRating ? `<div class="rated" title="Your rating">★ ${c.userRating}</div>` : '')
    : `<div class="ring ${tier}" style="--p:${c.score}" title="${c.score}% match for your taste"><span>${c.score}<small>%</small></span></div>`;
  const photo = c.photo ? `<img class="photo" loading="lazy" alt="" src="/api/photo?name=${encodeURIComponent(c.photo).replace(/%2F/g, '/')}">` : '';
  const g = c.rating != null ? `<div class="rating-line">⭐ ${c.rating} (${(c.ratingCount ?? 0).toLocaleString()})${c.price ? ' · ' + c.price : ''}${c.openNow != null ? (c.openNow ? ' · <b>Open now</b>' : ' · Closed now') : ''}</div>` : '';
  const chips = chipList(c);
  const phone = c.details?.phone;
  const stars = [1, 2, 3, 4, 5].map((n) => `<button data-rate="${n}" class="${c.userRating >= n ? 'f' : ''}" aria-label="Rate ${n} out of 5">★</button>`).join('');
  const site = safeUrl(c.website);
  return `<article class="card${c.id === pickedId ? ' picked' : ''}" data-id="${esc(c.id)}" title="Open in Google Maps">${photo}
    <div class="card-main">${lead}
      <div class="info"><h3>${esc(c.name)}</h3>${statusHtml(c)}
        <div class="meta">${c.distanceKm != null ? `<span class="dist">${fmtDist(c.distanceKm)}</span>` : ''}${walkTime(c.distanceKm) ? `<span>${walkTime(c.distanceKm)}</span>` : ''}<span>${esc(c.address || 'Address not mapped')}</span></div>${g}</div></div>
    ${vibeHtml(c, mode)}
    ${chips.length ? `<div class="tags">${chips.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${mode === 'results' && why(c) ? `<div class="why">Match notes: ${esc(why(c))}</div>` : ''}
    <div class="links">
      ${phone ? `<a href="tel:${esc(phone.replace(/[^+\d]/g, ''))}">📞 Call</a>` : ''}
      ${site ? `<a href="${esc(site)}" target="_blank" rel="noopener">🌐 Website</a>` : ''}
      ${safeUrl(c.details?.menuUrl) ? `<a href="${esc(safeUrl(c.details.menuUrl))}" target="_blank" rel="noopener">📖 Menu</a>` : ''}
      <a href="${gmapsDirections(c)}" target="_blank" rel="noopener">🧭 Directions</a>
      ${reviewsCache.has(c.id) ? '' : `<button class="btn small" data-reviews>⭐ ${reviewsEnabled ? 'Show reviews' : 'Reviews (setup needed)'}</button>`}
      ${mentionsCache.has(c.id) ? '' : '<button class="btn small" data-mentions>📰 Press &amp; mentions</button>'}
    </div>
    ${reviewsBlock(c)}
    ${mentionsBlock(c)}
    ${moreHtml(c)}
    <div class="foot"><div class="foot-left">
        <button class="save ${c.saved ? 'on' : ''}" data-save aria-pressed="${!!c.saved}">${c.saved ? '❤ Want to go' : '♡ Want to go'}</button>
        <button class="been ${c.visited ? 'on' : ''}" data-been aria-pressed="${!!c.visited}">${c.visited ? '✓ Been here' : '＋ Been here'}</button>
        <button class="cmp ${compare.has(c.id) ? 'on' : ''}" data-compare aria-pressed="${compare.has(c.id)}">⚖ Compare</button></div>
      <div class="stars"><span>${c.userRating ? 'Your rating' : 'Rate it'}</span>${stars}</div></div>
  </article>`;
}

// ---------- vibe analysis (optional; only active when API keys are configured) ----------
async function analyze(c) {
  try { await api('/api/vibe', { method: 'POST', body: { id: c.id } }); return null; } catch (e) { return e.message; }
}
async function analyzeTop(n = 8) {
  const todo = cafes.filter((c) => !c.vibe && c.id.startsWith('g/')).slice(0, n);
  if (!todo.length) return;
  let done = 0, failed = 0, lastErr = '';
  const queue = [...todo];
  const worker = async () => {
    for (let c; (c = queue.shift()); ) {
      const err = await analyze(c);
      if (err) { failed++; lastErr = err; }
      setStatus(`Analyzing vibes… ${++done}/${todo.length}`, 'loading');
    }
  };
  await Promise.all([worker(), worker()]);
  await search(lastSearch, { silent: true });
  if (failed) toast(`${failed} failed: ${lastErr}`);
}

// ---------- interactions ----------
function bindCards(root, list, mode) {
  root.querySelectorAll('.card[data-id]').forEach((el) => {
    const c = list.find((x) => x.id === el.dataset.id);
    if (!c) return;
    // Clicking the card itself opens it in Google Maps; buttons, links and the details panel don't.
    el.onclick = (e) => { if (!e.target.closest('a, button, input, textarea, details, form, iframe, .mentions, .reviews')) window.open(gmapsPlace(c), '_blank', 'noopener'); };
    const rerender = () => (mode === 'saved' ? loadSaved() : render());

    const mb = $('[data-mentions]', el);
    if (mb) mb.onclick = async () => {
      mb.disabled = true; mb.textContent = 'Looking…';
      try {
        mentionsCache.set(c.id, await api('/api/mentions?' + new URLSearchParams({ id: c.id, name: c.name, lat: c.lat, lon: c.lon })));
      } catch (e) { mb.disabled = false; mb.innerHTML = '📰 Press &amp; mentions'; return toast(e.message); }
      rerender();
    };
    el.querySelectorAll('[data-embed]').forEach((b) => b.onclick = () => playEmbed(b));
    el.querySelectorAll('[data-hide]').forEach((b) => b.onclick = async () => {
      const url = b.dataset.hide;
      try {
        await api('/api/mentions/hide', { method: 'POST', body: { cafeId: c.id, url } });
        const m = mentionsCache.get(c.id);
        if (m) { m.news = m.news?.filter((i) => i.url !== url) ?? null; m.videos = m.videos?.filter((i) => i.url !== url) ?? null; }
        toast('Hidden. Thanks for flagging it.');
        rerender();
      } catch (e) { toast(e.message); }
    });
    el.querySelectorAll('[data-rmlink]').forEach((b) => b.onclick = async () => {
      try {
        await api(`/api/links/${encodeURIComponent(b.dataset.rmlink)}`, { method: 'DELETE' });
        const m = mentionsCache.get(c.id);
        if (m) m.links = m.links.filter((l) => String(l.id) !== b.dataset.rmlink);
        rerender();
      } catch (e) { toast(e.message); }
    });
    const form = $('form[data-addlink]', el);
    if (form) form.onsubmit = async (e) => {
      e.preventDefault();
      const url = $('input', form).value.trim(), btn = $('button', form);
      if (!url) return;
      btn.disabled = true;
      try {
        const r = await api('/api/links', { method: 'POST', body: { cafeId: c.id, url } });
        const m = mentionsCache.get(c.id);
        if (m && !m.links.some((l) => l.id === r.link.id)) m.links.push(r.link);
        toast(r.duplicate ? 'That link was already added.' : 'Link added.');
        rerender();
      } catch (err) { btn.disabled = false; toast(err.message); }
    };

    const vb = $('[data-vibe]', el);
    if (vb) vb.onclick = async () => {
      vb.disabled = true; vb.textContent = 'Analyzing…';
      const err = await analyze(c);
      if (err) { vb.disabled = false; vb.textContent = '✨ Analyze vibe'; toast(err); } else search(lastSearch, { silent: true });
    };

    const rb = $('[data-reviews]', el);
    if (rb) rb.onclick = async () => {
      rb.disabled = true; rb.textContent = 'Loading reviews…';
      try {
        reviewsCache.set(c.id, await api('/api/reviews', { method: 'POST', body: { id: c.id, name: c.name, lat: c.lat, lon: c.lon } }));
      } catch (e) {
        if (e.code === 'no_key') reviewsCache.set(c.id, { error: 'To see reviews, add a Google Places API key. Setup steps are in README.md.' });
        else { rb.disabled = false; rb.textContent = '⭐ Show reviews'; return toast(e.message); } // transient: leave the button so you can retry
      }
      mode === 'saved' ? loadSaved() : render();
    };

    $('[data-save]', el).onclick = async () => {
      const was = c.saved; c.saved = !was;
      try {
        await api('/api/cafes', { method: 'POST', body: { cafe: slim(c), saved: c.saved } });
        toast(c.saved ? 'Added to “Want to go”' : 'Removed from “Want to go”');
        mode === 'saved' ? loadSaved() : render();
      } catch (e) { c.saved = was; toast(e.message); }
    };

    $('[data-been]', el).onclick = async () => {
      const was = c.visited; c.visited = !was;
      try {
        await api('/api/cafes', { method: 'POST', body: { cafe: slim(c), visited: c.visited } });
        toast(c.visited ? 'Marked as visited. Rate it to improve your picks.' : 'Removed from visited');
        mode === 'saved' ? loadSaved() : render();
      } catch (e) { c.visited = was; toast(e.message); }
    };

    $('[data-compare]', el).onclick = (e) => toggleCompare(c, e.currentTarget);

    const nt = $('[data-notes]', el); // saved when you click away from the box
    if (nt) nt.onchange = async () => {
      const was = c.notes; c.notes = nt.value.trim();
      try {
        await api('/api/cafes', { method: 'POST', body: { cafe: slim(c), notes: c.notes } });
        toast(c.notes ? 'Note saved' : 'Note removed');
      } catch (e) { c.notes = was; toast(e.message); }
    };

    el.querySelectorAll('[data-rate]').forEach((b) => b.onclick = async () => {
      const was = c.userRating; c.userRating = +b.dataset.rate;
      try {
        await api('/api/cafes', { method: 'POST', body: { cafe: slim(c), rating: c.userRating } });
        toast('Thanks! Your taste profile is updated.');
        mode === 'saved' ? loadSaved() : search(lastSearch, { silent: true }); // re-rank with the newly learned taste
      } catch (e) { c.userRating = was; toast(e.message); }
    });
  });
}

// ---------- results view ----------
function visibleCafes() {
  const active = FILTERS.filter((f) => filters.has(f.key));
  const list = cafes.filter((c) => active.every((f) => f.test(c)) && (!nameQuery || c.name.toLowerCase().includes(nameQuery)));
  return sortBy === 'distance' ? [...list].sort((a, b) => a.distanceKm - b.distanceKm) : list; // server already sorts by match
}

const fmtAt = (v) => new Date(v).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// Only the chips and the "open at" note are redrawn; the name box, sort menu and time picker are static,
// so typing in them never loses focus.
function renderToolbar() {
  $('#toolbar').hidden = !cafes.length;
  if (!cafes.length) return;
  const canTop = vibeEnabled && cafes.some((c) => !c.vibe && c.id.startsWith('g/'));
  const chips = $('#chips');
  chips.innerHTML = FILTERS.map((f) => `<button class="chip ${filters.has(f.key) ? 'on' : ''}" data-f="${f.key}" aria-pressed="${filters.has(f.key)}">${f.key === 'open' && atValue ? '🟢 Open then' : f.label}</button>`).join('') + (canTop ? '<button class="chip" id="analyzeTop">✨ Analyze top 8 vibes</button>' : '');
  chips.querySelectorAll('[data-f]').forEach((b) => b.onclick = () => { filters.has(b.dataset.f) ? filters.delete(b.dataset.f) : filters.add(b.dataset.f); render(); });
  const at = $('#analyzeTop', chips);
  if (at) at.onclick = () => { at.disabled = true; analyzeTop(8); };
  $('#atNow').hidden = !atValue;
  $('#atNote').textContent = atValue ? `Open/closed shown for ${fmtAt(atValue)}, local time at the cafes.` : '';
}

$('#sort').onchange = (e) => { sortBy = e.target.value; render(); };
$('#nameFilter').oninput = (e) => { nameQuery = e.target.value.trim().toLowerCase(); render(); };
$('#atTime').onchange = (e) => {
  atValue = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(e.target.value) ? e.target.value : '';
  if (lastSearch) search(lastSearch, { silent: true });
};
$('#atNow').onclick = () => { atValue = ''; $('#atTime').value = ''; if (lastSearch) search(lastSearch, { silent: true }); };

// "Pick one for me": a random choice among the best few cafes that aren't closed and you haven't been to yet.
$('#pick').onclick = () => {
  const top = visibleCafes().filter((c) => c.status?.state !== 'closed' && !c.visited).slice(0, 5);
  if (!top.length) return toast('Nothing open and new matches right now. Try clearing the filters.');
  const c = top[Math.floor(Math.random() * top.length)];
  pickedId = c.id;
  render();
  document.querySelector(`.card[data-id="${CSS.escape(c.id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast(`How about ${c.name}?`);
};

// ---------- weather tip (free Open-Meteo data via our server) ----------
let weather = null, weatherKey = '', weatherAt = 0;
const WX_BUTTON = { outdoor: 'outdoor seating', indoor: 'indoor seating', aircon: 'air-conditioned cafes' };

async function loadWeather({ lat, lon }) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (key === weatherKey && weather && Date.now() - weatherAt < 15 * 60e3) return renderWeather();
  weatherKey = key; weather = null;
  try {
    const r = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
    if (r.status === 200) { weather = await r.json(); weatherAt = Date.now(); }
  } catch { /* weather is optional */ }
  renderWeather();
}

function renderWeather() {
  const el = $('#weather');
  if (!weather || atValue) { el.hidden = true; return; } // the forecast is for now, so hide it when you've picked another time
  const tip = weather.tip, on = tip && filters.has(tip.kind);
  el.hidden = false;
  el.innerHTML = `<div class="wx-main"><span class="wx-icon">${weather.icon}</span><b>${weather.temp}°</b><span class="muted">feels like ${weather.feelsLike}° · ${esc(weather.text)}</span></div>${tip ? `<div class="wx-tip">${esc(tip.message)} <button class="btn small" data-wx="${tip.kind}">${on ? 'Clear filter' : `Show ${WX_BUTTON[tip.kind]}`}</button></div>` : ''}<div class="wx-credit">Weather by <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo.com</a></div>`;
  $('[data-wx]', el)?.addEventListener('click', (e) => {
    const kind = e.currentTarget.dataset.wx;
    filters.has(kind) ? filters.delete(kind) : filters.add(kind);
    render();
  });
}

// ---------- compare ----------
function toggleCompare(c, btn) {
  if (compare.has(c.id)) compare.delete(c.id);
  else if (compare.size >= 3) return toast('You can compare up to 3 cafes. Remove one first.');
  else compare.set(c.id, c);
  btn.classList.toggle('on', compare.has(c.id));
  btn.setAttribute('aria-pressed', compare.has(c.id));
  updateCompareBar();
}

function updateCompareBar() {
  $('#comparebar').hidden = compare.size === 0;
  $('#cmpCount').textContent = `${compare.size} selected${compare.size < 2 ? ' · pick at least 2' : ''}`;
  $('#cmpOpen').disabled = compare.size < 2;
}

const mark = (v) => (v === true ? '✓' : '—');
function compareHtml(list) {
  const feat = (f) => (c) => mark(!!c.features?.[f]);
  const detail = (f, want = true) => (c) => mark(c.details?.[f] === want);
  const link = (u, label) => { const s = safeUrl(u); return s ? `<a href="${esc(s)}" target="_blank" rel="noopener">${label}</a>` : '—'; };
  const rows = [
    ['Match', (c) => (c.score != null ? `${c.score}%` : '—')],
    ['Distance', (c) => (c.distanceKm != null ? `${fmtDist(c.distanceKm)}${walkTime(c.distanceKm) ? ` · ${walkTime(c.distanceKm)}` : ''}` : '—')],
    ['Open', (c) => esc(c.status?.label || 'Unknown')],
    ['Hours', (c) => (c.hours ? c.hours.split(';').map((h) => esc(h.trim())).join('<br>') : '—')],
    ['Your rating', (c) => (c.userRating ? '★'.repeat(c.userRating) : '—')],
    ['Wi‑Fi', feat('wifi')], ['Power outlets', feat('power')], ['Outdoor seating', feat('outdoor')],
    ['Pet‑friendly', feat('pets')], ['Vegan options', feat('vegan')], ['Quiet', feat('quiet')],
    ['Takeaway', detail('takeaway')], ['Toilets', detail('toilets')], ['Air con', detail('airConditioning')],
    ['Accessible', (c) => mark(c.details?.wheelchair === 'Wheelchair accessible')],
    ['Price range', (c) => (c.details?.priceRange ? esc(c.details.priceRange) : '—')],
    ['Phone', (c) => (c.details?.phone ? esc(c.details.phone) : '—')],
    ['Website', (c) => link(c.website, 'Open')],
    ['Directions', (c) => `<a href="${gmapsDirections(c)}" target="_blank" rel="noopener">Open</a>`],
  ];
  return `<table class="cmp-table"><thead><tr><th></th>${list.map((c) => `<th>${esc(c.name)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([label, fn]) => `<tr><th scope="row">${label}</th>${list.map((c) => `<td>${fn(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>
    <p class="muted">“—” means it isn’t mapped on OpenStreetMap, which isn’t necessarily a “no”.</p>`;
}

$('#cmpOpen').onclick = () => { $('#cmpBody').innerHTML = compareHtml([...compare.values()]); $('#cmpDialog').showModal(); };
$('#cmpClose').onclick = () => $('#cmpDialog').close();
$('#cmpDialog').onclick = (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }; // click on the backdrop
$('#cmpClear').onclick = () => { compare.clear(); updateCompareBar(); render(); if (!$('#saved').hidden) loadSaved(); };

function render() {
  renderToolbar();
  renderWeather();
  updateCompareBar();
  const el = $('#list');
  if (!cafes.length) { el.innerHTML = emptyHtml('🔍', 'No cafes found', 'Try a bigger radius or a different location.'); return; }
  const list = visibleCafes();
  if (!list.length) {
    el.innerHTML = emptyHtml('🧐', 'No cafes match those filters', 'OpenStreetMap volunteers haven’t mapped every detail, so some cafes can be missing from filtered results.', '<button class="btn" id="clearFilters">Clear filters</button>');
    $('#clearFilters').onclick = () => { filters.clear(); nameQuery = ''; $('#nameFilter').value = ''; render(); };
    return;
  }
  // keep the details panels you had open when the list is redrawn (filters, background updates)
  const open = new Set([...el.querySelectorAll('details.more[open]')].map((d) => d.closest('.card')?.dataset.id));
  el.innerHTML = `<p class="count">Showing ${list.length}${list.length < cafes.length ? ` of ${cafes.length}` : ''} cafes · tap a cafe to open it in Google Maps${enrichPending ? ` · 🔎 reading ${enrichPending} cafe website${enrichPending === 1 ? '' : 's'} for more details…` : ''}</p>` + list.map((c) => cardHtml(c)).join('');
  el.querySelectorAll('.card').forEach((card) => { if (open.has(card.dataset.id)) card.querySelector('details.more')?.setAttribute('open', ''); });
  bindCards(el, list, 'results');
}

// ---------- saved ----------
async function loadSaved() {
  const el = $('#savedList');
  try {
    const { cafes: all } = await api('/api/saved');
    if (!all.length) { el.innerHTML = emptyHtml('♡', 'Your list is empty', 'Tap “Want to go” or “Been here”, rate a cafe, or write a note, and it will show up here.'); return; }
    const tests = { all: () => true, want: (c) => c.saved, been: (c) => c.visited };
    const list = all.filter(tests[savedFilter]);
    const chips = [['all', 'All'], ['want', '❤ Want to go'], ['been', '✓ Been here']]
      .map(([k, label]) => `<button class="chip ${savedFilter === k ? 'on' : ''}" data-sf="${k}">${label} (${all.filter(tests[k]).length})</button>`).join('');
    el.innerHTML = `<div class="chips saved-chips">${chips}</div>` +
      (list.length ? list.map((c) => cardHtml(c, 'saved')).join('') : emptyHtml('🗂', 'Nothing here yet', 'Try another filter.'));
    el.querySelectorAll('[data-sf]').forEach((b) => b.onclick = () => { savedFilter = b.dataset.sf; loadSaved(); });
    bindCards(el, list, 'saved');
  } catch (e) { el.innerHTML = emptyHtml('⚠', 'Couldn’t load your saved cafes', e.message); }
}

// ---------- backup & export ----------
const syncExportLinks = () => {
  const list = $('#exportList').value;
  $('#exportKml').href = `/api/export?format=kml&list=${list}`;
  $('#exportCsv').href = `/api/export?format=csv&list=${list}`;
};
$('#exportList').onchange = syncExportLinks;

$('#importFile').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // so choosing the same file again still fires
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return toast('That file is too big to be a Cafe Finder backup.');
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That file isn’t valid JSON.'); }
  try {
    const r = await api('/api/import', { method: 'POST', body: data });
    toast(`Restored ${r.imported} ${r.imported === 1 ? 'cafe' : 'cafes'}${r.skipped ? ` (${r.skipped} skipped)` : ''}${r.weightsRestored ? ' and your taste settings' : ''}.`);
    loadSaved();
    if (lastSearch) search(lastSearch, { silent: true });
  } catch (err) { toast(err.message); }
};

// ---------- my taste ----------
function weightLabel(v) {
  if (v <= -3) return 'Avoid';
  if (v < 0) return 'Prefer not';
  if (v === 0) return 'No preference';
  if (v < 3) return 'Nice to have';
  if (v < 5) return 'Important';
  return 'Must‑have';
}

async function loadPrefs() {
  const el = $('#prefs');
  try {
    const { weights, vibeEnabled: ve } = await api('/api/prefs');
    const groups = GROUPS.map(([title, feats]) => [title, feats.filter((f) => ve || !AI_ONLY.has(f))]).filter(([, feats]) => feats.length);
    el.innerHTML = `<p class="prefs-intro">Tell us what matters to you. Cafes are ranked by how well they match, and every cafe you rate nudges these automatically.</p>` +
      groups.map(([title, feats]) => `<div class="group"><h2>${esc(title)}</h2>${feats.map((f) => `<div class="slider">
        <label for="w-${f}">${ICON[f]} ${LABELS[f]}</label>
        <input id="w-${f}" type="range" min="-5" max="5" step="0.5" value="${weights[f] ?? 0}" data-f="${f}">
        <output data-out="${f}"></output></div>`).join('')}</div>`).join('') +
      '<div class="prefs-actions"><button class="btn primary" id="savePrefs">Save my taste</button></div>';
    const paint = (i) => { const o = $(`[data-out="${i.dataset.f}"]`, el), v = +i.value; o.textContent = weightLabel(v); o.className = v > 0 ? 'pos' : v < 0 ? 'neg' : ''; };
    el.querySelectorAll('input[type=range]').forEach((i) => { paint(i); i.oninput = () => paint(i); });
    $('#savePrefs').onclick = async () => {
      const w = { ...weights }; // keep weights for features hidden on this page
      el.querySelectorAll('input[type=range]').forEach((i) => (w[i.dataset.f] = +i.value));
      try {
        await api('/api/prefs', { method: 'PUT', body: { weights: w } });
        toast('Taste saved. Your cafes are re-ranked.');
        if (lastSearch) search(lastSearch, { silent: true });
      } catch (e) { toast(e.message); }
    };
  } catch (e) { el.innerHTML = emptyHtml('⚠', 'Couldn’t load your preferences', e.message); }
}

// On first load: a ?q=place link searches that place; otherwise use the browser's location.
renderRecent();
const initialQ = new URLSearchParams(location.search).get('q');
if (initialQ) { $('#q').value = initialQ; search({ q: initialQ }); } else useMyLocation();
