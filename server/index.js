import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { geocode, reverseGeocode, findCafes, findCafesGoogle, mergeOsm, googleEnabled, fetchPhoto, fetchPlaceReviews, findGooglePlaceId, fetchGoogleReviews } from './sources.js';
import { scoreCafe, learnWeights, FEATURES } from './scoring.js';
import { getWeights, setWeights, userState, upsertCafe, savedCafes, getVibe, setVibe, allVibes, getPlaceId, setPlaceId, searchCache, importRows, saveEnrichment, hasFreshEnrichment, enrichmentMap,
  getMentionsCache, putMentionsCache, linksFor, allLinks, addLink, deleteLink, hideMention, hiddenFor, allHidden } from './db.js';
import { sanitizeCafe, buildBackup, parseBackup, toCsv, toKml, isCafeId } from './backup.js';
import { isGenericName, relevantNews, relevantVideo, selectRelevant, searchLinks, parseMediaLink, linkView, fetchGdelt, fetchYouTube, youtubeTitle, MENTION_TTL } from './mentions.js';
import { fetchWeather } from './weather.js';
import { createEnricher, applyEnrichment, fetchPageTitle } from './enrich.js';

// Fill gaps (hours, phone, price range, menu...) by reading each cafe's own website in the background.
const enrichEnabled = process.env.ENRICH_WEBSITES !== 'false';
const enricher = createEnricher({ has: hasFreshEnrichment, save: saveEnrichment });
import { popularItems } from './reviews.js';
import { analyzeVibe, vibeFeatures, llmEnabled } from './vibe.js';
import { openStatus, parseWall } from './hours.js';

// Searching with Google (20 results, ratings, photos) costs money per search, so it's opt-in.
// By default the list comes from free OpenStreetMap and the Google key is used only for on-demand reviews.
const googleSearchEnabled = () => googleEnabled() && process.env.GOOGLE_FULL_SEARCH === 'true';

// Open/closed right now, from OSM opening_hours (judged in the cafe's own timezone); Google's flag as a fallback.
const statusOf = (c, atWall = null) => {
  const s = openStatus(c.hours, c, new Date(), atWall);
  if (s.state === 'unknown' && !atWall && c.openNow != null) return { state: c.openNow ? 'open' : 'closed', label: c.openNow ? 'Open now' : 'Closed now' };
  return s;
};

const app = express();
// Backups can be large; every other route only needs small bodies.
// Browser security policy: only this site's own scripts, and only YouTube/Instagram may be framed (for click-to-play embeds).
app.use((_req, res, next) => {
  res.set('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: https://i.ytimg.com",
    "frame-src https://www.youtube-nocookie.com https://www.instagram.com", "connect-src 'self'", "object-src 'none'",
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});
app.use('/api/import', express.json({ limit: '10mb' }));
app.use(express.json());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => res.status(502).json({ error: e.message }));

app.get('/api/search', wrap(async (req, res) => {
  const radiusKm = Math.min(Math.max(+req.query.radius || 2, 1), 15);
  const origin = req.query.lat && req.query.lon
    ? { lat: +req.query.lat, lon: +req.query.lon, label: 'Your location' }
    : await geocode(String(req.query.q || ''));
  const weights = getWeights(), state = userState(), vibes = allVibes(), websiteData = enrichmentMap();
  const refresh = req.query.refresh === '1'; // bypass the saved-search cache
  const atWall = parseWall(String(req.query.at || '')); // optional: check opening hours at a chosen local time
  let found, partial = false, freshness = { from: 'live', cachedAt: Date.now(), limited: false };
  if (googleSearchEnabled()) {
    const osm = await findCafes(origin, radiusKm * 1000, { cache: searchCache, refresh }).then((r) => r.cafes).catch(() => []); // best effort: adds wifi/outlet data
    found = mergeOsm(await findCafesGoogle(origin, radiusKm * 1000), osm);
  } else {
    const r = await findCafes(origin, radiusKm * 1000, { cache: searchCache, refresh });
    ({ cafes: found, partial } = r);
    freshness = { from: r.from, cachedAt: r.cachedAt, limited: r.limited };
  }
  const cafes = found.map((raw) => {
    const s = state[raw.id], vibe = vibes[raw.id] ?? null;
    // Vibe-derived features only ever add to what OSM/Google already know.
    const vf = vibeFeatures(vibe), features = { ...raw.features };
    for (const [k, v] of Object.entries(vf)) features[k] = features[k] || v;
    const c = { ...applyEnrichment(raw, websiteData.get(raw.id)), features };
    return { ...c, ...scoreCafe(c, weights, origin, radiusKm, s?.rating ?? null), saved: !!s?.saved, userRating: s?.rating ?? null, notes: s?.notes ?? '', visited: !!s?.visited, vibe, status: statusOf(c, atWall) };
  }).sort((a, b) => b.score - a.score);
  // Queue website reading for cafes we haven't read yet, nearest first; the page re-checks while some are still pending.
  if (enrichEnabled) enricher.enqueue([...cafes].sort((a, b) => a.distanceKm - b.distanceKm));
  const enrichment = { pending: enrichEnabled ? enricher.pending(cafes.map((c) => c.id)) : 0 };
  res.json({ origin, cafes, partial, freshness, enrichment, source: googleSearchEnabled() ? 'google' : 'osm', reviewsEnabled: googleEnabled(), vibeEnabled: googleEnabled() && llmEnabled() });
}));

