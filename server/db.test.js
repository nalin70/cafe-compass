import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// An old database from before the "visited" column existed, with a saved cafe in it.
const file = path.join(os.tmpdir(), `cafe-db-test-${process.pid}-${Date.now()}.db`);
const old = new DatabaseSync(file);
old.exec(`CREATE TABLE cafes (id TEXT PRIMARY KEY, data TEXT NOT NULL, saved INTEGER DEFAULT 0, rating INTEGER, notes TEXT DEFAULT '')`);
old.prepare('INSERT INTO cafes (id, data, saved, rating, notes) VALUES (?, ?, 1, 4, ?)').run('node/1', JSON.stringify({ id: 'node/1', name: 'Old Favourite' }), 'nice');
old.close();

process.env.CAFE_DB = file;
const { upsertCafe, savedCafes, userState } = await import('./db.js');
const cafe = (id, name) => ({ id, name, features: {} });

test('migrates an old database and keeps existing data', () => {
  const [c] = savedCafes();
  assert.equal(c.name, 'Old Favourite');
  assert.equal(c.saved, true); assert.equal(c.userRating, 4); assert.equal(c.notes, 'nice'); assert.equal(c.visited, false);
});

test('marking visited or adding a note does not un-save or un-rate', () => {
  upsertCafe(cafe('node/1', 'Old Favourite'), { visited: 1 });
  upsertCafe(cafe('node/1', 'Old Favourite'), { notes: 'try the cardamom bun' });
  const c = savedCafes().find((x) => x.id === 'node/1');
  assert.deepEqual([c.saved, c.visited, c.userRating, c.notes], [true, true, 4, 'try the cardamom bun']);
});

test('a note alone puts a cafe in the list, and clearing it removes it again', () => {
  upsertCafe(cafe('node/2', 'Noted'), { notes: 'close to work' });
  assert.ok(savedCafes().some((c) => c.id === 'node/2'));
  upsertCafe(cafe('node/2', 'Noted'), { notes: '' });
  assert.ok(!savedCafes().some((c) => c.id === 'node/2'));
});

test('visited can be turned off, and userState exposes it', () => {
  upsertCafe(cafe('node/3', 'Been'), { visited: 1 });
  assert.equal(userState()['node/3'].visited, 1);
  upsertCafe(cafe('node/3', 'Been'), { visited: 0 });
  assert.ok(!savedCafes().some((c) => c.id === 'node/3'));
});

test.after(() => { try { fs.rmSync(file, { force: true }); } catch { /* still open on Windows; harmless temp file */ } });
