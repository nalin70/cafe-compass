import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ---- fake GDELT, YouTube (+oEmbed) and Nominatim servers
const seen = { gdelt: [], youtube: [], nominatim: [] };
let gdeltMode = 'ok', ytMode = 'ok';
const articles = [
  { url: 'https://www.thehindu.example/blue-tokai-opens-new-roastery-in-bengaluru', title: 'Blue Tokai opens new roastery in Bengaluru', seendate: '20260105T120000Z', domain: 'thehindu.example', sourcecountry: 'India' },
  { url: 'https://news.example/blue-tokai-opens-new-roastery-in-bengaluru?utm=x', title: 'Blue Tokai opens new roastery in Bengaluru', seendate: '20260106T080000Z', domain: 'news.example', sourcecountry: 'India' }, // same URL apart from tracking
  { url: 'javascript:alert(1)', title: 'Blue Tokai evil', seendate: '20260105T120000Z', domain: 'x', sourcecountry: 'India' },
  { url: 'https://no-title.example/a', title: '', seendate: '20260105T120000Z', domain: 'x', sourcecountry: 'India' },
  { url: 'https://html.example/a', title: 'Blue Tokai <img src=x onerror=alert(1)> in Bengaluru', seendate: 'garbage', domain: 'html.example', sourcecountry: 'India' },
];
const gdelt = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  seen.gdelt.push({ at: Date.now(), query: q.get('query'), timespan: q.get('timespan'), mode: q.get('mode'), format: q.get('format') });
  if (gdeltMode === 'throttle') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Please limit requests to one every 5 seconds.'); }
  if (gdeltMode === 'empty') { res.writeHead(200); return res.end(''); }
  if (gdeltMode === 'error') { res.writeHead(500); return res.end('boom'); }
  if (gdeltMode === 'ratelimit') { res.writeHead(429, { 'content-type': 'text/plain' }); return res.end('Please limit requests to one every 5 seconds.'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ articles }));
});
const youtube = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/oembed') { if (ytMode === 'oembed-fail') { res.writeHead(404); return res.end(); } res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ title: 'A day at <b>Blue Tokai</b>' })); }
  seen.youtube.push({ url: req.url, key: req.headers['x-goog-api-key'], q: u.searchParams.get('q') });
  if (ytMode === 'quota') { res.writeHead(403); return res.end('{}'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ items: [
    { id: { videoId: 'dQw4w9WgXcQ' }, snippet: { title: 'Blue Tokai Bengaluru cafe tour', description: 'We visit Blue Tokai in Bengaluru', channelTitle: 'Hopper', publishedAt: '2026-01-02T10:00:00Z' } },
    { id: { videoId: 'bad' }, snippet: { title: 'Blue Tokai invalid id' } },
    { id: { videoId: 'aaaaaaaaaaa' }, snippet: { title: 'Blue Tokai Mumbai review', description: 'In Mumbai', channelTitle: 'x' } },
  ] }));
});
const nominatim = http.createServer((req, res) => {
  seen.nominatim.push({ at: Date.now(), url: req.url });
  if (req.url.includes('lat=0')) { res.writeHead(500); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ address: { suburb: 'Indiranagar', city: 'Bengaluru', country: 'India' } }));
});
await Promise.all([gdelt, youtube, nominatim].map((s) => new Promise((r) => s.listen(0, r))));
const port = (s) => s.address().port;
process.env.GDELT_URL = `http://localhost:${port(gdelt)}/doc`;
process.env.GDELT_GAP_MS = '60';
process.env.YOUTUBE_API_URL = `http://localhost:${port(youtube)}/search`;
process.env.YOUTUBE_OEMBED_URL = `http://localhost:${port(youtube)}/oembed`;
process.env.NOMINATIM_URL = `http://localhost:${port(nominatim)}`;
process.env.REVERSE_GAP_MS = '40';
const M = await import('./mentions.js');
const { reverseGeocode, placeInfo, cleanPlace } = await import('./sources.js');
test.after(() => [gdelt, youtube, nominatim].forEach((s) => s.close()));