// Proxy Google photos so the API key never reaches the browser.
app.get('/api/photo', wrap(async (req, res) => {
  const name = String(req.query.name || '');
  if (!googleEnabled() || !/^places\/[\w-]+\/photos\/[\w-]+$/.test(name)) return res.status(400).json({ error: 'bad photo' });
  const { type, body } = await fetchPhoto(name);
  res.set({ 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' }).send(body);
}));

// Analyze a cafe's vibe from its Google reviews with Claude. Cached, because it costs money.
app.post('/api/vibe', wrap(async (req, res) => {
  const id = String(req.body?.id || '');
  if (!/^g\/[\w-]+$/.test(id)) return res.status(400).json({ error: 'Vibe analysis needs a Google Places cafe.' });
  if (!googleEnabled() || !llmEnabled()) return res.status(400).json({ error: 'Set both GOOGLE_PLACES_API_KEY and ANTHROPIC_API_KEY.' });
  const cached = getVibe(id);
  if (cached && !req.body.refresh) return res.json({ vibe: cached, features: vibeFeatures(cached) });
  const place = await fetchPlaceReviews(id.slice(2));
  if (!place.reviews.length) return res.status(422).json({ error: 'No written reviews available for this cafe.' });
  const vibe = await analyzeVibe(place);
  setVibe(id, vibe);
  res.json({ vibe, features: vibeFeatures(vibe) });
}));

// Reviews for one cafe, fetched only when the user asks. Review text is never stored; only the Google place id is.
const DAILY_LIMIT = +process.env.REVIEWS_DAILY_LIMIT || 100;
let usage = { day: '', count: 0 };
app.post('/api/reviews', wrap(async (req, res) => {
  const { id, name, lat, lon } = req.body || {};
  if (typeof id !== 'string' || id.length > 60 || typeof name !== 'string' || !name || name.length > 200 || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return res.status(400).json({ error: 'Invalid cafe.' });
  }
  if (!googleEnabled()) return res.status(400).json({ code: 'no_key', error: 'Reviews need a Google Places API key. See README.md.' });

  const today = new Date().toISOString().slice(0, 10);
  if (usage.day !== today) usage = { day: today, count: 0 };
  if (usage.count >= DAILY_LIMIT) return res.status(429).json({ error: `Daily limit of ${DAILY_LIMIT} review lookups reached. Raise REVIEWS_DAILY_LIMIT in .env if you want more.` });
  usage.count++;

  let placeId = /^g\/[\w-]+$/.test(id) ? id.slice(2) : getPlaceId(id);
  if (!placeId) {
    placeId = await findGooglePlaceId({ name, lat, lon });
    if (!placeId) return res.status(404).json({ error: 'Couldn’t find this cafe on Google.' });
    setPlaceId(id, placeId);
  }
  const data = await fetchGoogleReviews(placeId);
  res.json({ ...data, popular: popularItems(data.reviews) });
}));

// ---- press & mentions: news (GDELT), videos (YouTube, optional key), and links people paste onto a cafe ----
const YT_DAILY_LIMIT = +process.env.YOUTUBE_DAILY_LIMIT || 30;
let ytUsage = { day: '', count: 0 };
const linkJson = (l) => ({ id: l.id, platform: l.platform, title: l.title, ...linkView(l) });

async function loadNews(cafe, geo) {
  const cached = getMentionsCache(cafe.id, 'news', MENTION_TTL.news);
  if (cached) return { status: 'ok', items: cached };
  try {
    const items = selectRelevant(await fetchGdelt(cafe.name, geo.city), (it) => relevantNews(it, cafe, geo), 5);
    putMentionsCache(cafe.id, 'news', items);
    return { status: 'ok', items };
  } catch (e) { return { status: e.code === 'busy' || e.code === 'rate_limited' ? 'busy' : 'unavailable', items: null }; }
}

async function loadVideos(cafe, geo) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { status: 'no_key', items: null };
  const cached = getMentionsCache(cafe.id, 'videos', MENTION_TTL.videos);
  if (cached) return { status: 'ok', items: cached };
  const today = new Date().toISOString().slice(0, 10);
  if (ytUsage.day !== today) ytUsage = { day: today, count: 0 };
  if (ytUsage.count >= YT_DAILY_LIMIT) return { status: 'limit', items: null };
  ytUsage.count++;
  try {
    const found = (await fetchYouTube(cafe.name, geo.city, key)).map((v) => ({ ...v, url: `https://www.youtube.com/watch?v=${v.id}` }));
    const items = selectRelevant(found, (v) => relevantVideo(v, cafe, geo), 4)
      .map(({ id, title, channel, date }) => ({ id, title, channel, date, ...linkView({ platform: 'youtube', ref: id }) }));
    putMentionsCache(cafe.id, 'videos', items);
    return { status: 'ok', items };
  } catch (e) { return { status: e.code === 'quota' ? 'limit' : 'unavailable', items: null }; }
}

app.get('/api/mentions', wrap(async (req, res) => {
  const id = String(req.query.id || ''), name = String(req.query.name || '').trim().slice(0, 200);
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!isCafeId(id) || !name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'Invalid cafe.' });
  const geo = await reverseGeocode(lat, lon).catch(() => ({ city: null, country: null }));
  const cafe = { id, name }, generic = isGenericName(name);
  const out = {
    searchLinks: searchLinks(name, geo.city), generic, city: geo.city,
    news: null, newsStatus: 'skipped', videos: null, videosStatus: 'skipped',
    youtubeEnabled: !!process.env.YOUTUBE_API_KEY, links: linksFor(id).map(linkJson),
  };
  if (!generic && (geo.city || geo.country)) { // automatic lookups need a name we can match and a place to verify against
    const hidden = hiddenFor(id);
    // Don't make anyone wait for a slow free service: after the deadline, answer with what we have. The lookups keep
    // running in the background and save their results, so asking again a moment later is instant.
    const deadline = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r({ status: 'slow', items: null }), +process.env.MENTIONS_DEADLINE_MS || 12000))]);
    const [n, v] = await Promise.all([deadline(loadNews(cafe, geo)), deadline(loadVideos(cafe, geo))]);
    out.newsStatus = n.status; out.news = n.items?.filter((i) => !hidden.has(i.url)) ?? null;
    out.videosStatus = v.status; out.videos = v.items?.filter((i) => !hidden.has(i.url)) ?? null;
  } else if (!generic) { out.newsStatus = 'no_location'; out.videosStatus = 'no_location'; }
  res.json(out);
}));

