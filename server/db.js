import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_WEIGHTS } from './scoring.js';

const db = new DatabaseSync(process.env.CAFE_DB || 'cafes.db');
db.exec(`
CREATE TABLE IF NOT EXISTS prefs (id INTEGER PRIMARY KEY CHECK (id = 1), weights TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vibes (id TEXT PRIMARY KEY, data TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cafes (id TEXT PRIMARY KEY, data TEXT NOT NULL, saved INTEGER DEFAULT 0, rating INTEGER, notes TEXT DEFAULT '');
`);

// Older databases don't have the "visited" column yet.
if (!db.prepare('PRAGMA table_info(cafes)').all().some((c) => c.name === 'visited')) {
  db.exec('ALTER TABLE cafes ADD COLUMN visited INTEGER DEFAULT 0');
}

export function getWeights() {
  const row = db.prepare('SELECT weights FROM prefs WHERE id = 1').get();
  return row ? { ...DEFAULT_WEIGHTS, ...JSON.parse(row.weights) } : { ...DEFAULT_WEIGHTS };
}
export function setWeights(w) {
  db.prepare('INSERT INTO prefs (id, weights) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET weights = excluded.weights').run(JSON.stringify(w));
}
export function userState() {
  const map = {};
  for (const r of db.prepare('SELECT id, saved, rating, notes, visited FROM cafes').all()) map[r.id] = r;
  return map;
}
// Fields left undefined/null are left unchanged on an existing cafe (so saving a note doesn't un-save it).
export function upsertCafe(cafe, { saved, rating, notes, visited }) {
  db.prepare(`INSERT INTO cafes (id, data, saved, rating, notes, visited) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data,
      saved = COALESCE(?, saved), rating = COALESCE(?, rating), notes = COALESCE(?, notes), visited = COALESCE(?, visited)`)
    .run(cafe.id, JSON.stringify(cafe), saved ?? 0, rating ?? null, notes ?? '', visited ?? 0,
      saved ?? null, rating ?? null, notes ?? null, visited ?? null);
}
export function savedCafes() {
  return db.prepare(`SELECT data, saved, rating, notes, visited FROM cafes WHERE saved = 1 OR rating IS NOT NULL OR visited = 1 OR notes <> ''`).all()
    .map((r) => ({ ...JSON.parse(r.data), saved: !!r.saved, userRating: r.rating, notes: r.notes, visited: !!r.visited }));
}

export function getVibe(id) {
  const r = db.prepare('SELECT data FROM vibes WHERE id = ?').get(id);
  return r ? JSON.parse(r.data) : null;
}
export function setVibe(id, vibe) {
  db.prepare('INSERT INTO vibes (id, data, created) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, created = excluded.created')
    .run(id, JSON.stringify(vibe), Date.now());
}
export function allVibes() {
  const map = {};
  for (const r of db.prepare('SELECT id, data FROM vibes').all()) map[r.id] = JSON.parse(r.data);
  return map;
}

// Place ids may be stored (unlike review text), so we only look a cafe up on Google once.
db.exec('CREATE TABLE IF NOT EXISTS placeids (cafe_id TEXT PRIMARY KEY, place_id TEXT NOT NULL)');
export function getPlaceId(cafeId) {
  return db.prepare('SELECT place_id FROM placeids WHERE cafe_id = ?').get(cafeId)?.place_id ?? null;
}
export function setPlaceId(cafeId, placeId) {
  db.prepare('INSERT INTO placeids (cafe_id, place_id) VALUES (?, ?) ON CONFLICT(cafe_id) DO UPDATE SET place_id = excluded.place_id').run(cafeId, placeId);
}

// ---- persistent search cache (see findCafes in sources.js) ----
db.exec(`
CREATE TABLE IF NOT EXISTS search_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT, lat REAL NOT NULL, lon REAL NOT NULL, radius_m INTEGER NOT NULL,
  partial INTEGER NOT NULL, fetched_at INTEGER NOT NULL, cafes TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS search_cache_lat ON search_cache (lat);
`);
const MAX_CACHE_ENTRIES = 60; // each holds up to a few hundred cafes

