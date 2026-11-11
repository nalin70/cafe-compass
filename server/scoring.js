// Taste features a cafe can have, derived from OpenStreetMap tags.
export const FEATURES = ['wifi', 'power', 'outdoor', 'pets', 'vegan', 'specialty', 'food', 'quiet', 'cozy', 'aesthetic', 'lively', 'laptop'];
// cozy/aesthetic/lively/laptop come only from the LLM vibe analysis (server/vibe.js); quiet can come from OSM or vibe.

export const DEFAULT_WEIGHTS = Object.fromEntries(FEATURES.map((f) => [f, 0]));

export function extractFeatures(tags = {}) {
  const name = (tags.name || '').toLowerCase();
  const cuisine = (tags.cuisine || '').toLowerCase();
  const yes = (v) => v === 'yes' || v === 'wlan' || v === 'wired';
  return {
    wifi: yes(tags.internet_access) || tags['internet_access:fee'] === 'no',
    power: yes(tags.power_supply),
    outdoor: yes(tags.outdoor_seating),
    pets: yes(tags.dog) || yes(tags.pets),
    vegan: yes(tags['diet:vegan']) || yes(tags['diet:vegetarian']),
    specialty: /roast|specialty|coffee_shop|espresso/.test(cuisine) || /roast|specialty|coffee lab/.test(name),
    food: /bakery|breakfast|brunch|sandwich|cake|pastry/.test(cuisine) || tags['diet:vegan'] !== undefined || yes(tags.food),
    quiet: tags.noise_level === 'low' || tags.quiet === 'yes',
  };
}

export function haversineKm(a, b) {
  const R = 6371, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Returns { score 0-100, reasons[] }. Weights are -5..5 per feature.
export function scoreCafe(cafe, weights, origin, radiusKm = 2, userRating = null) {
  const feats = cafe.features;
  let gained = 0, possible = 0;
  const reasons = [];
  for (const f of FEATURES) {
    const w = weights[f] || 0;
    if (w > 0) {
      possible += w;
      if (feats[f]) { gained += w; reasons.push(`Has ${f}`); }
      else if (w >= 3) reasons.push(`No ${f} info`);
    } else if (w < 0 && feats[f]) {
      gained += w; // penalty for things the user dislikes
      reasons.push(`Has ${f} (you avoid this)`);
    }
  }
  let score = possible > 0 ? (Math.max(gained, 0) / possible) * 70 : 35;
  const dist = haversineKm(origin, cafe);
  score += 15 * Math.max(0, 1 - dist / radiusKm); // up to 15 for being close
  // Up to 15 for Google rating (3.0 -> 0, 5.0 -> full), trusted more with more reviews; neutral if unrated.
  if (cafe.rating != null) {
    const trust = Math.min(1, (cafe.ratingCount || 0) / 50);
    score += 15 * (0.5 * (1 - trust) + trust * Math.max(0, Math.min(1, (cafe.rating - 3) / 2)));
    if (cafe.rating >= 4.5 && trust >= 0.5) reasons.push(`Highly rated (${cafe.rating})`);
  } else score += 7.5;
  if (dist < 0.4) reasons.push('Very close');
  if (userRating != null) { score += (userRating - 3) * 5; reasons.push(`You rated it ${userRating}/5`); }
  return { score: Math.round(Math.max(0, Math.min(100, score))), reasons, distanceKm: dist };
}

// Nudge weights toward features present in cafes the user liked (rating > 3) and away from disliked ones.
export function learnWeights(weights, features, rating, rate = 0.5) {
  const next = { ...weights };
  const delta = (rating - 3) * rate; // -1..+1
  for (const f of FEATURES) {
    if (features[f]) next[f] = Math.max(-5, Math.min(5, +((next[f] || 0) + delta).toFixed(2)));
  }
  return next;
}