const cafe = { id: 'node/1', name: 'Blue Tokai Coffee Roasters' };

test('names: which words identify a cafe, and which names are too generic to match automatically', () => {
  assert.deepEqual(M.distinctiveTokens('Blue Tokai Coffee Roasters'), ['blue', 'tokai']);
  assert.deepEqual(M.distinctiveTokens('Café Mondegar'), ['mondegar']);
  assert.deepEqual(M.distinctiveTokens('Third Wave Coffee'), ['third', 'wave']);
  for (const generic of ['Cafe', 'The Coffee House', 'Zed', 'कैफ़े', '', '   ', 'Coffee & Tea Bar']) assert.equal(M.isGenericName(generic), true, generic);
  for (const ok of ['Zeds', 'Blue Tokai', 'Café Mondegar', 'Dark Arts Coffee']) assert.equal(M.isGenericName(ok), false, ok);
});

test('news must name the cafe as a phrase AND the city (or a same-country publisher)', () => {
  const geo = { city: 'Bengaluru', country: 'India' };
  const item = (title, extra = {}) => ({ title, url: 'https://n.example/story', country: 'India', ...extra });
  assert.equal(M.relevantNews(item('Blue Tokai opens new roastery in Bengaluru'), cafe, geo), true);
  assert.equal(M.relevantNews(item('Blue Tokai opens new roastery in Mumbai', { country: 'United States' }), cafe, geo), false, 'other city, other country');
  assert.equal(M.relevantNews(item('Blue Tokai raises funding'), cafe, geo), true, 'same-country publisher is accepted');
  assert.equal(M.relevantNews(item('Blue Tokai raises funding', { country: 'United Kingdom' }), cafe, geo), false);
  assert.equal(M.relevantNews(item('Blue skies over Tokai beach in Bengaluru'), cafe, geo), false, 'the words must be adjacent');
  assert.equal(M.relevantNews(item('Bluetokai in Bengaluru'), cafe, geo), false, 'no partial-word matches');
  assert.equal(M.relevantNews({ title: 'Opens in Bengaluru', url: 'https://n.example/blue-tokai-opens', country: 'X' }, cafe, geo), true, 'URL slug counts');
  assert.equal(M.relevantNews(item('Cafe Mondegar turns 70 in Mumbai', { country: 'India' }), { name: 'Café Mondegar' }, { city: 'Mumbai', country: 'India' }), true, 'accents ignored');
  assert.equal(M.relevantNews(item('Anything about Bengaluru'), { name: 'Coffee' }, geo), false, 'a generic name never matches');
});

test('videos must name the cafe and the city', () => {
  const v = (title, description = '', channel = '') => ({ title, description, channel });
  assert.equal(M.relevantVideo(v('Blue Tokai Bengaluru tour'), cafe, { city: 'Bengaluru' }), true);
  assert.equal(M.relevantVideo(v('Blue Tokai Mumbai review', 'In Mumbai'), cafe, { city: 'Bengaluru' }), false);
  assert.equal(M.relevantVideo(v('Best cafes', 'we loved Blue Tokai in Bengaluru'), cafe, { city: 'Bengaluru' }), true);
  assert.equal(M.relevantVideo(v('Bengaluru cafe tour'), cafe, { city: 'Bengaluru' }), false);
});

