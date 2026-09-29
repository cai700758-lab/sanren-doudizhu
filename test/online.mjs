// End-to-end smoke check against a real deployed server. Only creates and cleans up its own rooms.
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { canUpgrade } from '../lib/skills.js';
import { isSkillMode, modeRules } from '../lib/game.js';

const input = process.argv[2] || process.env.GAME_URL;
if (!input) throw new Error('Usage: npm run test:online -- https://YOUR-GAME.onrender.com');
const url = new URL(input);
assert.ok(['http:', 'https:'].includes(url.protocol), 'Use an HTTP(S) game URL');
const origin = url.origin;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 20000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeout) throw new Error('Timed out waiting for synchronized state');
    await sleep(30);
  }
}
const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(90000) });
assert.equal(response.status, 200); assert.equal((await response.json()).ok, true);
for (const mode of ['classic', 'skills', 'four', 'fourSkills']) {
  const rules = modeRules(mode);
  const clients = [];
  async function connect(transports, token) {
    const client = { state: null, socket: io(origin, { transports, auth: { token }, autoConnect: false, timeout: 20000 }) };
    clients.push(client);
    client.socket.on('session', session => Object.assign(client, session));
    client.socket.on('state', state => { client.state = state; });
    client.socket.connect(); await until(() => client.token);
    return client;
  }
  async function send(client, event, data = {}) {
    const result = await client.socket.timeout(20000).emitWithAck(event, { revision: client.state?.revision, ...data });
    assert.equal(result.ok, true, `${event}: ${result.error}`);
  }
  async function settle(players) {
    await until(() => players.every(client => client.state?.revision === players[0].state?.revision));
  }
  async function turnReady(client) {
    const remaining = (client.state.actionAt || 0) - client.state.serverNow;
    if (remaining > 0) await sleep(remaining + 150);
  }
  try {
    // Verify native WebSocket, HTTP polling and the default upgrade path independently.
    let players = [await connect(['websocket']), await connect(['polling']), await connect(['polling', 'websocket'])];
    if (rules.players === 4) players.push(await connect(['websocket']));
    await send(players[0], 'create', { name: '联机检测甲', mode });
    const code = players[0].state.code;
    for (let i = 1; i < rules.players; i++) await send(players[i], 'join', { name: `联机检测${i}`, code });
    await until(() => players.every(client => client.state?.players.length === rules.players));
    for (const player of players) await send(player, 'ready', { ready: true });
    await until(() => players.every(client => client.state?.phase === 'bidding')); await settle(players);
    for (const client of players) {
      assert.equal(client.state.players.find(p => p.id === client.id).hand.length, rules.dealt);
      assert.ok(client.state.players.filter(p => p.id !== client.id).every(p => p.hand === undefined));
    }
    let actor = players.find(client => client.id === players[0].state.turnId);
    await turnReady(actor); await send(actor, 'bid', { value: 3 });
    await until(() => players.every(client => client.state?.phase === 'playing')); await settle(players); await turnReady(actor);
    if (isSkillMode(mode)) {
      const self = actor.state.players.find(p => p.id === actor.id);
      const card = self.skill.id === 'upgrade' ? self.hand.find(canUpgrade) : self.hand[0];
      if (card) {
        await send(actor, 'skill', { cardId: card.id, cardIds: self.hand.slice(0, 2).map(item => item.id), targetId: actor.state.players.find(p => p.id !== actor.id).id });
        await settle(players);
        const updated = actor.state.players.find(p => p.id === actor.id);
        assert.equal(updated.skill.used, true);
        if (updated.skill.pending) await send(actor, 'skill-choice', { cardId: updated.skill.choices[0].id });
      }
    }
    await settle(players);
    const card = actor.state.players.find(p => p.id === actor.id).hand.at(-1);
    await send(actor, 'play', { cards: [card.id] });
    await until(() => players.every(client => client.state?.lastPlay?.cards[0].id === card.id));
    // Reconnect the HTTP-polling player over WebSocket and verify its seat and hand survive.
    const old = players[1], oldHand = old.state.players.find(p => p.id === old.id).hand;
    old.socket.disconnect(); const resumed = await connect(['websocket'], old.token);
    await until(() => resumed.state?.code === code);
    assert.equal(resumed.id, old.id);
    assert.deepEqual(resumed.state.players.find(p => p.id === old.id).hand, oldHand);
    players[1] = resumed; await settle(players);
    actor = players.find(client => client.id === players[0].state.turnId);
    await turnReady(actor); await send(actor, 'pass');
    await until(() => players.every(client => client.state?.tablePasses?.[actor.id]));
    console.log(`${mode}: ${rules.players} clients, WebSocket + polling, deal, play, pass, privacy and reconnect passed.`);
  } finally {
    for (const client of clients) {
      if (client.socket.connected && client.state) {
        try { await client.socket.timeout(5000).emitWithAck('leave', {}); } catch { /* Best effort cleanup. */ }
      }
      client.socket.disconnect();
    }
  }
}
console.log(`Online smoke check passed: ${origin}`);
