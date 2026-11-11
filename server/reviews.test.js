import test from 'node:test';
import assert from 'node:assert/strict';
import { popularItems } from './reviews.js';

test('counts how many reviews mention each item, once per review', () => {
  const out = popularItems([
    { text: 'Best flat white in town! The flat white was silky and the croissants were warm.' },
    { text: 'Lovely Croissant, and the flat white was decent.' },
    { text: 'Great flat whites, friendly staff.' },
    { text: 'Nice atmosphere, good latte.' },
  ]);
  assert.deepEqual(out.slice(0, 2), [{ item: 'flat white', mentions: 3 }, { item: 'croissant', mentions: 2 }]);
  assert.ok(out.some((x) => x.item === 'latte' && x.mentions === 1));
});

test('matches whole words only and handles empty input', () => {
  assert.deepEqual(popularItems([{ text: 'The piecemeal service, cakewalk of a day' }]), []);
  assert.deepEqual(popularItems([]), []);
  assert.deepEqual(popularItems([{ text: undefined }, null]), []);
});