// Paste a link (Instagram reel/post, YouTube video, or any article) onto a cafe.
app.post('/api/links', wrap(async (req, res) => {
  const { cafeId, url } = req.body ?? {};
  if (!isCafeId(cafeId) || typeof url !== 'string' || url.length > 600) return res.status(400).json({ error: 'Invalid request.' });
  let media;
  try { media = parseMediaLink(url); } catch (e) { return res.status(400).json({ error: e.message }); }
  // The title is a nicety: never make the person wait more than a few seconds for a slow or unreachable site.
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  const title = media.platform === 'youtube' ? await youtubeTitle(media.ref) : media.platform === 'article' ? await within(fetchPageTitle(media.ref), 4000) : null;
  const r = addLink(cafeId, media.platform, media.ref, title);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ link: linkJson({ id: r.id, platform: media.platform, ref: media.ref, title }), duplicate: !!r.duplicate });
}));

app.delete('/api/links/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid id.' });
  res.json({ deleted: deleteLink(id) });
});

// "Not about this cafe": hide one result for one cafe.
app.post('/api/mentions/hide', (req, res) => {
  const { cafeId, url } = req.body ?? {};
  if (!isCafeId(cafeId) || typeof url !== 'string' || url.length > 500 || !/^https?:\/\//.test(url)) return res.status(400).json({ error: 'Invalid request.' });
  hideMention(cafeId, url);
  res.json({ ok: true });
});

app.get('/api/prefs', (_req, res) => res.json({ features: FEATURES, weights: getWeights(), vibeEnabled: googleEnabled() && llmEnabled() }));
app.put('/api/prefs', (req, res) => {
  const w = {};
  for (const f of FEATURES) w[f] = Math.max(-5, Math.min(5, +req.body.weights?.[f] || 0));
  setWeights(w);
  res.json({ weights: w });
});

// Save / rate a cafe. Rating also teaches the taste profile.
app.post('/api/cafes', (req, res) => {
  const { cafe, saved, rating, notes, visited } = req.body;
  const clean = sanitizeCafe(cafe); // never store the browser's object as-is
  if (!clean) return res.status(400).json({ error: 'cafe required' });
  if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'rating must be 1-5' });
  if (notes != null && (typeof notes !== 'string' || notes.length > 1000)) return res.status(400).json({ error: 'notes must be text up to 1000 characters' });
  upsertCafe(clean, { saved: saved == null ? null : +!!saved, rating, notes, visited: visited == null ? null : +!!visited });
  let weights = getWeights();
  if (rating) { weights = learnWeights(weights, clean.features, rating); setWeights(weights); }
  res.json({ weights });
});
// ---- backup & export ----
// Download everything in "My list" (+ your taste settings) as a backup, or as CSV / KML for spreadsheets and Google My Maps.
app.get('/api/export', (req, res) => {
  const format = ['json', 'csv', 'kml'].includes(req.query.format) ? req.query.format : 'json';
  const which = ['all', 'want', 'been'].includes(req.query.list) ? req.query.list : 'all';
  const rows = savedCafes().filter((c) => which === 'all' || (which === 'want' ? c.saved : c.visited));
  const day = new Date().toISOString().slice(0, 10);
  const label = { all: 'my-list', want: 'want-to-go', been: 'been-here' }[which];
  const files = {
    json: [`cafe-finder-backup-${day}.json`, 'application/json', () => JSON.stringify(buildBackup(savedCafes(), getWeights(), new Date(), { links: allLinks(), hidden: allHidden() }), null, 2)], // a backup is always the full list
    csv: [`cafe-finder-${label}.csv`, 'text/csv; charset=utf-8', () => toCsv(rows)],
    kml: [`cafe-finder-${label}.kml`, 'application/vnd.google-earth.kml+xml', () => toKml(rows, `Cafe Finder: ${label.replace(/-/g, ' ')}`)],
  };
  const [name, type, build] = files[format];
  res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }).send(build());
});

