import test from 'node:test';
import assert from 'node:assert/strict';
import { openStatus } from './hours.js';

const london = { lat: 51.5266, lon: -0.0799 };
const tokyo = { lat: 35.68, lon: 139.69 };
const H = 'Mo-Fr 08:00-16:00; Sa-Su 09:00-17:00';

test('open now shows when it closes (cafe-local time)', () => {
  // Friday 6 Nov 2026, 10:00 UTC = 10:00 in London (GMT)
  assert.deepEqual(openStatus(H, london, new Date('2026-11-06T10:00:00Z')), { state: 'open', label: 'Open · closes 16:00' });
});

test('closed in the evening shows the next opening, including the day', () => {
  assert.deepEqual(openStatus(H, london, new Date('2026-11-06T17:00:00Z')), { state: 'closed', label: 'Closed · opens tomorrow 09:00' });
  assert.deepEqual(openStatus(H, london, new Date('2026-11-06T05:00:00Z')), { state: 'closed', label: 'Closed · opens 08:00' });
});

test('uses the cafe timezone, not the server timezone', () => {
  // 02:00 UTC = 11:00 in Tokyo, so a 10:00-20:00 cafe there is open; the same instant in London is 02:00 (closed)
  const tokyoOpen = openStatus('Mo-Su 10:00-20:00', tokyo, new Date('2026-11-06T02:00:00Z'));
  assert.equal(tokyoOpen.state, 'open');
  assert.equal(tokyoOpen.label, 'Open · closes 20:00');
  assert.equal(openStatus('Mo-Su 10:00-20:00', london, new Date('2026-11-06T02:00:00Z')).state, 'closed');
});

test('24/7 and unusable values', () => {
  assert.deepEqual(openStatus('24/7', london, new Date('2026-11-06T10:00:00Z')), { state: 'open', label: 'Open 24/7' });
  assert.equal(openStatus('not hours at all', london).state, 'unknown');
  assert.equal(openStatus(null, london).state, 'unknown');
});

import { formatAddress, extractDetails } from './sources.js';

test('formats addresses without dangling pieces', () => {
  assert.equal(formatAddress({ 'addr:housenumber': '55', 'addr:street': 'Great Eastern Street', 'addr:city': 'London', 'addr:postcode': 'EC2A 3AR' }), '55 Great Eastern Street, London EC2A 3AR');
  assert.equal(formatAddress({ 'addr:street': 'High Street' }), 'High Street');
  assert.equal(formatAddress({}), '');
});

test('extracts facilities and dietary details', () => {
  const d = extractDetails({ toilets: 'yes', air_conditioning: 'yes', capacity: '40', reservation: 'recommended', 'diet:gluten_free': 'yes', 'diet:vegan': 'only', 'internet_access:fee': 'no', check_date: '2026-03-02' });
  assert.equal(d.toilets, true); assert.equal(d.airConditioning, true); assert.equal(d.capacity, 40);
  assert.equal(d.reservation, 'Reservation recommended'); assert.equal(d.freeWifi, true); assert.equal(d.checked, '2026-03-02');
  assert.deepEqual(d.diets, ['Vegan', 'Gluten free']);
  assert.equal(extractDetails({ capacity: 'lots' }).capacity, null);
});

import { parseWall } from './hours.js';

test('flags cafes that close or open within the hour', () => {
  // Friday 15:30 in London, closes 16:00
  assert.deepEqual(openStatus(H, london, new Date('2026-11-06T15:30:00Z')), { state: 'open', label: 'Open · closes in 30 min', soon: true });
  // Friday 07:30, opens 08:00
  assert.deepEqual(openStatus(H, london, new Date('2026-11-06T07:30:00Z')), { state: 'closed', label: 'Closed · opens in 30 min', soon: true });
  // plenty of time left: no "soon" flag
  assert.equal(openStatus(H, london, new Date('2026-11-06T10:00:00Z')).soon, undefined);
});

test('can check a chosen future time (cafe-local wall clock)', () => {
  const sat8pm = parseWall('2026-11-07T20:00');
  assert.deepEqual(openStatus(H, london, new Date(), sat8pm), { state: 'closed', label: 'Closed · opens tomorrow 09:00' });
  assert.deepEqual(openStatus(H, london, new Date(), parseWall('2026-11-07T10:30')), { state: 'open', label: 'Open · closes 17:00' });
});

test('parseWall accepts only the picker format', () => {
  assert.ok(parseWall('2026-11-07T20:00') instanceof Date);
  for (const bad of ['', null, undefined, '2026-11-07', '2026-11-07 20:00', 'tomorrow', '2026-13-45T99:99']) assert.equal(parseWall(bad), null);
});
