import { FEATURES } from './scoring.js';
import { validRef } from './mentions.js';

// Everything that comes from outside (an imported file, or the browser) is treated as untrusted:
// it is rebuilt field by field with type checks, never stored as-is.

const ID_RE = /^(node|way|relation|g)\/[\w-]{1,80}$/;
const MAX_CAFES = 5000, MAX_LINKS = 2000, MAX_HIDDEN = 5000;
export const isCafeId = (id) => typeof id === 'string' && ID_RE.test(id);

const str = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const num = (v, min, max) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
const https = (v) => (typeof v === 'string' && v.length <= 500 && v.startsWith('https://') ? v : null);
const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 60)) : []);
const tri = (v) => (typeof v === 'boolean' ? v : null);

function cleanDetails(d) {
  if (!d || typeof d !== 'object') return {};
  return {
    phone: str(d.phone, 40), email: str(d.email, 120), instagram: str(d.instagram, 200), brand: str(d.brand, 80),
    description: str(d.description, 500), checked: str(d.checked, 30), wheelchair: str(d.wheelchair, 60),
    smoking: str(d.smoking, 40), reservation: str(d.reservation, 60),
    cuisine: strList(d.cuisine), payment: strList(d.payment), diets: strList(d.diets),
    takeaway: tri(d.takeaway), delivery: tri(d.delivery), indoorSeating: tri(d.indoorSeating),
    toilets: tri(d.toilets), airConditioning: tri(d.airConditioning), freeWifi: d.freeWifi === true,
    capacity: Number.isInteger(d.capacity) ? num(d.capacity, 0, 100000) : null,
  };
}

/** Rebuild a cafe object from untrusted input. Returns null when it isn't a usable cafe. */
export function sanitizeCafe(c) {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !ID_RE.test(c.id)) return null;
  const name = str(c.name, 200), lat = num(Number(c.lat), -90, 90), lon = num(Number(c.lon), -180, 180);
  if (!name || lat == null || lon == null) return null;
  const features = {};
  for (const f of FEATURES) features[f] = c.features?.[f] === true;
  return {
    id: c.id, name, lat, lon,
    address: str(c.address, 300) ?? '', hours: str(c.hours, 500), website: str(c.website, 300),
    features, details: cleanDetails(c.details),
    osmUrl: typeof c.osmUrl === 'string' && c.osmUrl.startsWith('https://www.openstreetmap.org/') ? c.osmUrl.slice(0, 200) : null,
    ...(Number.isInteger(c.ratingCount) && num(c.rating, 0, 5) != null ? { rating: c.rating, ratingCount: num(c.ratingCount, 0, 1e9) } : { rating: null, ratingCount: null }),
    price: str(c.price, 4), photo: typeof c.photo === 'string' && /^places\/[\w-]+\/photos\/[\w-]+$/.test(c.photo) ? c.photo : null,
    mapsUrl: https(c.mapsUrl),
  };
}

/** What gets written to a backup file. `rows` are the cafes in "My list" (see savedCafes in db.js). */
export function buildBackup(rows, weights, now = new Date(), { links = [], hidden = [] } = {}) {
  return {
    app: 'cafe-finder', version: 1, exportedAt: now.toISOString(), weights,
    links, hidden, // pasted articles/reels and hidden mentions (optional in the file; older backups don't have them)
    // `rating` (inside the cafe) is Google's star rating; `userRating` is yours.
    cafes: rows.map((r) => ({ ...sanitizeCafe(r), saved: !!r.saved, visited: !!r.visited, userRating: r.userRating ?? null, notes: r.notes ?? '' })),
  };
}

/** Validate an uploaded backup. Throws an Error with a user-friendly message when it can't be used. */
export function parseBackup(obj) {
  if (!obj || typeof obj !== 'object' || obj.app !== 'cafe-finder') throw new Error('This doesn’t look like a Cafe Finder backup file.');
  if (obj.version !== 1) throw new Error(`Unsupported backup version (${String(obj.version).slice(0, 10)}).`);
  if (!Array.isArray(obj.cafes)) throw new Error('The backup has no cafe list.');
  if (obj.cafes.length > MAX_CAFES) throw new Error(`Too many cafes (limit ${MAX_CAFES}).`);

  const rows = [];
  let skipped = 0;
  for (const raw of obj.cafes) {
    const cafe = sanitizeCafe(raw);
    if (!cafe) { skipped++; continue; }
    const rating = Number.isInteger(raw.userRating) && raw.userRating >= 1 && raw.userRating <= 5 ? raw.userRating : null;
    rows.push({ cafe, saved: raw.saved === true, visited: raw.visited === true, rating, notes: typeof raw.notes === 'string' ? raw.notes.slice(0, 1000) : '' });
  }
  let weights = null;
  if (obj.weights && typeof obj.weights === 'object') {
    weights = {};
    for (const f of FEATURES) {
      const v = Number(obj.weights[f]);
      weights[f] = Number.isFinite(v) ? Math.max(-5, Math.min(5, v)) : 0;
    }
  }
  // optional extras: links people pasted onto cafes, and mentions they hid. Rebuilt field by field like everything else.
  const links = [], hidden = [];
  for (const l of Array.isArray(obj.links) ? obj.links.slice(0, MAX_LINKS) : []) {
    if (l && isCafeId(l.cafeId) && ['youtube', 'instagram', 'article'].includes(l.platform) && validRef(l.platform, l.ref)) {
      links.push({ cafeId: l.cafeId, platform: l.platform, ref: l.ref, title: str(l.title, 150) });
    } else skipped++;
  }
  for (const h of Array.isArray(obj.hidden) ? obj.hidden.slice(0, MAX_HIDDEN) : []) {
    if (h && isCafeId(h.cafeId) && https(h.url)) hidden.push({ cafeId: h.cafeId, url: h.url });
    else skipped++;
  }
  return { rows, weights, skipped, links, hidden };
}

// ---- spreadsheet / Google Maps exports ----
export function statusOf(r) {
  return [r.visited && 'Been here', r.saved && 'Want to go'].filter(Boolean).join(' + ') || (r.userRating ? 'Rated' : 'Noted');
}

// Spreadsheet apps run cells that start with = + - @ as formulas, so defuse those (but keep phone numbers readable).
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=@\t\r]/.test(s) || (/^[+-]/.test(s) && !/^[+-][\d\s().-]+$/.test(s))) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const head = ['Name', 'Address', 'Latitude', 'Longitude', 'Status', 'Rating', 'Notes', 'Website', 'Phone'];
  const lines = rows.map((r) => [r.name, r.address, r.lat, r.lon, statusOf(r), r.userRating ?? '', r.notes ?? '', r.website ?? '', r.details?.phone ?? ''].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

// KML opens in Google My Maps (Create a map -> Import) and Google Earth.
export function toKml(rows, title = 'Cafe Finder') {
  const marks = rows.map((r) => {
    const desc = [r.address, statusOf(r), r.userRating ? `Rating: ${r.userRating}/5` : '', r.notes, r.website].filter(Boolean).join('\n');
    return `  <Placemark><name>${xml(r.name)}</name><description>${xml(desc)}</description><Point><coordinates>${r.lon},${r.lat},0</coordinates></Point></Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>\n  <name>${xml(title)}</name>\n${marks.join('\n')}\n</Document></kml>\n`;
}
