import { extractFeatures, haversineKm } from './scoring.js';

const UA = { 'User-Agent': 'cafe-finder/0.1 (personal project)' };
const NOMINATIM = () => process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org'; // overridable for tests

const titleCase = (s) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// Human-readable extras that OpenStreetMap volunteers have mapped for a cafe.
export function extractDetails(t = {}) {
  const yn = (v) => (v === 'yes' ? true : v === 'no' ? false : null);
  const pay = Object.keys(t).filter((k) => k.startsWith('payment:') && t[k] === 'yes').map((k) => titleCase(k.slice(8)));
  const cuisine = (t.cuisine || '').split(';').map((c) => titleCase(c.trim())).filter(Boolean);
  const wheelchair = { yes: 'Wheelchair accessible', limited: 'Limited wheelchair access', no: 'Not wheelchair accessible' }[t.wheelchair] || null;
  const details = {
    phone: t.phone || t['contact:phone'] || null,
    email: t.email || t['contact:email'] || null,
    instagram: t['contact:instagram'] || null,
    brand: t.brand || null,
    cuisine,
    takeaway: yn(t.takeaway),
    delivery: yn(t.delivery),
    indoorSeating: yn(t.indoor_seating),
    wheelchair,
    smoking: t.smoking === 'no' ? 'Non-smoking' : t.smoking && t.smoking !== 'no' ? 'Smoking allowed' : null,
    payment: pay,
    description: t.description || null,
    diets: ['vegan', 'vegetarian', 'gluten_free', 'lactose_free', 'halal', 'kosher']
      .filter((d) => t[`diet:${d}`] === 'yes' || t[`diet:${d}`] === 'only').map(titleCase),
    toilets: yn(t.toilets),
    airConditioning: yn(t.air_conditioning),
    capacity: /^\d+$/.test(t.capacity || '') ? +t.capacity : null,
    reservation: { yes: 'Reservations accepted', required: 'Reservation required', recommended: 'Reservation recommended', no: 'No reservations' }[t.reservation] || null,
    freeWifi: t['internet_access:fee'] === 'no',
    checked: t.check_date || t['survey:date'] || null,
  };
  return details;
}

// OpenStreetMap place names are administrative ("Greater London", "Mumbai City District"), but people write "London" and
// "Mumbai". Strip the administrative words so the name can be found in headlines.
export function cleanPlace(s) {
  if (typeof s !== 'string') return null;
  const out = s.replace(/\bCity District\b/i, '').replace(/\bDistrict\b/i, '').replace(/\bMunicipal Corporation\b/i, '').replace(/\bMetropolitan\b/i, '')
    .replace(/\bUrban Agglomeration\b/i, '').replace(/\bCounty\b/i, '').replace(/^(?:Greater|City of|London Borough of|Borough of)\s+/i, '')
    .replace(/\s+/g, ' ').trim();
  return out || null;
}

/** From a Nominatim address: the main city, every place name worth matching (city, suburb, district...), and the country. */
export function placeInfo(a = {}) {
  const names = [a.city, a.town, a.village, a.municipality, a.suburb, a.county, a.state_district].map(cleanPlace).filter(Boolean);
  const cities = [...new Set(names)];
  const primary = [a.city, a.town, a.village, a.municipality, a.county, a.state_district, a.suburb].map(cleanPlace).find(Boolean) ?? null;
  return { city: primary, cities, country: a.country || null };
}

// Which city and country is a point in? Cached per ~10 km cell, and requests are spaced out
// (Nominatim's usage policy allows at most one per second).
const geoCache = new Map();
let reverseChain = Promise.resolve(), reverseLast = 0;
export function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 24 * 3600e3) return Promise.resolve(hit.value);
  const run = reverseChain.then(async () => {
    const again = geoCache.get(key); // another caller may have filled it while this one waited
    if (again) return again.value;
    const wait = reverseLast + (+process.env.REVERSE_GAP_MS || 1100) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    reverseLast = Date.now();
    const r = await fetch(`${NOMINATIM()}/reverse?format=jsonv2&zoom=10&addressdetails=1&lat=${lat}&lon=${lon}`, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`Reverse geocoding failed (${r.status})`);
    const value = placeInfo((await r.json()).address || {});
    geoCache.set(key, { at: Date.now(), value });
    if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
    return value;
  });
  reverseChain = run.catch(() => {});
  return run;
}

