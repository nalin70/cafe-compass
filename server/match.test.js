import test from 'node:test';
import assert from 'node:assert/strict';
import { samePlace, mergeOsm } from './sources.js';

const at = (name, lat, lon = 0) => ({ name, lat, lon });

test('same name nearby matches; different name 50 m apart does not', () => {
  assert.ok(samePlace(at('Blue Bottle Coffee', 0), at('Blue Bottle', 0.0003)));
  assert.ok(!samePlace(at('Blue Bottle', 0), at('Stumptown', 0.00045)));
});

test('non-Latin names are compared, not treated as empty', () => {
  // ~50 m apart, different Japanese names: must NOT be the same place.
  assert.ok(!samePlace(at('猿田彦珈琲', 0), at('ブルーボトルコーヒー', 0.00045)));
  assert.ok(samePlace(at('猿田彦珈琲 恵比寿', 0), at('猿田彦珈琲', 0.00045)));
  assert.ok(!samePlace(at('مقهى النخيل', 0), at('مقهى الورد', 0.00045)));
});

test('accents are ignored when comparing names', () => {
  assert.ok(samePlace(at('Café Léon', 0), at('Cafe Leon', 0.00045)));
});

test('an empty name never matches by name alone, only when very close', () => {
  assert.ok(!samePlace(at('', 0), at('Anything', 0.00045)));
  assert.ok(samePlace(at('', 0), at('Anything', 0.0001)));
});

test('mergeOsm does not borrow features from a differently named neighbour', () => {
  const g = [{ ...at('猿田彦珈琲', 0), features: { wifi: false } }];
  const o = [{ ...at('ブルーボトルコーヒー', 0.00045), features: { wifi: true } }];
  assert.equal(mergeOsm(g, o)[0].features.wifi, false);
});
