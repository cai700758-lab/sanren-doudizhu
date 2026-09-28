import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { makeDeck, classify, beats, findHint, findClosestSelection } from '../lib/game.js';
const cards = (...ranks) => ranks.map((rank, id) => ({ rank, id, suit: '♠' }));
const combo = (...ranks) => classify(cards(...ranks), 'four');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) {
  const start = Date.now();
  while (!fn()) { if (Date.now() - start > timeout) throw new Error('State timeout'); await sleep(5); }
}
test('four-player deck and combinations preserve physical card identities', () => {
  const deck = makeDeck('four');
  assert.equal(deck.length, 108); assert.equal(new Set(deck.map(c => c.id)).size, 108);
  for (let rank = 3; rank <= 17; rank++) assert.equal(deck.filter(c => c.rank === rank).length, rank < 16 ? 8 : 2);
  assert.equal(combo(16, 17), null);
  assert.equal(combo(16, 16).type, 'pair');
  assert.equal(combo(16, 16, 17, 17).type, 'rocket');
  assert.equal(combo(3, 3, 3, 4), null);
  assert.equal(combo(3, 3, 3, 4, 4).type, 'triplePair');
  assert.equal(combo(3, 3, 3, 4, 4, 4, 5, 6), null);
  assert.equal(combo(3, 3, 3, 4, 4, 4, 5, 5, 6, 6).type, 'airplanePair');
  assert.equal(combo(3, 3, 3, 3, 5, 6), null);
  for (let size = 4; size <= 8; size++) assert.equal(combo(...Array(size).fill(3)).type, 'bomb');
  assert.equal(combo(...Array(9).fill(3)), null);
  assert.ok(beats(combo(3, 3, 3, 3, 3), combo(15, 15, 15, 15)));
  assert.ok(!beats(combo(15, 15, 15, 15), combo(3, 3, 3, 3, 3)));
  assert.ok(beats(combo(16, 16, 17, 17), combo(...Array(8).fill(15))));
  assert.equal(classify(cards(16, 17)).type, 'rocket');
  assert.equal(classify(cards(3, 3, 3, 4)).type, 'tripleSingle');
});
test('four-player hints and repaired selections respect large bombs and legal wings', () => {
  const hand = cards(3, 3, 3, 3, 3, 16, 16, 17, 17);
  const hint = findHint(hand, combo(15, 15, 15, 15), 'four');
  assert.equal(classify(hint, 'four').size, 5);
  assert.equal(classify(findHint(hand, combo(...Array(8).fill(15)), 'four'), 'four').type, 'rocket');
  assert.equal(classify(findClosestSelection(cards(3, 3, 3, 4, 4, 4, 5, 6), null, 'four'), 'four').type, 'airplane');
});
async function setup(t, options = {}) {
  const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, botDelayMs: 10, turnMs: 60000, ...options });
  await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
  const clients = [];
  async function connect(token) {
    const c = { socket: io(`http://127.0.0.1:${game.httpServer.address().port}`, { transports: ['websocket'], auth: { token } }) };
    c.socket.on('session', s => Object.assign(c, s)); c.socket.on('state', s => { c.state = s; }); clients.push(c);
    await until(() => c.token); return c;
  }
  const action = (c, event, data = {}) => c.socket.timeout(2000).emitWithAck(event, { revision: c.state?.revision, ...data });
  async function ok(c, event, data) { const r = await action(c, event, data); assert.equal(r.ok, true, `${event}: ${r.error}`); }
  t.after(async () => { clients.forEach(c => c.socket.disconnect()); await game.close(); });
  return { game, connect, action, ok };
}
test('four humans: readiness, private deal, bidding, three passes, reconnect, scores and rematch', { timeout: 20000 }, async t => {
  const { connect, action, ok } = await setup(t);
  const players = [await connect(), await connect(), await connect(), await connect()];
  const a = players[0]; await ok(a, 'create', { name: '甲', mode: 'four' });
  for (let i = 1; i < 4; i++) await ok(players[i], 'join', { name: `玩家${i}`, code: a.state.code });
  const outsider = await connect();
  assert.equal((await action(outsider, 'join', { name: '第五位', code: a.state.code })).ok, false);
  for (const p of players.slice(0, 3)) await ok(p, 'ready', { ready: true });
  assert.equal(a.state.phase, 'waiting');
  await ok(players[3], 'ready', { ready: true });
  await until(() => players.every(p => p.state.phase === 'bidding'));
  const hands = players.flatMap(p => p.state.players.find(x => x.id === p.id).hand);
  assert.equal(hands.length, 100); assert.equal(new Set(hands.map(c => c.id)).size, 100);
  for (const p of players) {
    assert.equal(p.state.capacity, 4);
    assert.ok(p.state.players.filter(x => x.id !== p.id).every(x => x.hand === undefined));
  }
  // All four receive a bid, not just the first three.
  await ok(players.find(p => p.id === a.state.turnId), 'bid', { value: 1 });
  for (let i = 0; i < 3; i++) {
    assert.equal(a.state.phase, 'bidding');
    await until(() => players.every(p => p.state.revision === a.state.revision));
    await ok(players.find(p => p.id === a.state.turnId), 'bid', { value: 0 });
  }
  await until(() => players.every(p => p.state.phase === 'playing'));
  const landlord = players.find(p => p.id === a.state.landlordId);
  assert.equal(landlord.state.players.find(p => p.id === landlord.id).hand.length, 33);
  assert.equal(a.state.bottom.length, 8);
  assert.equal((await action(landlord, 'skill')).ok, false);
  await ok(landlord, 'play', { cards: [landlord.state.players.find(p => p.id === landlord.id).hand.at(-1).id] });
  for (let i = 0; i < 3; i++) {
    assert.ok(a.state.lastPlay);
    await until(() => players.every(p => p.state.revision === a.state.revision));
    await ok(players.find(p => p.id === a.state.turnId), 'pass');
  }
  assert.equal(a.state.lastPlay, null); assert.equal(a.state.turnId, landlord.id);
  const old = players[3]; old.socket.disconnect(); players[3] = await connect(old.token);
  await until(() => players[3].state?.code === a.state.code);
  assert.equal(players[3].id, old.id);
  let turns = 0;
  while (a.state.phase === 'playing' && turns++ < 650) {
    await until(() => players.every(p => p.state.revision === a.state.revision));
    const actor = players.find(p => p.id === a.state.turnId);
    const hint = findHint(actor.state.players.find(p => p.id === actor.id).hand, actor.state.lastPlay?.combo, 'four');
    await ok(actor, hint ? 'play' : 'pass', hint ? { cards: hint.map(c => c.id) } : {});
    await sleep(2);
  }
  assert.equal(a.state.phase, 'finished');
  assert.equal(a.state.result.deltas.reduce((n, d) => n + d.delta, 0), 0);
  const deltas = a.state.result.deltas;
  assert.equal(Math.abs(deltas.find(d => d.id === a.state.landlordId).delta), Math.abs(deltas.find(d => d.id !== a.state.landlordId).delta) * 3);
  assert.ok(a.state.players.every(p => Array.isArray(p.hand)));
  const remaining = a.state.players.map(p => p.hand);
  for (const p of players.slice(0, 3)) await ok(p, 'ready', { ready: true });
  assert.equal(a.state.phase, 'finished'); assert.deepEqual(a.state.players.map(p => p.hand), remaining);
  await ok(players[3], 'ready', { ready: true }); assert.equal(a.state.phase, 'bidding'); assert.equal(a.state.round, 2);
});
for (const humans of [1, 2, 3]) test(`four seats with ${humans} humans: bots fill and complete the round`, { timeout: 20000 }, async t => {
  const { game, connect, ok } = await setup(t);
  const players = [];
  for (let i = 0; i < humans; i++) players.push(await connect());
  const a = players[0]; await ok(a, 'create', { name: '房主', mode: 'four' });
  for (const p of players.slice(1)) await ok(p, 'join', { name: '朋友', code: a.state.code });
  await ok(a, 'fill-bots'); assert.equal(a.state.players.filter(p => p.bot).length, 4 - humans);
  for (const p of players) await ok(p, 'ready', { ready: true });
  const start = Date.now();
  while (a.state.phase !== 'finished' && Date.now() - start < 15000) {
    const room = game.rooms.get(a.state.code), actor = players.find(p => p.id === room.players[room.turn]?.id);
    if (actor && actor.state.revision === a.state.revision && actor.state.turnId === actor.id) {
      if (actor.state.phase === 'bidding') await ok(actor, 'bid', { value: 3 });
      else {
        const hint = findHint(actor.state.players.find(p => p.id === actor.id).hand, actor.state.lastPlay?.combo, 'four');
        await ok(actor, hint ? 'play' : 'pass', hint ? { cards: hint.map(c => c.id) } : {});
      }
    }
    await sleep(5);
  }
  assert.equal(a.state.phase, 'finished');
});