export async function geocode(q) {
  const r = await fetch(`${NOMINATIM()}/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: UA });
  if (!r.ok) throw new Error(`Geocoding failed (${r.status})`);
  const [hit] = await r.json();
  if (!hit) throw new Error(`Could not find "${q}"`);
  return { lat: +hit.lat, lon: +hit.lon, label: hit.display_name };
}

// Cafes from OpenStreetMap via Overpass (no API key needed).
// The public Overpass servers are free but can be slow or busy, so: ask a lighter query, hedge across
// mirrors (start the next one if the previous hasn't answered in a few seconds), and cache results.
const OVERPASS = process.env.OVERPASS_URL // overridable so tests can use a fake server
  ? [process.env.OVERPASS_URL]
  : [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
const HEDGE_MS = 3000, TIMEOUT_MS = 15000;

async function overpass(url, query) {
  const r = await fetch(url, {
    method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${new URL(url).host} returned ${r.status}`);
  return (await r.json()).elements;
}

async function overpassHedged(query) {
  const attempts = OVERPASS.map((url, i) => new Promise((resolve, reject) => {
    setTimeout(() => overpass(url, query).then(resolve, reject), i * HEDGE_MS);
  }));
  try { return await Promise.any(attempts); }
  catch (e) { throw new Error('The free OpenStreetMap servers are busy right now. Please try again in a minute. (' + e.errors.map((x) => x.message).join('; ') + ')'); }
}

