import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { makeDeck, classify, beats, findHint, findClosestSelection } from '../lib/game.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('Race state timeout'); await sleep(5); }
}
async function setup(t, bots = false, options = {}) {
  const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, botDelayMs: 10000, ...options });
  await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.httpServer.address().port}`, clients = [];
  async function connect() {
    const client = { socket: io(url, { transports: ['websocket'] }) };
    clients.push(client);
    client.socket.on('session', session => Object.assign(client, session));
    client.socket.on('state', state => { client.state = state; });
    await until(() => client.id); return client;
  }
  async function action(client, name, data = {}) { return client.socket.timeout(2500).emitWithAck(name, { revision: client.state?.revision, ...data }); }
  async function ok(client, name, data) { const reply = await action(client, name, data); assert.equal(reply.ok, true, reply.error); }
  const host = await connect(); await ok(host, 'create', { name: '甲', mode: 'race' });
  const room = game.rooms.get(host.state.code), players = [host];
  if (bots) await ok(host, 'fill-bots');
  else for (const name of ['乙', '丙']) { const client = await connect(); await ok(client, 'join', { code: room.code, name }); players.push(client); }
  for (const player of players) await ok(player, 'ready', { ready: true });
  await until(() => room.phase === 'playing');
  t.after(async () => { clients.forEach(client => client.socket.disconnect()); await game.close(); });
  return { game, players, room, action, ok };
}

test('race deals only the first deck, requires the original heart three, then replenishes without exposing hands', async t => {
  const { players, room, action, ok } = await setup(t);
  const owner = room.players[room.turn], client = players.find(item => item.id === owner.id);
  assert.ok(owner.hand.some(card => card.id === 1 && card.rank === 3 && card.suit === '♥'));
  assert.ok(room.players.every(player => player.hand.length === 18 && player.hand.every(card => card.id < 54)));
  assert.equal(room.drawPile.length, 54);
  assert.ok(room.drawPile.every(card => card.id >= 54 && card.id < 108));
  assert.equal(room.bottom.length, 0);
  assert.equal((await action(client, 'bid', { value: 3 })).ok, false);
  assert.equal((await action(client, 'pass')).ok, false);
  assert.equal((await action(client, 'play', { cards: [owner.hand.find(card => card.id !== 1).id] })).ok, false);
  const opponent = players.find(item => item !== client);
  assert.equal(opponent.state.players.find(player => player.id === owner.id).hand, undefined);
  await ok(client, 'play', { cards: [1] });
  assert.equal(owner.playedCount, 1);
  assert.equal(owner.hand.length, 18);
  assert.equal(room.drawPile.length, 53);
  assert.equal(room.discardPile.length, 1);
  assert.equal(room.openingLead, false);
  assert.ok(owner.hand.some(card => card.id >= 54));
  await until(() => opponent.state.players.find(player => player.id === owner.id).playedCount === 1);
  assert.equal(opponent.state.players.find(player => player.id === owner.id).hand, undefined);
});

test('race passing draws one private card without increasing progress', async t => {
  const { players, room, ok } = await setup(t);
  const lead = room.players[room.turn], leader = players.find(player => player.id === lead.id);
  await ok(leader, 'play', { cards: [1] });
  const passer = room.players[room.turn], client = players.find(player => player.id === passer.id);
  const before = new Set(passer.hand.map(card => card.id));
  const pileBefore = room.drawPile.length;
  await until(() => client.state.revision === room.revision);
  await ok(client, 'pass');
  assert.equal(passer.hand.length, 19);
  assert.equal(passer.playedCount, 0);
  assert.equal(room.drawPile.length, pileBefore - 1);
  assert.equal(room.tablePasses[passer.id].drawn, 1);
  assert.equal(passer.hand.filter(card => !before.has(card.id)).length, 1);
  await until(() => leader.state.players.find(player => player.id === passer.id).count === 19);
  assert.equal(leader.state.players.find(player => player.id === passer.id).hand, undefined);
  const physical = [...room.players.flatMap(player => player.hand), ...room.drawPile, ...room.discardPile];
  assert.equal(physical.length, 108);
  assert.equal(new Set(physical.map(card => card.id)).size, 108);
});

test('race passing safely handles an empty stock and discard pile', async t => {
  const { players, room, ok } = await setup(t);
  const leader = players.find(player => player.id === room.players[room.turn].id);
  await ok(leader, 'play', { cards: [1] });
  const passer = room.players[room.turn], client = players.find(player => player.id === passer.id);
  room.players.find(player => player !== passer).hand.push(...room.drawPile.splice(0), ...room.discardPile.splice(0));
  const before = passer.hand.length;
  await until(() => client.state.revision === room.revision);
  await ok(client, 'pass');
  assert.equal(passer.hand.length, before);
  assert.equal(room.tablePasses[passer.id].drawn, 0);
  assert.equal(room.players.reduce((sum, player) => sum + player.hand.length, 0), 108);
});

test('race five threes outrank the two-joker rocket without changing classic rules', () => {
  const deck = makeDeck('race'), threes = deck.filter(card => card.rank === 3).slice(0, 5);
  const rocket = [deck[52], deck[53]];
  assert.equal(deck.length, 108);
  assert.equal(classify(threes, 'race').type, 'superBomb');
  assert.equal(classify(threes, 'classic'), null);
  assert.equal(classify(deck.filter(card => card.rank === 4).slice(0, 5), 'race'), null);
  assert.equal(beats(classify(threes, 'race'), classify(rocket, 'race')), true);
  assert.equal(beats(classify(rocket, 'race'), classify(threes, 'race')), false);
  assert.deepEqual(new Set(findHint(threes, classify(rocket, 'race'), 'race').map(card => card.id)), new Set(threes.map(card => card.id)));
  assert.equal(findHint(rocket, classify(threes, 'race'), 'race'), null);
  assert.equal(findClosestSelection([...threes, deck[52]], classify(rocket, 'race'), 'race').length, 5);
});

test('race recycles discards, keeps 108 physical cards, and finishes at 36 played cards', async t => {
  const { players, room, ok } = await setup(t);
  const owner = room.players[room.turn], client = players.find(item => item.id === owner.id);
  await ok(client, 'play', { cards: [1] });
  clearTimeout(room.timer); room.actionAt = 0; room.turn = room.players.indexOf(owner); room.lastPlay = null;
  const pair = findHint(owner.hand, { type: 'pair', rank: 2, chain: 1, size: 2 }, 'race');
  assert.equal(pair.length, 2);
  room.discardPile.push(...room.drawPile.splice(0, room.drawPile.length - 1));
  owner.playedCount = 33;
  await ok(client, 'play', { cards: pair.map(card => card.id) });
  assert.equal(owner.hand.length, 18);
  assert.equal(owner.playedCount, 35);
  assert.ok(room.drawPile.length > 0);
  const physical = [...room.players.flatMap(player => player.hand), ...room.drawPile, ...room.discardPile];
  assert.equal(physical.length, 108);
  assert.equal(new Set(physical.map(card => card.id)).size, 108);
  clearTimeout(room.timer); room.actionAt = 0; room.turn = room.players.indexOf(owner); room.lastPlay = null;
  await ok(client, 'play', { cards: [owner.hand[0].id] });
  assert.equal(room.phase, 'finished'); assert.equal(room.result.winnerId, owner.id);
  assert.equal(owner.playedCount, 36); assert.equal(owner.hand.length, 18);
  assert.equal(owner.score, 1); assert.ok(room.players.filter(player => player !== owner).every(player => player.score === 0));
  await until(() => players.every(player => player.state.phase === 'finished'));
  for (const player of players) await ok(player, 'ready', { ready: true });
  assert.equal(room.phase, 'playing');
  assert.ok(room.players.every(player => player.playedCount === 0 && player.hand.length === 18));
});

test('race bots can play a full round with pass draws', async t => {
  const { room } = await setup(t, true, { turnMs: 15, botDelayMs: 1 });
  await until(() => room.phase === 'finished', 15000);
  assert.ok(room.players.some(player => player.playedCount >= 36));
  assert.ok(room.players.every(player => player.hand.length >= 18));
  const physical = [...room.players.flatMap(player => player.hand), ...room.drawPile, ...room.discardPile];
  assert.equal(physical.length, 108);
  assert.equal(room.players.reduce((sum, player) => sum + player.score, 0), 1);
});
