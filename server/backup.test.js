import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCafe, buildBackup, parseBackup, toCsv, toKml } from './backup.js';

const good = { id: 'node/42', name: 'Dark Arts Coffee', lat: 51.52, lon: -0.08, address: 'Holywell Lane, London', hours: 'Mo-Fr 08:00-15:00', website: 'darkarts.example', features: { wifi: true, specialty: true, bogus: true }, details: { phone: '+44 20 1234', cuisine: ['Coffee shop'], toilets: true, evil: '<script>' } };

test('sanitizeCafe keeps valid fields and drops everything unknown', () => {
  const c = sanitizeCafe(good);
  assert.equal(c.name, 'Dark Arts Coffee');
  assert.equal(c.features.wifi, true); assert.equal(c.features.power, false); assert.ok(!('bogus' in c.features));
  assert.equal(c.details.phone, '+44 20 1234'); assert.deepEqual(c.details.cuisine, ['Coffee shop']); assert.ok(!('evil' in c.details));
});

test('sanitizeCafe rejects unusable cafes', () => {
  for (const bad of [null, 'x', {}, { ...good, id: 'javascript:alert(1)' }, { ...good, id: 'node/1/../2' }, { ...good, name: '' }, { ...good, lat: 'a' }, { ...good, lat: 91 }, { ...good, lon: 181 }]) {
    assert.equal(sanitizeCafe(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test('sanitizeCafe only trusts https map links and well-formed photo names', () => {
  const c = sanitizeCafe({ ...good, osmUrl: 'javascript:alert(1)', mapsUrl: 'http://x', photo: '../../etc/passwd', rating: 9 });
  assert.equal(c.osmUrl, null); assert.equal(c.mapsUrl, null); assert.equal(c.photo, null); assert.equal(c.rating, null);
  assert.equal(sanitizeCafe({ ...good, osmUrl: 'https://www.openstreetmap.org/node/42' }).osmUrl, 'https://www.openstreetmap.org/node/42');
});

test('a backup round-trips: build -> JSON -> parse', () => {
  const rows = [{ ...good, rating: 4.5, ratingCount: 120, saved: true, visited: false, userRating: 4, notes: 'try the bun' }, { ...good, id: 'way/7', name: 'B', saved: false, visited: true, userRating: null, notes: '' }];
  const weights = { wifi: 5, power: -2 };
  const file = JSON.parse(JSON.stringify(buildBackup(rows, weights, new Date('2026-11-06T00:00:00Z'))));
  assert.equal(file.exportedAt, '2026-11-06T00:00:00.000Z');
  const { rows: back, weights: w, skipped } = parseBackup(file);
  assert.equal(skipped, 0); assert.equal(back.length, 2);
  assert.deepEqual([back[0].saved, back[0].visited, back[0].rating, back[0].notes], [true, false, 4, 'try the bun']);
  assert.deepEqual([back[0].cafe.rating, back[0].cafe.ratingCount], [4.5, 120]); // Google's rating is kept separate from yours
  assert.deepEqual([back[1].saved, back[1].visited, back[1].rating], [false, true, null]);
  assert.equal(w.wifi, 5); assert.equal(w.power, -2); assert.equal(w.outdoor, 0);
});

test('parseBackup rejects foreign or oversized files, and skips bad entries', () => {
  assert.throws(() => parseBackup(null), /doesn’t look like/);
  assert.throws(() => parseBackup({ app: 'other', version: 1, cafes: [] }), /doesn’t look like/);
  assert.throws(() => parseBackup({ app: 'cafe-finder', version: 2, cafes: [] }), /Unsupported/);
  assert.throws(() => parseBackup({ app: 'cafe-finder', version: 1 }), /no cafe list/);
  assert.throws(() => parseBackup({ app: 'cafe-finder', version: 1, cafes: new Array(5001).fill(good) }), /Too many/);
  const r = parseBackup({ app: 'cafe-finder', version: 1, cafes: [good, { id: 'bad' }, null], weights: { wifi: 99, power: 'x' } });
  assert.equal(r.rows.length, 1); assert.equal(r.skipped, 2);
  assert.equal(r.weights.wifi, 5); assert.equal(r.weights.power, 0); // clamped / defaulted
});

test('a personal rating in a file is never mistaken for a Google rating', () => {
  const r = parseBackup({ app: 'cafe-finder', version: 1, cafes: [{ ...good, userRating: 5 }] });
  assert.equal(r.rows[0].rating, 5); assert.equal(r.rows[0].cafe.rating, null); assert.equal(r.rows[0].cafe.ratingCount, null);
  assert.equal(sanitizeCafe({ ...good, rating: 4 }).rating, null); // a rating without a review count is dropped
});

test('imported ratings and notes are clamped to valid values', () => {
  const r = parseBackup({ app: 'cafe-finder', version: 1, cafes: [{ ...good, userRating: 99, notes: 'x'.repeat(5000), saved: 'yes' }] });
  assert.equal(r.rows[0].rating, null); assert.equal(r.rows[0].notes.length, 1000); assert.equal(r.rows[0].saved, false);
});

test('CSV escapes quotes/commas/newlines and defuses spreadsheet formulas', () => {
  const csv = toCsv([
    { name: 'He said "hi", ok', address: 'Line1\nLine2', lat: 1, lon: 2, saved: true, visited: true, userRating: 5, notes: '=HYPERLINK("http://evil")', website: '@cmd', details: { phone: '+44 20 1234' } },
    { name: '-2+3', address: '', lat: 3, lon: 4, saved: false, visited: false, userRating: null, notes: '', details: {} },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Name,Address,Latitude,Longitude,Status,Rating,Notes,Website,Phone');
  assert.ok(csv.includes('"He said ""hi"", ok"'));
  assert.ok(csv.includes('"Line1\nLine2"'));
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`)); // formula neutralised
  assert.ok(csv.includes(",'@cmd,"));
  assert.ok(csv.includes(",+44 20 1234")); // phone numbers stay readable
  assert.ok(csv.includes("'-2+3"));
  assert.ok(csv.includes('Been here + Want to go'));
});

test('KML escapes XML and writes lon,lat order', () => {
  const kml = toKml([{ name: 'A & B <cafe>', address: '1 "Main" St', lat: 51.5, lon: -0.08, saved: true, visited: false, userRating: 4, notes: "it's <b>nice</b>", website: null }], 'My <list>');
  assert.ok(kml.includes('<name>My &lt;list&gt;</name>'));
  assert.ok(kml.includes('<name>A &amp; B &lt;cafe&gt;</name>'));
  assert.ok(kml.includes('&lt;b&gt;nice&lt;/b&gt;') && kml.includes('it&apos;s'));
  assert.ok(kml.includes('<coordinates>-0.08,51.5,0</coordinates>'));
  assert.ok(kml.startsWith('<?xml'));
});
