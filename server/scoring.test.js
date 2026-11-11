import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFeatures, scoreCafe, learnWeights, DEFAULT_WEIGHTS } from './scoring.js';

const origin = { lat: 0, lon: 0 };
const mk = (tags, lat = 0, lon = 0) => ({ lat, lon, features: extractFeatures(tags) });

test('extracts features from OSM tags', () => {
  const f = extractFeatures({ name: 'Blue Roasters', internet_access: 'wlan', outdoor_seating: 'yes' });
  assert.ok(f.wifi && f.outdoor && f.specialty && !f.pets);
});

test('cafe matching preferences outranks one that does not', () => {
  const w = { ...DEFAULT_WEIGHTS, wifi: 5, outdoor: 3 };
  const good = scoreCafe(mk({ internet_access: 'wlan', outdoor_seating: 'yes' }), w, origin);
  const bad = scoreCafe(mk({}), w, origin);
  assert.ok(good.score > bad.score);
});

test('closer cafe scores higher, all else equal', () => {
  const w = { ...DEFAULT_WEIGHTS, wifi: 5 };
  const near = scoreCafe(mk({ internet_access: 'wlan' }, 0.001), w, origin);
  const far = scoreCafe(mk({ internet_access: 'wlan' }, 0.015), w, origin);
  assert.ok(near.score > far.score);
});

test('high rating raises weights of present features, low rating lowers them', () => {
  const feats = extractFeatures({ internet_access: 'wlan' });
  assert.ok(learnWeights(DEFAULT_WEIGHTS, feats, 5).wifi > 0);
  assert.ok(learnWeights(DEFAULT_WEIGHTS, feats, 1).wifi < 0);
  assert.equal(learnWeights(DEFAULT_WEIGHTS, feats, 5).outdoor, 0);
});

test('well-reviewed cafe outranks poorly reviewed one, all else equal', () => {
  const w = { ...DEFAULT_WEIGHTS, wifi: 5 };
  const base = mk({ internet_access: 'wlan' });
  const good = scoreCafe({ ...base, rating: 4.8, ratingCount: 400 }, w, origin);
  const poor = scoreCafe({ ...base, rating: 3.2, ratingCount: 400 }, w, origin);
  assert.ok(good.score > poor.score);
});

import { vibeFeatures, VibeSchema } from './vibe.js';

test('vibe scores map to taste features at a threshold of 7', () => {
  const f = vibeFeatures({ scores: { cozy: 8, aesthetic: 6, lively: 2, quiet: 9, laptop_friendly: 7 } });
  assert.deepEqual(f, { cozy: true, aesthetic: false, lively: false, quiet: true, laptop: true });
  assert.deepEqual(vibeFeatures(null), {});
});

test('a cozy cafe outranks a non-cozy one for a user who wants cozy', () => {
  const w = { ...DEFAULT_WEIGHTS, cozy: 5 };
  const cozy = { lat: 0, lon: 0, features: { ...extractFeatures({}), ...vibeFeatures({ scores: { cozy: 9, aesthetic: 0, lively: 0, quiet: 0, laptop_friendly: 0 } }) } };
  assert.ok(scoreCafe(cozy, w, { lat: 0, lon: 0 }).score > scoreCafe({ lat: 0, lon: 0, features: extractFeatures({}) }, w, { lat: 0, lon: 0 }).score);
});

test('vibe schema rejects malformed model output', () => {
  assert.equal(VibeSchema.safeParse({ summary: 'x' }).success, false);
});

import { extractDetails } from './sources.js';

test('extracts readable details from OSM tags', () => {
  const d = extractDetails({ phone: '+44 20 1234', takeaway: 'yes', wheelchair: 'limited', cuisine: 'coffee_shop;cake', 'payment:visa': 'yes', 'payment:cash': 'no', smoking: 'no' });
  assert.equal(d.phone, '+44 20 1234');
  assert.equal(d.takeaway, true);
  assert.equal(d.delivery, null);
  assert.deepEqual(d.cuisine, ['Coffee shop', 'Cake']);
  assert.deepEqual(d.payment, ['Visa']);
  assert.equal(d.wheelchair, 'Limited wheelchair access');
  assert.equal(d.smoking, 'Non-smoking');
});
