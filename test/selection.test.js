import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDeck, classify, beats, findClosestSelection } from '../lib/game.js';

function cards(ranks) {
  const deck = makeDeck();
  return ranks.map(rank => deck.splice(deck.findIndex(card => card.rank === rank), 1)[0]);
}
test('selection repair retains the largest straight, pair chain and airplane variants', () => {
  for (const [ranks, type, size] of [
    [[3, 4, 4, 5, 6, 7], 'straight', 5],
    [[3, 3, 4, 4, 5, 5, 8], 'pairStraight', 6],
    [[3, 3, 3, 4, 4, 4, 5], 'airplane', 6],
    [[3, 3, 3, 4, 4, 4, 7, 8, 15], 'airplaneSingle', 8],
    [[3, 3, 3, 4, 4, 4, 7, 7, 8, 8, 15], 'airplanePair', 10],
    [[3, 3, 3, 4, 4, 4, 7, 7, 7, 7], 'airplaneSingle', 8],
  ]) {
    const selected = cards(ranks), result = findClosestSelection(selected);
    assert.equal(result.length, size); assert.equal(classify(result).type, type);
    assert.ok(result.every(card => selected.some(original => original.id === card.id)));
  }
});
test('repair follows the current trick and never silently adds cards', () => {
  const pair = findClosestSelection(cards([3, 3, 8, 8, 12]), classify(cards([6, 6])));
  assert.deepEqual(pair.map(card => card.rank), [8, 8]);
  const run = findClosestSelection(cards([4, 5, 6, 7, 8, 9]), classify(cards([3, 4, 5, 6, 7])));
  assert.deepEqual(run.map(card => card.rank), [4, 5, 6, 7, 8]);
  assert.equal(findClosestSelection(cards([3, 4, 4, 5, 6, 7]), classify(cards([16, 17]))), null);
  const valid = cards([7, 7, 7, 5]);
  assert.deepEqual(findClosestSelection(valid), valid);
  assert.equal(findClosestSelection([valid[0], valid[0]]), null);
});
test('maximum retained size matches exhaustive subsets of varied selections', () => {
  let seed = 71029;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const targets = [null, classify(cards([6])), classify(cards([5, 5])), classify(cards([3, 4, 5, 6, 7])), classify(cards([7, 7, 7, 7]))];
  for (let trial = 0; trial < 45; trial++) {
    const deck = makeDeck();
    const selection = Array.from({ length: 12 }, () => deck.splice(Math.floor(random() * deck.length), 1)[0]);
    const target = targets[trial % targets.length];
    let largest = 0;
    for (let mask = 1; mask < 1 << selection.length; mask++) {
      const subset = selection.filter((_, i) => mask & (1 << i));
      if (subset.length > largest && beats(classify(subset), target)) largest = subset.length;
    }
    const repaired = findClosestSelection(selection, target);
    assert.equal(repaired?.length || 0, largest, `trial ${trial}`);
    if (repaired) assert.ok(beats(classify(repaired), target));
  }
});