test('selectRelevant drops duplicates (same URL ignoring tracking, same headline on a site) and caps the count', () => {
  const items = [
    { url: 'https://a.example/x?utm=1', title: 'Story', domain: 'a.example' }, { url: 'https://a.example/x?utm=2', title: 'Story again', domain: 'a.example' },
    { url: 'https://a.example/y', title: 'STORY', domain: 'a.example' }, { url: 'https://b.example/z', title: 'Story', domain: 'b.example' },
    { url: 'https://c.example/1', title: 'One', domain: 'c.example' }, { url: 'https://c.example/2', title: 'Two', domain: 'c.example' },
  ];
  assert.deepEqual(M.selectRelevant(items, () => true, 10).map((i) => i.url), ['https://a.example/x?utm=1', 'https://b.example/z', 'https://c.example/1', 'https://c.example/2']);
  assert.equal(M.selectRelevant(items, () => true, 2).length, 2);
  assert.equal(M.selectRelevant(items, () => false, 5).length, 0);
});

test('search links are always built, properly encoded', () => {
  const l = M.searchLinks('Dark "Arts" & Co', 'São Paulo');
  assert.ok(l.news.startsWith('https://www.google.com/search?q=') && l.news.endsWith('&tbm=nws'));
  assert.ok(l.youtube.startsWith('https://www.youtube.com/results?search_query='));
  assert.ok(decodeURIComponent(l.instagram).includes('site:instagram.com'));
  assert.ok(!/[ "&]Co[ "]/.test(l.web.split('q=')[1]), 'query is percent-encoded');
  assert.ok(M.searchLinks('X', null).web.includes(encodeURIComponent('"X"')));
});

test('parseMediaLink understands YouTube, Instagram and articles', () => {
  const ok = (u, platform, ref) => assert.deepEqual(M.parseMediaLink(u), { platform, ref }, u);
  ok('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s', 'youtube', 'dQw4w9WgXcQ');
  ok('https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube', 'dQw4w9WgXcQ');
  ok('https://m.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ');
  ok('https://www.instagram.com/reel/Cabc123_-x/?igsh=zzz', 'instagram', 'reel/Cabc123_-x');
  ok('https://www.instagram.com/reels/Cabc123_-x/', 'instagram', 'reel/Cabc123_-x');
  ok('https://instagram.com/p/Cabc123/', 'instagram', 'p/Cabc123');
  ok('https://www.instagram.com/some.cafe/reel/Cabc123/', 'instagram', 'reel/Cabc123');
  ok('https://example.com/news/story#comments', 'article', 'https://example.com/news/story');
  assert.equal(M.parseMediaLink('http://example.com/a').platform, 'article');
});

test('parseMediaLink rejects unsafe or unusable links, and never treats look-alike hosts as embeddable', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'ftp://example.com/x', 'file:///etc/passwd', 'not a url', '', 'http://127.0.0.1/x', 'http://localhost/x', 'http://169.254.169.254/', 'https://user:pw@example.com/', 'https://www.instagram.com/some.cafe/', 'https://www.instagram.com/', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/@channel', 'https://youtu.be/']) {
    assert.throws(() => M.parseMediaLink(bad), Error, String(bad));
  }
  for (const lookalike of ['https://instagram.com.evil.example/reel/Cabc123/', 'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://evil.example/instagram.com/reel/Cabc123/']) {
    assert.equal(M.parseMediaLink(lookalike).platform, 'article', lookalike); // a plain link, never an embed
  }
});

test('embed URLs are built from validated IDs only', () => {
  assert.deepEqual(M.linkView({ platform: 'youtube', ref: 'dQw4w9WgXcQ' }), { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', thumb: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg' });
  assert.deepEqual(M.linkView({ platform: 'instagram', ref: 'reel/Cabc123' }), { url: 'https://www.instagram.com/reel/Cabc123/', embedUrl: 'https://www.instagram.com/reel/Cabc123/embed', thumb: null });
  assert.equal(M.linkView({ platform: 'article', ref: 'https://example.com/a' }).embedUrl, null);
  assert.equal(M.validRef('youtube', 'dQw4w9WgXcQ'), true); assert.equal(M.validRef('youtube', '../x'), false);
  assert.equal(M.validRef('instagram', 'reel/Cabc123'), true); assert.equal(M.validRef('instagram', 'reel/../x'), false); assert.equal(M.validRef('instagram', 'explore/tags'), false);
  assert.equal(M.validRef('article', 'https://example.com/a'), true); assert.equal(M.validRef('article', 'http://127.0.0.1/a'), false); assert.equal(M.validRef('weird', 'x'), false);
});