// Backup when every Overpass server is down: Nominatim's search (fast, but capped at 40 results).
// It returns at most 40 results in no particular distance order, so only search the area right around you
// (up to 3 km) and trim the square search box down to a true circle.
async function nominatimCafes({ lat, lon }, radiusM) {
  const boxM = Math.min(radiusM, 3000);
  const dLat = boxM / 111000, dLon = boxM / (111000 * Math.cos((lat * Math.PI) / 180));
  const viewbox = [lon - dLon, lat + dLat, lon + dLon, lat - dLat].join(','); // left,top,right,bottom
  const r = await fetch(`${NOMINATIM()}/search?format=jsonv2&amenity=cafe&bounded=1&limit=40&extratags=1&addressdetails=1&viewbox=${viewbox}`,
    { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`nominatim returned ${r.status}`);
  return (await r.json()).filter((p) => p.osm_type && p.name && haversineKm({ lat, lon }, { lat: +p.lat, lon: +p.lon }) * 1000 <= boxM).map((p) => ({
    type: p.osm_type, id: p.osm_id, lat: +p.lat, lon: +p.lon,
    tags: {
      ...p.extratags, name: p.name,
      'addr:housenumber': p.address?.house_number, 'addr:street': p.address?.road,
      'addr:city': p.address?.city || p.address?.town || p.address?.village,
      'addr:postcode': p.address?.postcode,
    },
  }));
}

// ---- search results, with a persistent cache so repeat searches are instant and still work when the free servers are down.
// `cache` is injected (see db.js): { near(lat, lon, meters) -> entries, put(entry) }. An entry is
// { lat, lon, radiusM, partial, fetchedAt, cafes }.
const FRESH_MS = 24 * 3600e3;        // full results are reused for a day (opening hours rarely change)
const PARTIAL_FRESH_MS = 10 * 60e3;  // capped backup results are only reused briefly
const STALE_MAX_MS = 30 * 24 * 3600e3;
const REUSE_METERS = 500;            // a cached search counts as "the same place" within this distance

const distM = (a, b) => haversineKm(a, b) * 1000;
const within = (cafes, origin, radiusM) => cafes.filter((c) => distM(origin, c) <= radiusM);
const covers = (e, origin, radiusM) => distM(e, origin) + radiusM <= e.radiusM; // e's circle contains the requested circle

// Returns { cafes, partial, from: 'live'|'cache'|'stale', cachedAt, limited }.
//  partial: only the capped backup source answered.  stale: live servers failed, so older saved results are shown.
//  limited: the saved results cover a smaller area than you asked for.  refresh: skip the fresh-cache shortcut.
export async function findCafes(origin, radiusM, { cache, refresh = false } = {}) {
  const { lat, lon } = origin;
  const now = Date.now();
  const entries = cache ? cache.near(lat, lon, REUSE_METERS) : [];
  const serve = (e, from, limited = false) => ({ cafes: within(e.cafes, origin, radiusM), partial: e.partial, from, cachedAt: e.fetchedAt, limited });

  if (!refresh) {
    const fresh = entries
      .filter((e) => covers(e, origin, radiusM) && now - e.fetchedAt < (e.partial ? PARTIAL_FRESH_MS : FRESH_MS))
      .sort((a, b) => a.partial - b.partial || b.fetchedAt - a.fetchedAt)[0];
    if (fresh) return serve(fresh, 'cache');
  }

  // Old results we could fall back on: prefer complete ones that cover the request, then the biggest/newest.
  const staleOptions = entries
    .filter((e) => now - e.fetchedAt < STALE_MAX_MS)
    .sort((a, b) => a.partial - b.partial || covers(b, origin, radiusM) - covers(a, origin, radiusM) || b.radiusM - a.radiusM || b.fetchedAt - a.fetchedAt);
  const fullStale = staleOptions.find((e) => !e.partial && covers(e, origin, radiusM));

  const query = `[out:json][timeout:20];nwr["amenity"="cafe"]["name"](around:${radiusM},${lat},${lon});out center tags 400;`;
  let elements, partial = false;
  try {
    elements = await overpassHedged(query);
  } catch (overpassErr) {
    if (fullStale) return serve(fullStale, 'stale'); // a complete older result beats a capped fresh one
    try { elements = await nominatimCafes({ lat, lon }, radiusM); partial = true; }
    catch {
      if (staleOptions[0]) return serve(staleOptions[0], 'stale', !covers(staleOptions[0], origin, radiusM));
      throw overpassErr;
    }
  }
  const cafes = parseCafes(elements);
  cache?.put({ lat, lon, radiusM: partial ? Math.min(radiusM, 3000) : radiusM, partial, fetchedAt: now, cafes });
  return { cafes, partial, from: 'live', cachedAt: now, limited: false };
}

// "55 Great Eastern Street, London EC2A 3AR" (skips whatever isn't mapped)
export function formatAddress(t = {}) {
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const town = [t['addr:city'], t['addr:postcode']].filter(Boolean).join(' ');
  return [street, town].filter(Boolean).join(', ');
}

function parseCafes(elements) {
  return elements
    .filter((e) => e.tags?.name)
    .map((e) => ({
      id: `${e.type}/${e.id}`,
      name: e.tags.name,
      lat: e.lat ?? e.center.lat,
      lon: e.lon ?? e.center.lon,
      address: formatAddress(e.tags),
      hours: e.tags.opening_hours || null,
      website: e.tags.website || e.tags['contact:website'] || null,
      features: extractFeatures(e.tags),
      details: extractDetails(e.tags),
      osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}`,
    }));
}

// ---- Google Places API (New): ratings, photos, atmosphere. Needs GOOGLE_PLACES_API_KEY.
const FIELDS = [
  'id', 'displayName', 'location', 'formattedAddress', 'rating', 'userRatingCount', 'priceLevel',
  'photos', 'websiteUri', 'googleMapsUri', 'regularOpeningHours.weekdayDescriptions',
  'currentOpeningHours.openNow', 'outdoorSeating', 'allowsDogs', 'servesBreakfast', 'servesBrunch',
  'servesDessert', 'servesVegetarianFood', 'servesCoffee',
].map((f) => 'places.' + f).join(',');

const PRICE = { PRICE_LEVEL_INEXPENSIVE: '$', PRICE_LEVEL_MODERATE: '$$', PRICE_LEVEL_EXPENSIVE: '$$$', PRICE_LEVEL_VERY_EXPENSIVE: '$$$$' };

export const googleEnabled = () => !!process.env.GOOGLE_PLACES_API_KEY;

export async function findCafesGoogle({ lat, lon }, radiusM) {
  const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': FIELDS },
    body: JSON.stringify({
      includedTypes: ['cafe'], maxResultCount: 20, rankPreference: 'POPULARITY',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: Math.min(radiusM, 50000) } },
    }),
  });
  if (!r.ok) throw new Error(`Google Places error (${r.status}): ${(await r.json().catch(() => ({}))).error?.message || 'request failed'}`);
  const { places = [] } = await r.json();
  return places.map((p) => {
    const name = p.displayName?.text || '';
    return {
      id: `g/${p.id}`,
      name,
      lat: p.location.latitude,
      lon: p.location.longitude,
      address: p.formattedAddress || '',
      hours: p.regularOpeningHours?.weekdayDescriptions?.join('; ') || null,
      openNow: p.currentOpeningHours?.openNow ?? null,
      website: p.websiteUri || null,
      mapsUrl: p.googleMapsUri || null,
      rating: p.rating ?? null,
      ratingCount: p.userRatingCount ?? 0,
      price: PRICE[p.priceLevel] || null,
      photo: p.photos?.[0]?.name || null,
      features: {
        wifi: false, power: false, quiet: false,
        outdoor: !!p.outdoorSeating,
        pets: !!p.allowsDogs,
        vegan: !!p.servesVegetarianFood,
        food: !!(p.servesBreakfast || p.servesBrunch || p.servesDessert),
        specialty: /roast|specialty|coffee lab|espresso/i.test(name),
      },
    };
  });
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Are two listings (from different sources) the same physical cafe? Close together, and similar names.
export function samePlace(a, b) {
  const dLat = (a.lat - b.lat) * 111000, dLon = (a.lon - b.lon) * 111000 * Math.cos((b.lat * Math.PI) / 180);
  const meters = Math.hypot(dLat, dLon);
  const [x, y] = [norm(a.name), norm(b.name)];
  return meters < 80 && (x.includes(y) || y.includes(x) || meters < 25);
}

// Google has no wifi/outlet/quiet data; borrow it from an OSM cafe that is the same place.
export function mergeOsm(googleCafes, osmCafes) {
  return googleCafes.map((g) => {
    const match = osmCafes.find((o) => samePlace(o, g));
    if (!match) return g;
    const features = { ...g.features };
    for (const [k, v] of Object.entries(match.features)) features[k] = features[k] || v;
    return { ...g, features, hours: g.hours || match.hours };
  });
}

// Fetch a photo's bytes (the API key stays on the server).
export async function fetchPhoto(name, width = 480) {
  const r = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${width}&key=${process.env.GOOGLE_PLACES_API_KEY}`);
  if (!r.ok) throw new Error(`Photo fetch failed (${r.status})`);
  return { type: r.headers.get('content-type') || 'image/jpeg', body: Buffer.from(await r.arrayBuffer()) };
}

// Review text + editorial summary for one Google place (Places API "Place Details").
export async function fetchPlaceReviews(placeId) {
  const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': 'displayName,editorialSummary,reviews' },
  });
  if (!r.ok) throw new Error(`Google Places error (${r.status})`);
  const p = await r.json();
  const reviews = (p.reviews || [])
    .map((v) => ({ rating: v.rating, text: (v.text?.text || v.originalText?.text || '').slice(0, 1200) }))
    .filter((v) => v.text.length > 20);
  return { name: p.displayName?.text || '', editorial: p.editorialSummary?.text || '', reviews };
}

