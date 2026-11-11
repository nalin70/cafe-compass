import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Fake Overpass + Nominatim servers, so findCafes can be tested without the real (flaky) ones.
let overpassHits = 0, overpassUp = true;
const els = [
  { type: 'node', id: 1, lat: 51.5200, lon: -0.0800, tags: { amenity: 'cafe', name: 'Near Cafe' } },    // ~0 m
  { type: 'node', id: 2, lat: 51.5290, lon: -0.0800, tags: { amenity: 'cafe', name: 'Mid Cafe' } },     // ~1 km north
  { type: 'node', id: 3, lat: 51.5470, lon: -0.0800, tags: { amenity: 'cafe', name: 'Far Cafe' } },     // ~3 km north
];
const overpass = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    overpassHits++;
    if (!overpassUp) { res.statusCode = 503; return res.end('busy'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ elements: els }));
  });
});
let nominatimMode = 'down';
const nominatim = http.createServer((req, res) => {
  if (nominatimMode === 'down') { res.statusCode = 500; return res.end('x'); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify([{ osm_type: 'node', osm_id: 9, name: 'Backup Cafe', lat: '51.5201', lon: '-0.0801', extratags: {}, address: {} }]));
});
await Promise.all([new Promise((r) => overpass.listen(0, r)), new Promise((r) => nominatim.listen(0, r))]);
process.env.OVERPASS_URL = `http://localhost:${overpass.address().port}/api/interpreter`;
process.env.NOMINATIM_URL = `http://localhost:${nominatim.address().port}`;
const { findCafes } = await import('./sources.js');

// in-memory stand-in for the SQLite cache with the same interface
const makeCache = () => {
  const entries = [];
  return { entries, near: () => entries, put: (e) => entries.push(e) };
};
const here = { lat: 51.52, lon: -0.08 };
const names = (r) => r.cafes.map((c) => c.name).sort();

test.after(() => { overpass.close(); nominatim.close(); });

test('first search goes live and fills the cache; the repeat is served from cache without touching the server', async () => {
  const cache = makeCache();
  overpassHits = 0;
  const a = await findCafes(here, 5000, { cache });
  assert.equal(a.from, 'live'); assert.equal(overpassHits, 1); assert.equal(cache.entries.length, 1);
  const b = await findCafes(here, 5000, { cache });
  assert.equal(b.from, 'cache'); assert.equal(overpassHits, 1);
  assert.deepEqual(names(b), ['Far Cafe', 'Mid Cafe', 'Near Cafe']);
});

test('a smaller search is answered from a bigger cached one, trimmed to the true radius', async () => {
  const cache = makeCache();
  await findCafes(here, 5000, { cache });
  overpassHits = 0;
  const r = await findCafes(here, 1500, { cache });
  assert.equal(r.from, 'cache'); assert.equal(overpassHits, 0);
  assert.deepEqual(names(r), ['Mid Cafe', 'Near Cafe']); // Far Cafe (~3 km) is outside 1.5 km
});

test('a slightly different spot (GPS jitter) still reuses the cache, but a bigger radius goes live again', async () => {
  const cache = makeCache();
  await findCafes(here, 2000, { cache });
  overpassHits = 0;
  assert.equal((await findCafes({ lat: 51.5203, lon: -0.0805 }, 1000, { cache })).from, 'cache');
  assert.equal(overpassHits, 0);
  assert.equal((await findCafes(here, 8000, { cache })).from, 'live'); // not covered by the 2 km entry
  assert.equal(overpassHits, 1);
});

test('refresh=true skips the cache', async () => {
  const cache = makeCache();
  await findCafes(here, 2000, { cache });
  overpassHits = 0;
  assert.equal((await findCafes(here, 2000, { cache, refresh: true })).from, 'live');
  assert.equal(overpassHits, 1);
});

test('when the live servers are down, old saved results are shown (marked stale), even past the 24h freshness', async () => {
  const cache = makeCache();
  await findCafes(here, 5000, { cache });
  cache.entries[0].fetchedAt -= 3 * 24 * 3600e3; // 3 days old
  overpassUp = false; nominatimMode = 'down';
  try {
    const r = await findCafes(here, 2000, { cache });
    assert.equal(r.from, 'stale'); assert.equal(r.limited, false); assert.equal(r.partial, false);
    assert.deepEqual(names(r), ['Mid Cafe', 'Near Cafe']);
  } finally { overpassUp = true; }
});

test('a complete stale result is preferred over a capped (partial) live backup', async () => {
  const cache = makeCache();
  await findCafes(here, 5000, { cache });
  cache.entries[0].fetchedAt -= 3 * 24 * 3600e3;
  overpassUp = false; nominatimMode = 'up';
  try {
    const r = await findCafes(here, 2000, { cache });
    assert.equal(r.from, 'stale');
    assert.ok(!names(r).includes('Backup Cafe'));
  } finally { overpassUp = true; nominatimMode = 'down'; }
});

test('with no saved results, the capped backup source is used and marked partial', async () => {
  overpassUp = false; nominatimMode = 'up';
  try {
    const cache = makeCache();
    const r = await findCafes(here, 5000, { cache });
    assert.equal(r.partial, true); assert.equal(r.from, 'live'); assert.deepEqual(names(r), ['Backup Cafe']);
    assert.equal(cache.entries[0].radiusM, 3000); // only claims the area it actually searched
  } finally { overpassUp = true; nominatimMode = 'down'; }
});

test('stale results for a smaller area are flagged as limited; nothing saved and everything down throws', async () => {
  const cache = makeCache();
  await findCafes(here, 1500, { cache });
  overpassUp = false; nominatimMode = 'down';
  try {
    cache.entries[0].fetchedAt -= 2 * 24 * 3600e3;
    const r = await findCafes(here, 6000, { cache });
    assert.equal(r.from, 'stale'); assert.equal(r.limited, true);
    await assert.rejects(findCafes({ lat: 10, lon: 10 }, 2000, { cache: makeCache() }), /busy/);
  } finally { overpassUp = true; }
});

test('works without any cache (always live)', async () => {
  overpassHits = 0;
  assert.equal((await findCafes(here, 2000)).from, 'live');
  assert.equal((await findCafes(here, 2000)).from, 'live');
  assert.equal(overpassHits, 2);
});