test('GDELT: builds a phrase+city query, keeps only valid headlines, strips markup', async () => {
  seen.gdelt.length = 0; gdeltMode = 'ok';
  const items = await M.fetchGdelt('Blue Tokai (Roasters)', 'Bengaluru');
  assert.equal(seen.gdelt[0].query, '"Blue Tokai Roasters" Bengaluru');
  assert.deepEqual([seen.gdelt[0].timespan, seen.gdelt[0].mode, seen.gdelt[0].format], ['3months', 'artlist', 'json']);
  assert.equal(items.length, 3); // javascript: URL and empty title dropped
  assert.equal(items[0].date, '2026-01-05T12:00:00Z'); assert.equal(items[0].country, 'India');
  assert.ok(!items.some((i) => /[<>]/.test(i.title)), 'angle brackets removed');
  assert.equal(items[2].date, null);
  await M.fetchGdelt('X Cafe', 'Navi Mumbai');
  assert.equal(seen.gdelt.at(-1).query, '"X Cafe" "Navi Mumbai"'); // multi-word city is quoted
});

test('GDELT: a plain-text throttle reply, an error, or nothing at all are handled', async () => {
  gdeltMode = 'throttle';
  await assert.rejects(M.fetchGdelt('A', 'B'), (e) => e.code === 'unavailable');
  gdeltMode = 'error';
  await assert.rejects(M.fetchGdelt('A', 'B'), (e) => e.code === 'unavailable');
  gdeltMode = 'empty';
  assert.deepEqual(await M.fetchGdelt('A', 'B'), []);
  gdeltMode = 'ok';
});

test('GDELT: requests are spaced out, and when too many are waiting the rest are told "busy"', async () => {
  seen.gdelt.length = 0;
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => M.fetchGdelt('A', 'B')));
  assert.ok(results.every((r) => r.status === 'fulfilled'));
  const gaps = seen.gdelt.slice(1).map((s, i) => s.at - seen.gdelt[i].at);
  assert.ok(gaps.every((g) => g >= 45), `gaps ${gaps}`); // GDELT_GAP_MS is 60 in this test

  const burst = await Promise.allSettled(Array.from({ length: 8 }, () => M.fetchGdelt('A', 'B')));
  const busy = burst.filter((r) => r.status === 'rejected' && r.reason.code === 'busy').length;
  assert.equal(busy, 3, 'at most 5 may wait; the other 3 are turned away');
  assert.equal(burst.filter((r) => r.status === 'fulfilled').length, 5);
});

test('YouTube: key goes in a header (never the URL); invalid items dropped; quota errors flagged', async () => {
  seen.youtube.length = 0; ytMode = 'ok';
  const items = await M.fetchYouTube('Blue Tokai', 'Bengaluru', 'SECRET-KEY');
  assert.equal(seen.youtube[0].key, 'SECRET-KEY'); assert.ok(!seen.youtube[0].url.includes('SECRET'));
  assert.equal(seen.youtube[0].q, 'Blue Tokai Bengaluru');
  assert.deepEqual(items.map((i) => i.id), ['dQw4w9WgXcQ', 'aaaaaaaaaaa']); // 'bad' (not an 11-char id) dropped
  const kept = M.selectRelevant(items.map((v) => ({ ...v, url: `https://www.youtube.com/watch?v=${v.id}` })), (v) => M.relevantVideo(v, cafe, { city: 'Bengaluru' }), 4);
  assert.deepEqual(kept.map((v) => v.id), ['dQw4w9WgXcQ']); // the Mumbai video is filtered out
  ytMode = 'quota';
  await assert.rejects(M.fetchYouTube('A', 'B', 'k'), (e) => e.code === 'quota');
  ytMode = 'ok';
});

