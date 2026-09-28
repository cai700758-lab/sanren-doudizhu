import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, classify, beats, findHint } from '../lib/game.js';
function cards(ranks) {
  const deck = makeDeck();
  return ranks.map(rank => { const index = deck.findIndex(c => c.rank === rank); assert.notEqual(index, -1); return deck.splice(index, 1)[0]; });
}
const examples = [
  ['single', [3]], ['pair', [4, 4]], ['triple', [5, 5, 5]],
  ['tripleSingle', [6, 6, 6, 3]], ['triplePair', [6, 6, 6, 3, 3]],
  ['straight', [3, 4, 5, 6, 7]], ['pairStraight', [3, 3, 4, 4, 5, 5]],
  ['airplane', [3, 3, 3, 4, 4, 4]], ['airplaneSingle', [3, 3, 3, 4, 4, 4, 7, 8]],
  ['airplaneSingle', [3, 3, 3, 4, 4, 4, 7, 7]],
  ['airplanePair', [3, 3, 3, 4, 4, 4, 7, 7, 8, 8]],
  ['fourSingle', [3, 3, 3, 3, 7, 8]], ['fourSingle', [3, 3, 3, 3, 7, 7]],
  ['fourPair', [3, 3, 3, 3, 7, 7, 8, 8]], ['bomb', [9, 9, 9, 9]], ['rocket', [16, 17]],
];
test('54 unique cards, 13 ranks and two jokers', () => {
  const deck = makeDeck(); assert.equal(deck.length, 54); assert.equal(new Set(deck.map(c => c.id)).size, 54);
  for (let rank = 3; rank <= 15; rank++) assert.equal(deck.filter(c => c.rank === rank).length, 4);
});
for (const [type, ranks] of examples) test(`recognizes ${type}: ${ranks}`, () => assert.equal(classify(cards(ranks))?.type, type));
test('rejects malformed shapes, 2 in runs, reused body wings and forbidden attachments', () => {
  for (const ranks of [[], [3, 4], [3, 4, 5, 6], [11, 12, 13, 14, 15], [3, 3, 5, 5, 6, 6], [3, 3, 3, 3, 4, 4, 4, 7], [3, 3, 3, 4, 4, 4, 16, 17], [3, 3, 3, 3, 16, 17], [3, 3, 3, 3, 4, 4, 4, 4]]) assert.equal(classify(cards(ranks)), null, `${ranks}`);
  const card = makeDeck()[0]; assert.equal(classify([card, card]), null);
});
test('comparison requires matching shape and size; bombs and rocket override', () => {
  const c = ranks => classify(cards(ranks));
  assert.equal(beats(c([4]), c([3])), true);
  assert.equal(beats(c([4, 4]), c([3])), false);
  assert.equal(beats(c([4, 5, 6, 7, 8, 9]), c([3, 4, 5, 6, 7])), false);
  assert.equal(beats(c([3, 3, 3, 3]), c([17])), true);
  assert.equal(beats(c([16, 17]), c([15, 15, 15, 15])), true);
  assert.equal(beats(c([15, 15, 15, 15]), c([16, 17])), false);
  assert.equal(beats(c([3]), c([3])), false);
  assert.equal(beats(null, null), false);
});
test('hints find higher examples of every shape', () => {
  for (const [type, ranks] of examples.filter(([type]) => type !== 'rocket')) {
    const target = classify(cards(ranks));
    const hand = cards(ranks.map(r => r + 1));
    const hint = findHint(hand, target);
    assert.ok(hint, type); assert.ok(beats(classify(hint), target), type);
  }
  assert.equal(findHint(cards([3, 4, 5]), classify(cards([17]))), null);
  assert.deepEqual(findHint(cards([3, 5, 7])).map(c => c.rank), [3]);
});
test('hint existence matches exhaustive subset search on 40 varied hands', () => {
  let seed = 127;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 40; round++) {
    const deck = makeDeck();
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const hand = deck.slice(0, 12);
    const target = classify(cards(examples[round % examples.length][1]));
    let exists = false;
    for (let mask = 1; mask < 2 ** hand.length; mask++) {
      const subset = hand.filter((_, i) => mask & (1 << i));
      if (![target.size, 2, 4].includes(subset.length)) continue;
      if (beats(classify(subset), target)) { exists = true; break; }
    }
    const hint = findHint(hand, target);
    assert.equal(Boolean(hint), exists, `round ${round}, ${target.type}`);
    if (hint) assert.ok(beats(classify(hint), target));
  }
});
