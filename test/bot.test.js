import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseBotBid, chooseBotPlay } from '../lib/bot.js';
import { makeDeck, classify, beats } from '../lib/game.js';

function cards(ranks) {
  const deck = makeDeck();
  return ranks.map(rank => deck.splice(deck.findIndex(c => c.rank === rank), 1)[0]);
}
const table = { selfId: 'bot', landlordId: 'lord', lastPlay: null, players: [{ id: 'bot', count: 8 }, { id: 'friend', count: 8 }, { id: 'lord', count: 8 }] };
test('bot bidding stays legal and responds to hand strength', () => {
  const strong = cards([16, 17, 15, 15, 3, 3, 3, 3]);
  assert.equal(chooseBotBid(strong, 0), 3);
  assert.equal(chooseBotBid(cards([3, 4, 5]), 0), 1);
  assert.equal(chooseBotBid(cards([3, 4, 5]), 2), 0);
  for (const high of [0, 1, 2, 3]) { const bid = chooseBotBid(strong, high); assert.ok(bid === 0 || (bid > high && bid <= 3)); }
});
test('bot leads combinations, finishes when possible, and does not split a rocket unnecessarily', () => {
  const hand = cards([3, 4, 5, 6, 7, 16, 17]);
  assert.equal(classify(chooseBotPlay(hand, table)).type, 'straight');
  const whole = cards([3, 3, 3, 4, 4, 4, 7, 7]);
  assert.equal(chooseBotPlay(whole, table).length, whole.length);
});
test('farmer yields to partner, but takes an immediate win', () => {
  const lastPlay = { playerId: 'friend', combo: classify(cards([3])) };
  assert.equal(chooseBotPlay(cards([4, 5]), { ...table, lastPlay }), null);
  assert.equal(chooseBotPlay(cards([4]), { ...table, lastPlay }).length, 1);
});
test('bot passes unbeatable hands and blocks enemy near finish', () => {
  assert.equal(chooseBotPlay(cards([3, 4]), { ...table, lastPlay: { playerId: 'lord', combo: classify(cards([17])) } }), null);
  const choice = chooseBotPlay(cards([4, 8, 14]), { ...table, players: [{ id: 'lord', count: 1 }], lastPlay: { playerId: 'lord', combo: classify(cards([3])) } });
  assert.equal(choice[0].rank, 14);
});
test('bot decisions are legal and use only its own cards across varied hands', () => {
  let seed = 741;
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let round = 0; round < 60; round++) {
    const deck = makeDeck();
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const hand = deck.slice(0, 17 + round % 4);
    for (const target of [null, classify(cards([9])), classify(cards([7, 7])), classify(cards([3, 4, 5, 6, 7]))]) {
      const move = chooseBotPlay(hand, { ...table, lastPlay: target ? { playerId: 'lord', combo: target } : null });
      if (move) { assert.ok(beats(classify(move), target)); assert.ok(move.every(c => hand.includes(c))); }
      else assert.ok(target, 'a leading bot may not pass');
    }
  }
});