test('YouTube titles: markup stripped, failures give null', async () => {
  // the fake oEmbed returns 'A day at <b>Blue Tokai</b>': angle brackets must not survive
  assert.equal(await M.youtubeTitle('dQw4w9WgXcQ'), 'A day at b Blue Tokai /b');
  ytMode = 'oembed-fail';
  assert.equal(await M.youtubeTitle('dQw4w9WgXcQ'), null);
  ytMode = 'ok';
});

test('reverse geocoding: city and country, cached, and spaced out', async () => {
  seen.nominatim.length = 0;
  const a = await reverseGeocode(12.9784, 77.6408);
  assert.deepEqual(a, { city: 'Bengaluru', cities: ['Bengaluru', 'Indiranagar'], country: 'India' });
  await reverseGeocode(12.9790, 77.6410); // same ~10 km cell
  assert.equal(seen.nominatim.length, 1, 'second call served from cache');
  await Promise.all([reverseGeocode(19.0, 72.8), reverseGeocode(28.5, 77.2)]);
  const gaps = seen.nominatim.slice(1).map((s, i) => s.at - seen.nominatim[i].at);
  assert.ok(gaps.every((g) => g >= 30), `gaps ${gaps}`);
  await assert.rejects(reverseGeocode(0.0, 5.5), /failed/);
});

test('place names from OpenStreetMap are cleaned so they match how headlines write them', () => {
  // the exact strings returned by the live run for London and Mumbai
  assert.equal(cleanPlace('Greater London'), 'London');
  assert.equal(cleanPlace('Mumbai City District'), 'Mumbai');
  assert.equal(cleanPlace('Los Angeles County'), 'Los Angeles');
  assert.equal(cleanPlace('City of London'), 'London');
  assert.equal(cleanPlace('London Borough of Hackney'), 'Hackney');
  assert.equal(cleanPlace('Bengaluru Urban District'), 'Bengaluru Urban');
  assert.equal(cleanPlace('Pune Municipal Corporation'), 'Pune');
  assert.equal(cleanPlace('Salt Lake City'), 'Salt Lake City'); // a real city name is left alone
  assert.equal(cleanPlace('District'), null); assert.equal(cleanPlace(undefined), null); assert.equal(cleanPlace(''), null);
  assert.deepEqual(placeInfo({ county: 'Mumbai City District', suburb: 'Colaba', country: 'India' }), { city: 'Mumbai', cities: ['Colaba', 'Mumbai'], country: 'India' });
  assert.deepEqual(placeInfo({ state_district: 'Greater London', suburb: 'Shoreditch', country: 'United Kingdom' }), { city: 'London', cities: ['Shoreditch', 'London'], country: 'United Kingdom' });
  assert.deepEqual(placeInfo({}), { city: null, cities: [], country: null });
});

test('news matches any of the cleaned place names (suburb or city)', () => {
  const geo = placeInfo({ county: 'Mumbai City District', suburb: 'Colaba', country: 'India' });
  const base = { url: 'https://n.example/x', country: 'United States' }; // foreign publisher, so only the place name can match
  assert.equal(M.relevantNews({ ...base, title: 'Cafe Mondegar turns 70 in Mumbai' }, { name: 'Café Mondegar' }, geo), true);
  assert.equal(M.relevantNews({ ...base, title: 'Cafe Mondegar, Colaba institution' }, { name: 'Café Mondegar' }, geo), true);
  assert.equal(M.relevantNews({ ...base, title: 'Cafe Mondegar in Delhi' }, { name: 'Café Mondegar' }, geo), false);
});

test('GDELT: HTTP 429 is reported as rate-limited (so the page can say so)', async () => {
  gdeltMode = 'ratelimit';
  await assert.rejects(M.fetchGdelt('A', 'B'), (e) => e.code === 'rate_limited');
  gdeltMode = 'ok';
});
