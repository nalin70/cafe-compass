import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.tmpdir(), `cafe-mentions-test-${process.pid}-${Date.now()}.db`);
process.env.CAFE_DB = file;
const db = await import('./db.js');
const { buildBackup, parseBackup } = await import('./backup.js');
test.after(() => { try { fs.rmSync(file, { force: true }); } catch { /* still open on Windows; harmless temp file */ } });

test('links: add, list, de-duplicate, delete', () => {
  const a = db.addLink('node/1', 'youtube', 'dQw4w9WgXcQ', 'A video');
  assert.ok(a.id > 0 && !a.duplicate);
  assert.equal(db.addLink('node/1', 'youtube', 'dQw4w9WgXcQ', 'again').duplicate, true);
  db.addLink('node/1', 'instagram', 'reel/Cabc123', null);
  db.addLink('node/2', 'article', 'https://example.com/a', 'Story');
  assert.deepEqual(db.linksFor('node/1').map((l) => [l.platform, l.ref, l.title]), [['youtube', 'dQw4w9WgXcQ', 'A video'], ['instagram', 'reel/Cabc123', null]]);
  assert.equal(db.linksFor('node/2').length, 1);
  assert.equal(db.deleteLink(a.id), true); assert.equal(db.deleteLink(a.id), false);
  assert.equal(db.linksFor('node/1').length, 1);
});

test('links: a per-cafe limit protects the database', () => {
  let last;
  for (let i = 0; i < 25; i++) last = db.addLink('node/9', 'article', `https://example.com/${i}`, null);
  assert.match(last.error, /up to 20/);
  assert.equal(db.linksFor('node/9').length, 20);
});

test('hidden mentions are remembered per cafe', () => {
  db.hideMention('node/1', 'https://news.example/x'); db.hideMention('node/1', 'https://news.example/x');
  assert.deepEqual([...db.hiddenFor('node/1')], ['https://news.example/x']);
  assert.equal(db.hiddenFor('node/2').size, 0);
});

test('lookup cache: fresh results returned, stale or missing ones are not', () => {
  db.putMentionsCache('node/1', 'news', [{ title: 'T', url: 'https://x.example/1' }]);
  assert.deepEqual(db.getMentionsCache('node/1', 'news', 60_000), [{ title: 'T', url: 'https://x.example/1' }]);
  assert.equal(db.getMentionsCache('node/1', 'videos', 60_000), null);
  assert.equal(db.getMentionsCache('node/1', 'news', -1), null); // older than allowed
  db.putMentionsCache('node/1', 'news', []);
  assert.deepEqual(db.getMentionsCache('node/1', 'news', 60_000), []); // an empty result is a valid cached answer
});

test('backup round-trips pasted links and hidden mentions, and rejects bad entries', () => {
  const file1 = JSON.parse(JSON.stringify(buildBackup([], {}, new Date(), { links: db.allLinks(), hidden: db.allHidden() })));
  assert.ok(file1.links.length >= 3 && file1.hidden.length === 1);
  const parsed = parseBackup(file1);
  assert.equal(parsed.links.length, file1.links.length); assert.equal(parsed.hidden.length, 1);

  const evil = parseBackup({
    app: 'cafe-finder', version: 1, cafes: [],
    links: [
      { cafeId: 'node/1', platform: 'youtube', ref: 'dQw4w9WgXcQ', title: 'ok' },
      { cafeId: 'node/1', platform: 'youtube', ref: '../../x' }, { cafeId: 'node/1', platform: 'instagram', ref: 'explore/tags' },
      { cafeId: 'node/1', platform: 'article', ref: 'http://127.0.0.1/admin' }, { cafeId: 'javascript:1', platform: 'article', ref: 'https://example.com' },
      { cafeId: 'node/1', platform: 'script', ref: 'x' }, null, 'string',
    ],
    hidden: [{ cafeId: 'node/1', url: 'https://ok.example/a' }, { cafeId: 'node/1', url: 'javascript:alert(1)' }, { cafeId: 'bad', url: 'https://x.example' }],
  });
  assert.equal(evil.links.length, 1); assert.equal(evil.hidden.length, 1); assert.equal(evil.skipped, 7 + 2);
});

test('an old backup with no links/hidden still restores; importing links is part of the all-or-nothing import', () => {
  const old = parseBackup({ app: 'cafe-finder', version: 1, cafes: [] });
  assert.deepEqual([old.links, old.hidden], [[], []]);
  db.importRows([], { links: [{ cafeId: 'node/55', platform: 'article', ref: 'https://example.com/imported', title: 'Imported' }], hidden: [{ cafeId: 'node/55', url: 'https://x.example/h' }] });
  assert.equal(db.linksFor('node/55')[0].title, 'Imported'); assert.ok(db.hiddenFor('node/55').has('https://x.example/h'));
  db.importRows([], { links: [{ cafeId: 'node/55', platform: 'article', ref: 'https://example.com/imported', title: 'Imported' }] }); // importing twice doesn't duplicate
  assert.equal(db.linksFor('node/55').length, 1);
});