// Restore from a backup file. Entries with the same id are overwritten by the file's version; others are kept.
app.post('/api/import', (req, res) => {
  let parsed;
  try { parsed = parseBackup(req.body); } catch (e) { return res.status(400).json({ error: e.message }); }
  importRows(parsed.rows, { links: parsed.links, hidden: parsed.hidden });
  if (parsed.weights) setWeights(parsed.weights);
  res.json({ imported: parsed.rows.length, links: parsed.links.length, skipped: parsed.skipped, weightsRestored: !!parsed.weights });
});

// ---- weather tip (free Open-Meteo service; failures are quiet because weather is a nice-to-have) ----
app.get('/api/weather', async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'lat and lon required' });
  try { res.json(await fetchWeather(lat, lon)); } catch { res.status(204).end(); }
});

app.get('/api/saved', (_req, res) => {
  const websiteData = enrichmentMap();
  res.json({ cafes: savedCafes().map((c) => { const e = applyEnrichment(c, websiteData.get(c.id)); return { ...e, status: statusOf(e) }; }) });
});

const port = process.env.PORT || 3000;
// Listen on this computer only by default: the app has your saved list and (optionally) your Google key behind it.
// Set HOST=0.0.0.0 if you deliberately want other devices on your network to reach it.
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Cafe finder on http://localhost:${port}`));
