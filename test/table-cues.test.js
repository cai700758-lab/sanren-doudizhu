import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tableCues } from '../public/table-cues.js';
import { comboEffect } from '../public/combo-effects.js';

const base = () => ({ code: '123456', round: 1, dealId: 1, phase: 'playing', me: 'a', players: [{ id: 'a', count: 5 }, { id: 'b', count: 8 }], tablePlays: {}, tablePasses: {} });
test('refresh and unrelated state updates never replay presentation events', () => {
  const state = base();
  assert.deepEqual(tableCues(null, state), []);
  assert.deepEqual(tableCues(state, structuredClone(state)), []);
  assert.deepEqual(tableCues(state, { ...state, code: '654321' }), []);
});
test('bombs and rockets announce low cards once, ordered after the special play', () => {
  for (const type of ['bomb', 'rocket']) {
    const previous = base(), next = base();
    next.players[0].count = 1;
    next.tablePlays.a = { sequence: 3, combo: { type } };
    assert.deepEqual(tableCues(previous, next), [{ kind: type, playerId: 'a' }, { kind: 'warning', playerId: 'a', count: 1 }]);
    assert.deepEqual(tableCues(next, structuredClone(next)), []);
  }
});
test('last card produces the correct team result without a zero-card warning', () => {
  const previous = base(), next = base();
  next.phase = 'finished'; next.players[0].count = 0;
  next.tablePlays.a = { sequence: 9, combo: { type: 'single' } };
  next.result = { winnerId: 'a', deltas: [{ id: 'a', delta: 12 }, { id: 'b', delta: -6 }] };
  assert.deepEqual(tableCues(previous, next), [{ kind: 'play', playerId: 'a' }, { kind: 'win', playerId: 'a', delta: 12 }]);
  assert.equal(tableCues(previous, { ...next, me: 'b' }).at(-1).kind, 'lose');
  assert.deepEqual(tableCues(next, { ...next, revision: 100 }), []);
});
test('redeals and passes are distinct from ordinary plays', () => {
  const previous = base();
  assert.deepEqual(tableCues(previous, { ...base(), dealId: 2, phase: 'bidding' }), [{ kind: 'deal' }]);
  assert.deepEqual(tableCues(previous, { ...base(), tablePasses: { b: { sequence: 4 } } }), [{ kind: 'pass', playerId: 'b' }]);
});
test('all special shapes trigger their own animation and retain the exact combo name', () => {
  for (const type of ['straight', 'pairStraight', 'airplane', 'airplaneSingle', 'airplanePair', 'tripleSingle', 'triplePair', 'fourSingle', 'fourPair']) {
    const previous = base(), next = base();
    next.tablePlays.a = { sequence: 1, combo: { type } };
    assert.equal(tableCues(previous, next)[0].kind, type);
    assert.ok(comboEffect(type)?.title);
    assert.deepEqual(tableCues(next, structuredClone(next)), []);
  }
  for (const type of ['single', 'pair', 'triple', 'unknown', '__proto__']) assert.equal(comboEffect(type), null);
});