export const searchCache = {
  near(lat, lon, meters) {
    const dLat = meters / 111000, dLon = meters / (111000 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    return db.prepare('SELECT lat, lon, radius_m, partial, fetched_at, cafes FROM search_cache WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?')
      .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon)
      .map((r) => ({ lat: r.lat, lon: r.lon, radiusM: r.radius_m, partial: !!r.partial, fetchedAt: r.fetched_at, cafes: JSON.parse(r.cafes) }));
  },
  put({ lat, lon, radiusM, partial, fetchedAt, cafes }) {
    // a new result for the same spot replaces older ones that covered no more area
    db.prepare('DELETE FROM search_cache WHERE ABS(lat - ?) < 0.001 AND ABS(lon - ?) < 0.001 AND radius_m <= ?').run(lat, lon, radiusM);
    db.prepare('INSERT INTO search_cache (lat, lon, radius_m, partial, fetched_at, cafes) VALUES (?, ?, ?, ?, ?, ?)')
      .run(lat, lon, radiusM, +!!partial, fetchedAt, JSON.stringify(cafes));
    db.prepare('DELETE FROM search_cache WHERE id NOT IN (SELECT id FROM search_cache ORDER BY fetched_at DESC LIMIT ?)').run(MAX_CACHE_ENTRIES);
  },
};