// ---- On-demand Google reviews for one cafe (the only place the Google key is used by default) ----
const GKEY = () => ({ 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'Content-Type': 'application/json' });
const GBASE = () => process.env.GOOGLE_PLACES_BASE_URL || 'https://places.googleapis.com'; // overridable for tests

async function googleError(r, what) {
  const msg = (await r.json().catch(() => ({}))).error?.message;
  return new Error(`Google ${what} failed (${r.status})${msg ? `: ${msg}` : ''}`);
}

// Find a cafe's Google place id from its name and coordinates. Returns null when nothing close enough matches.
// Requests only the id/name/location fields, which is the cheapest kind of Text Search.
export async function findGooglePlaceId({ name, lat, lon }) {
  const r = await fetch(`${GBASE()}/v1/places:searchText`, {
    method: 'POST',
    headers: { ...GKEY(), 'X-Goog-FieldMask': 'places.id,places.displayName,places.location' },
    body: JSON.stringify({
      textQuery: name, maxResultCount: 5,
      locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius: 150 } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw await googleError(r, 'listing search');
  const { places = [] } = await r.json();
  const hit = places.find((p) => samePlace({ name, lat, lon }, { name: p.displayName?.text || '', lat: p.location.latitude, lon: p.location.longitude }));
  return hit?.id ?? null;
}

const REVIEW_TTL_MS = 15 * 60 * 1000; // short in-memory cache only: Google's terms don't allow storing review content long-term
const reviewCache = new Map();

// Rating + up to 5 reviews (Google's cap) for one place id.
export async function fetchGoogleReviews(placeId) {
  const hit = reviewCache.get(placeId);
  if (hit && Date.now() < hit.expires) return hit.data;
  const r = await fetch(`${GBASE()}/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { ...GKEY(), 'X-Goog-FieldMask': 'id,displayName,rating,userRatingCount,googleMapsUri,reviews' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw await googleError(r, 'reviews lookup');
  const p = await r.json();
  const https = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);
  const data = {
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? 0,
    mapsUrl: https(p.googleMapsUri),
    reviews: (p.reviews || [])
      .map((v) => ({
        rating: v.rating ?? null,
        text: (v.text?.text || v.originalText?.text || '').trim(),
        author: v.authorAttribution?.displayName || 'A Google user',
        authorUrl: https(v.authorAttribution?.uri),
        when: v.relativePublishTimeDescription || '',
      }))
      .filter((v) => v.text),
  };
  reviewCache.set(placeId, { data, expires: Date.now() + REVIEW_TTL_MS });
  return data;
}
