import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { makeDeck, findHint } from '../lib/game.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 3000) {
  const started = Date.now();
  while (!fn()) { if (Date.now() - started > timeout) throw new Error('Timed out waiting for state'); await sleep(5); }
}
async function setup(t, options) {
  const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, ...options });
  await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.httpServer.address().port}`;
  const clients = [];
  async function connect(token) {
    const client = { socket: io(url, { autoConnect: false, transports: ['websocket'], auth: { token } }), state: null };
    client.socket.on('session', session => { client.token = session.token; client.id = session.id; });
    client.socket.on('state', state => { client.state = state; });
    client.socket.connect(); clients.push(client);
    await until(() => client.token);
    return client;
  }
  async function action(client, event, data = {}) {
    return client.socket.timeout(2000).emitWithAck(event, { revision: client.state?.revision, ...data });
  }
  async function ok(client, event, data) { const response = await action(client, event, data); assert.equal(response.ok, true, response.error); }
  async function table() {
    const a = await connect(), b = await connect(), c = await connect();
    await ok(a, 'create', { name: '阿青' });
    await ok(b, 'join', { name: '小满', code: a.state.code });
    await ok(c, 'join', { name: '老周', code: a.state.code });
    await until(() => [a, b, c].every(p => p.state?.players.length === 3));
    return [a, b, c];
  }
  async function ready(players) {
    for (const p of players) await ok(p, 'ready', { ready: true });
    await until(() => players.every(p => p.state?.phase === 'bidding'));
  }
  t.after(async () => { clients.forEach(c => c.socket.disconnect()); await game.close(); });
  return { game, url, connect, action, ok, table, ready };
}

test('three isolated clients play a complete round, reconnect and rematch', { timeout: 20000 }, async t => {
  const { url, connect, action, ok, table, ready } = await setup(t);
  const players = await table(); const [a, b, c] = players;
  const health = await fetch(`${url}/health`); assert.equal((await health.json()).ok, true);
  const outsider = await connect();
  assert.equal((await action(outsider, 'join', { name: '第四人', code: a.state.code })).ok, false);
  const script = await fetch(`${url}/server.js`); assert.equal(script.status, 404);
  await ready(players);
  for (const p of players) {
    assert.equal(p.state.players.find(x => x.id === p.id).hand.length, 17);
    assert.ok(p.state.players.filter(x => x.id !== p.id).every(x => x.hand === undefined));
    assert.deepEqual(p.state.bottom, []);
  }
  const dealt = players.flatMap(p => p.state.players.find(x => x.id === p.id).hand.map(c => c.id));
  assert.equal(new Set(dealt).size, 51);
  const bidder = players.find(p => p.id === a.state.turnId);
  const wrong = players.find(p => p !== bidder);
  assert.equal((await action(wrong, 'bid', { value: 3 })).ok, false);
  await ok(bidder, 'bid', { value: 3 });
  await until(() => players.every(p => p.state.phase === 'playing'));
  assert.equal(bidder.state.players.find(x => x.id === bidder.id).hand.length, 20);
  assert.equal(bidder.state.bottom.length, 3);
  assert.equal((await action(bidder, 'pass')).ok, false);
  assert.equal((await action(bidder, 'play', { cards: [999] })).ok, false);
  const own = bidder.state.players.find(x => x.id === bidder.id).hand;
  assert.equal((await action(bidder, 'play', { cards: [own[0].id, own[0].id] })).ok, false);
  assert.equal((await action(bidder, 'play', { cards: [own[0].id], revision: -1 })).code, 'STALE_STATE');
  // Refresh is a new transport authenticated with the server-issued private token.
  const previousHand = b.state.players.find(x => x.id === b.id).hand;
  b.socket.disconnect();
  await until(() => a.state.players.find(x => x.id === b.id).connected === false);
  const reconnected = await connect(b.token);
  await until(() => reconnected.state?.phase === 'playing');
  assert.equal(reconnected.id, b.id);
  assert.deepEqual(reconnected.state.players.find(x => x.id === b.id).hand, previousHand);
  players[1] = reconnected;
  let turns = 0;
  while (a.state.phase === 'playing' && turns++ < 400) {
    await until(() => players.every(p => p.state.revision === a.state.revision));
    const player = players.find(p => p.id === a.state.turnId);
    const hand = player.state.players.find(p => p.id === player.id).hand;
    const hint = findHint(hand, player.state.lastPlay?.combo);
    await ok(player, hint ? 'play' : 'pass', hint ? { cards: hint.map(c => c.id) } : {});
    await sleep(25);
  }
  assert.equal(a.state.phase, 'finished');
  assert.ok(turns < 400);
  assert.equal(a.state.result.deltas.reduce((sum, d) => sum + d.delta, 0), 0);
  assert.equal(a.state.players.reduce((sum, p) => sum + p.score, 0), 0);
  const scores = a.state.players.map(p => p.score);
  const remainingHands = a.state.players.map(p => p.hand);
  assert.ok(a.state.players.every(p => Array.isArray(p.hand) && p.hand.length === p.count));
  for (const player of players.slice(0, 2)) await ok(player, 'ready', { ready: true });
  assert.equal(a.state.phase, 'finished', 'two ready players cannot end the result display');
  assert.deepEqual(a.state.players.map(p => p.hand), remainingHands);
  await ok(players[0], 'ready', { ready: false });
  await ok(players[2], 'ready', { ready: true });
  await until(() => a.state.players.filter(p => p.ready).length === 2);
  assert.equal(a.state.phase, 'finished', 'cancelling readiness keeps the result visible');
  await ok(players[0], 'ready', { ready: true });
  assert.equal(a.state.round, 2);
  assert.ok(a.state.players.filter(p => p.id !== a.id).every(p => p.hand === undefined), 'new deal hides opponents again');
  assert.deepEqual(a.state.players.map(p => p.score), scores);
  await ok(c, 'leave');
  await until(() => a.state.phase === 'waiting');
  assert.equal(a.state.players.length, 2); assert.equal(a.state.result, null);
  assert.ok(a.state.players.every(p => p.hand === undefined || p.hand.length === 0));
});
test('all pass bidding redeals; a lower bid is rejected; room isolation and host transfer', async t => {
  const { table, ready, ok, action, connect } = await setup(t);
  const players = await table(); const [a] = players;
  await ready(players);
  const initialDealId = a.state.dealId;
  for (let i = 0; i < 3; i++) {
    await until(() => players.every(p => p.state.revision === a.state.revision));
    await ok(players.find(p => p.id === a.state.turnId), 'bid', { value: 0 });
  }
  assert.equal(a.state.phase, 'bidding'); assert.equal(a.state.highestBid, 0);
  assert.equal(a.state.dealId, initialDealId + 1);
  assert.ok(a.state.log.some(line => line.includes('重新洗牌')));
  await until(() => players.every(p => p.state.revision === a.state.revision));
  await ok(players.find(p => p.id === a.state.turnId), 'bid', { value: 2 });
  await until(() => players.every(p => p.state.revision === a.state.revision));
  assert.equal((await action(players.find(p => p.id === a.state.turnId), 'bid', { value: 1 })).ok, false);
  const outsider = await connect(); await ok(outsider, 'create', { name: '另一桌' });
  assert.notEqual(outsider.state.code, a.state.code); assert.equal(outsider.state.players.length, 1);
  await ok(a, 'leave');
  await until(() => players[1].state.players.length === 2);
  assert.equal(players[1].state.hostId, players[1].id);
});
test('server timeout bids, passes, leads and never stalls after disconnect', async t => {
  const { game, table, ready, ok } = await setup(t, { turnMs: 100 });
  const players = await table(); const a = players[0];
  await ready(players);
  await until(() => a.state.players.some(p => p.bid === 0));
  await until(() => players.every(p => p.state.revision === a.state.revision));
  const bidder = players.find(p => p.id === a.state.turnId);
  await ok(bidder, 'bid', { value: 3 });
  const room = game.rooms.get(a.state.code);
  await until(() => a.state.lastPlay !== null);
  assert.equal(a.state.lastPlay.cards.length, 1);
  const minimum = Math.min(...room.players.find(p => p.id === bidder.id).hand.map(c => c.rank));
  assert.ok(a.state.lastPlay.cards[0].rank <= minimum);
  const turnId = a.state.turnId;
  players.find(p => p.id === turnId).socket.disconnect();
  const observer = players.find(p => p.id !== turnId);
  await until(() => observer.state.turnId !== turnId);
  assert.ok(observer.state.log.some(line => line.includes('超时')));
});
test('bomb and spring multipliers produce zero-sum team scores', async t => {
  const { game, table, ready, ok } = await setup(t);
  const players = await table(); const a = players[0];
  await ready(players);
  const landlord = players.find(p => p.id === a.state.turnId);
  await ok(landlord, 'bid', { value: 3 });
  const room = game.rooms.get(a.state.code);
  const bomb = makeDeck().filter(c => c.rank === 3);
  room.players.find(p => p.id === landlord.id).hand = bomb;
  await ok(landlord, 'play', { cards: bomb.map(c => c.id) });
  assert.equal(landlord.state.result.multiplier, 12);
  assert.equal(landlord.state.result.spring, true);
  assert.equal(landlord.state.result.deltas.find(d => d.id === landlord.id).delta, 24);
  assert.equal(landlord.state.result.deltas.reduce((sum, d) => sum + d.delta, 0), 0);
});

for (const humanCount of [1, 2]) test(`${humanCount} human(s) finish with bot fill, rematch, then clean up`, { timeout: 20000 }, async t => {
  const { game, connect, action, ok, ready } = await setup(t, { botDelayMs: 15 });
  const host = await connect();
  await ok(host, 'create', { name: '房主' });
  const code = host.state.code;
  const humans = [host];
  if (humanCount === 2) {
    const guest = await connect(); await ok(guest, 'join', { name: '朋友', code }); humans.push(guest);
    assert.equal((await action(guest, 'fill-bots')).ok, false);
  }
  await ok(host, 'fill-bots');
  assert.equal(host.state.players.filter(p => p.bot).length, 3 - humanCount);
  assert.equal(game.sessions.size, humanCount, 'bots have no authentication sessions');
  assert.ok(host.state.players.filter(p => p.bot).every(p => p.connected && p.ready && p.hand === undefined));
  assert.equal((await action(host, 'fill-bots')).ok, false);
  assert.equal((await action(host, 'remove-bot', { id: host.id })).ok, false);
  let botActed = false;
  host.socket.on('state', state => {
    if (state?.players.some(p => p.bot && p.lastAction !== '')) botActed = true;
  });
  await ready(humans);
  assert.equal((await action(host, 'remove-bot', { id: host.state.players.find(p => p.bot).id })).ok, false);
  let moves = 0;
  while (host.state.phase !== 'finished' && moves++ < 400) {
    await until(() => host.state.phase === 'finished' || humans.some(p => p.id === host.state.turnId), 5000);
    if (host.state.phase === 'finished') break;
    const actor = humans.find(p => p.id === host.state.turnId);
    await until(() => actor.state.revision === host.state.revision);
    if (actor.state.phase === 'bidding') await ok(actor, 'bid', { value: 0 });
    else {
      const hand = actor.state.players.find(p => p.id === actor.id).hand;
      const hint = findHint(hand, actor.state.lastPlay?.combo);
      await ok(actor, hint ? 'play' : 'pass', hint ? { cards: hint.map(c => c.id) } : {});
    }
    await sleep(5);
  }
  assert.equal(host.state.phase, 'finished');
  assert.ok(moves < 400);
  assert.ok(host.state.players.filter(p => p.bot).every(p => p.ready));
  assert.equal(host.state.result.deltas.reduce((sum, p) => sum + p.delta, 0), 0);
  assert.ok(botActed, 'bots take actions during the round, even if the final trick clears their labels');
  assert.ok(!host.state.log.some(line => line.includes('超时')), 'bots act promptly instead of timing out');
  await ready(humans);
  assert.equal(host.state.round, 2);
  const room = game.rooms.get(code);
  await ok(host, 'leave');
  if (humanCount === 2) {
    await until(() => humans[1].state.hostId === humans[1].id);
    assert.equal(humans[1].state.phase, 'waiting');
    await ok(humans[1], 'leave');
  }
  assert.equal(game.rooms.has(code), false);
  assert.equal(room.timer, null);
});

test('host removes bots; joining humans replace waiting bots safely', async t => {
  const { game, connect, action, ok } = await setup(t);
  const host = await connect(); await ok(host, 'create', { name: '房主' });
  const code = host.state.code;
  await ok(host, 'fill-bots');
  const removed = host.state.players.find(p => p.bot).id;
  await ok(host, 'remove-bot', { id: removed });
  assert.equal(host.state.players.length, 2);
  await ok(host, 'fill-bots');
  const guest = await connect();
  assert.equal((await action(guest, 'join', { name: '', code })).ok, false);
  assert.equal(game.rooms.get(code).players.filter(p => p.bot).length, 2);
  await ok(guest, 'join', { name: '朋友', code });
  assert.equal(guest.state.players.filter(p => p.bot).length, 1);
  assert.equal((await action(guest, 'remove-bot', { id: guest.state.players.find(p => p.bot).id })).ok, false);
  await ok(host, 'leave');
  await until(() => guest.state.hostId === guest.id);
  await ok(guest, 'remove-bot', { id: guest.state.players.find(p => p.bot).id });
  assert.equal(guest.state.players.length, 1);
});

test('public plays persist per seat, restore on reconnect, and clear for the next trick', async t => {
  const { game, table, ready, ok, connect } = await setup(t);
  const players = await table(); const observer = players[0];
  await ready(players);
  const initialDeal = observer.state.dealId;
  const leader = players.find(p => p.id === observer.state.turnId);
  await ok(leader, 'bid', { value: 3 });
  const room = game.rooms.get(observer.state.code);
  const deck = makeDeck();
  for (let i = 0; i < 3; i++) room.players[(room.turn + i) % 3].hand = [deck.find(c => c.rank === 3 + i), deck.find(c => c.rank === 10 + i)];
  const first = room.players[room.turn];
  await ok(leader, 'play', { cards: [first.hand[0].id] });
  const second = players.find(p => p.id === room.players[room.turn].id);
  await until(() => second.state.revision === leader.state.revision);
  await ok(second, 'play', { cards: [room.players[room.turn].hand[0].id] });
  assert.equal(Object.keys(second.state.tablePlays).length, 2);
  assert.equal(second.state.tablePlays[first.id].cards[0].rank, 3);
  assert.equal(second.state.tablePlays[second.id].cards[0].rank, 4);
  const third = players.find(p => p.id === room.players[room.turn].id);
  third.socket.disconnect();
  const resumed = await connect(third.token);
  await until(() => resumed.state?.tablePlays && Object.keys(resumed.state.tablePlays).length === 2);
  assert.equal(resumed.state.dealId, initialDeal);
  await ok(resumed, 'pass');
  assert.ok(resumed.state.tablePasses[resumed.id]);
  await until(() => leader.state.turnId === leader.id);
  await ok(leader, 'pass');
  assert.deepEqual(leader.state.tablePlays, {});
  assert.equal(leader.state.lastPlay, null);
  assert.ok(leader.state.tablePasses[leader.id], 'the second pass remains visible after a trick clears');
  assert.ok(leader.state.tablePasses[resumed.id]);
});

test('deal and play transitions reserve display time before the next action', async t => {
  const { game, table, ready, action, ok } = await setup(t, { dealDelayMs: 150, actionDelayMs: 150 });
  const players = await table(); await ready(players);
  const room = game.rooms.get(players[0].state.code);
  const bidder = players.find(p => p.id === players[0].state.turnId);
  assert.equal((await action(bidder, 'bid', { value: 3 })).code, 'TRANSITION');
  await until(() => Date.now() >= room.actionAt);
  await ok(bidder, 'bid', { value: 3 });
  const card = room.players.find(p => p.id === bidder.id).hand[0];
  assert.equal((await action(bidder, 'play', { cards: [card.id] })).code, 'TRANSITION');
  await until(() => Date.now() >= room.actionAt);
  await ok(bidder, 'play', { cards: [card.id] });
  const next = players.find(p => p.id === room.players[room.turn].id);
  await until(() => next.state.revision === bidder.state.revision);
  assert.equal((await action(next, 'pass')).code, 'TRANSITION');
  assert.ok(next.state.deadline > next.state.actionAt, 'thinking time follows transition time');
});