// ---- backup import: all-or-nothing ----
export function importRows(rows, mentionData = {}) {
  db.exec('BEGIN');
  try {
    for (const r of rows) upsertCafe(r.cafe, { saved: +!!r.saved, rating: r.rating ?? null, notes: r.notes ?? '', visited: +!!r.visited });
    importMentionData(mentionData);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- details read from cafes' own websites (see enrich.js) ----
db.exec('CREATE TABLE IF NOT EXISTS enrichment (cafe_id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT, url TEXT, fetched_at INTEGER NOT NULL)');
const DAY = 24 * 3600e3;
const ENRICH_TTL = { ok: 30 * DAY, none: 14 * DAY, blocked: 30 * DAY, error: DAY }; // failures are retried sooner
db.prepare('DELETE FROM enrichment WHERE fetched_at < ?').run(Date.now() - 90 * DAY);

export function saveEnrichment(id, status, data, url) {
  db.prepare('INSERT INTO enrichment (cafe_id, status, data, url, fetched_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(cafe_id) DO UPDATE SET status = excluded.status, data = excluded.data, url = excluded.url, fetched_at = excluded.fetched_at')
    .run(id, status, data ? JSON.stringify(data) : null, url ?? null, Date.now());
}
/** Is there a recent result (of any kind) for this cafe, so it needn't be fetched again? */
export function hasFreshEnrichment(id) {
  const r = db.prepare('SELECT status, fetched_at FROM enrichment WHERE cafe_id = ?').get(id);
  return !!r && Date.now() - r.fetched_at < (ENRICH_TTL[r.status] ?? DAY);
}
/** id -> { data, url, fetchedAt } for every cafe with usable website data. */
export function enrichmentMap() {
  const map = new Map();
  for (const r of db.prepare(`SELECT cafe_id, data, url, fetched_at FROM enrichment WHERE status = 'ok' AND fetched_at > ?`).all(Date.now() - ENRICH_TTL.ok)) {
    try { map.set(r.cafe_id, { data: JSON.parse(r.data), url: r.url, fetchedAt: r.fetched_at }); } catch { /* skip a corrupt row */ }
  }
  return map;
}

// ---- press & mentions (see mentions.js) ----
db.exec(`
CREATE TABLE IF NOT EXISTS mentions_cache (cafe_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (cafe_id, kind));
CREATE TABLE IF NOT EXISTS cafe_links (id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id TEXT NOT NULL, platform TEXT NOT NULL, ref TEXT NOT NULL, title TEXT, added_at INTEGER NOT NULL, UNIQUE (cafe_id, platform, ref));
CREATE INDEX IF NOT EXISTS cafe_links_cafe ON cafe_links (cafe_id);
CREATE TABLE IF NOT EXISTS hidden_mentions (cafe_id TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY (cafe_id, url));
`);
const MAX_LINKS_PER_CAFE = 20, MAX_LINKS_TOTAL = 2000;

/** Saved lookup results (already filtered for relevance), or null when missing or older than maxAgeMs. */
export function getMentionsCache(cafeId, kind, maxAgeMs) {
  const r = db.prepare('SELECT data, fetched_at FROM mentions_cache WHERE cafe_id = ? AND kind = ?').get(cafeId, kind);
  if (!r || Date.now() - r.fetched_at > maxAgeMs) return null;
  try { return JSON.parse(r.data); } catch { return null; }
}
export function putMentionsCache(cafeId, kind, data) {
  db.prepare('INSERT INTO mentions_cache (cafe_id, kind, data, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(cafe_id, kind) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at')
    .run(cafeId, kind, JSON.stringify(data), Date.now());
  db.prepare('DELETE FROM mentions_cache WHERE fetched_at < ?').run(Date.now() - 30 * 24 * 3600e3);
}

export const linksFor = (cafeId) => db.prepare('SELECT id, platform, ref, title FROM cafe_links WHERE cafe_id = ? ORDER BY id').all(cafeId);
export const allLinks = () => db.prepare('SELECT cafe_id AS cafeId, platform, ref, title FROM cafe_links ORDER BY id').all();

/** @returns {{id:number}|{error:string}} */
export function addLink(cafeId, platform, ref, title) {
  const existing = db.prepare('SELECT id FROM cafe_links WHERE cafe_id = ? AND platform = ? AND ref = ?').get(cafeId, platform, ref);
  if (existing) return { id: existing.id, duplicate: true };
  if (db.prepare('SELECT COUNT(*) AS n FROM cafe_links WHERE cafe_id = ?').get(cafeId).n >= MAX_LINKS_PER_CAFE) return { error: `You can add up to ${MAX_LINKS_PER_CAFE} links per cafe.` };
  if (db.prepare('SELECT COUNT(*) AS n FROM cafe_links').get().n >= MAX_LINKS_TOTAL) return { error: 'The link list is full.' };
  const r = db.prepare('INSERT INTO cafe_links (cafe_id, platform, ref, title, added_at) VALUES (?, ?, ?, ?, ?)').run(cafeId, platform, ref, title ?? null, Date.now());
  return { id: Number(r.lastInsertRowid) };
}
export const deleteLink = (id) => db.prepare('DELETE FROM cafe_links WHERE id = ?').run(id).changes > 0;

export const hideMention = (cafeId, url) => db.prepare('INSERT OR IGNORE INTO hidden_mentions (cafe_id, url) VALUES (?, ?)').run(cafeId, url);
export const hiddenFor = (cafeId) => new Set(db.prepare('SELECT url FROM hidden_mentions WHERE cafe_id = ?').all(cafeId).map((r) => r.url));
export const allHidden = () => db.prepare('SELECT cafe_id AS cafeId, url FROM hidden_mentions').all();

/** Restore links/hidden entries from a backup (called inside the import transaction). */
export function importMentionData({ links = [], hidden = [] }) {
  for (const l of links) db.prepare('INSERT OR IGNORE INTO cafe_links (cafe_id, platform, ref, title, added_at) VALUES (?, ?, ?, ?, ?)').run(l.cafeId, l.platform, l.ref, l.title ?? null, Date.now());
  for (const h of hidden) db.prepare('INSERT OR IGNORE INTO hidden_mentions (cafe_id, url) VALUES (?, ?)').run(h.cafeId, h.url);
}
