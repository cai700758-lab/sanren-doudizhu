import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { createGameServer } from '../server.js';
import { makeDeck, classify } from '../lib/game.js';
import { SKILL_IDS, applySkill, resolveWildCards, findSkillHint, canUpgrade } from '../lib/skills.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 4000) {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error('State timeout'); await sleep(5); }
}
async function setup(t, mode = 'skills', bots = false, options = {}) {
  const game = createGameServer({ dealDelayMs: 0, actionDelayMs: 0, botDelayMs: 1, ...options });
  await new Promise(resolve => game.httpServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${game.httpServer.address().port}`, clients = [];
  async function connect(token) {
    const client = { socket: io(url, { auth: { token }, transports: ['websocket'] }) };
    clients.push(client);
    client.socket.on('session', data => Object.assign(client, data));
    client.socket.on('state', state => { client.state = state; });
    await until(() => client.token); return client;
  }
  async function action(client, name, data = {}) {
    return client.socket.timeout(2500).emitWithAck(name, { revision: client.state?.revision, ...data });
  }
  async function ok(client, name, data) { const reply = await action(client, name, data); assert.equal(reply.ok, true, reply.error); }
  const host = await connect(); await ok(host, 'create', { name: '玩家甲', mode });
  const players = [host], room = game.rooms.get(host.state.code);
  if (bots) await ok(host, 'fill-bots');
  else for (const name of (mode === 'fourSkills' ? ['玩家乙', '玩家丙', '玩家丁'] : ['玩家乙', '玩家丙'])) { const client = await connect(); await ok(client, 'join', { code: room.code, name }); players.push(client); }
  await until(() => players.every(client => client.state.players.length === (mode === 'fourSkills' ? 4 : 3)));
  t.after(async () => { clients.forEach(client => client.socket.disconnect()); await game.close(); });
  async function begin() {
    for (const client of players) await ok(client, 'ready', { ready: true });
    await until(() => host.state.phase !== 'waiting');
    if (!bots) { await ok(players.find(client => client.id === room.players[room.turn].id), 'bid', { value: 3 }); await until(() => players.every(client => client.state.phase === 'playing')); }
  }
  return { game, players, room, host, action, ok, connect, begin };
}

for (const id of SKILL_IDS) test(`skill ${id}: one use, turn unchanged, correct hand mutation`, async t => {
  const { players, room, begin, ok, action } = await setup(t); await begin();
  const p = room.players[room.turn], client = players.find(item => item.id === p.id), other = room.players.find(item => item !== p);
  p.skill = { id, used: false, choices: null };
  const before = p.hand.map(card => ({ ...card })), otherBefore = other.hand.map(card => ({ ...card })), otherCount = other.hand.length, deadline = room.deadline;
  await ok(client, 'skill', { cardId: (id === 'upgrade' ? before.find(canUpgrade) : before[0]).id, cardIds: before.slice(0, 2).map(card => card.id), targetId: other.id });
  await until(() => players.every(peer => peer.state.skillEvent?.skillId === id));
  for (const peer of players) {
    assert.deepEqual(peer.state.skillEvent, { sequence: 1, playerId: p.id, skillId: id, stage: 'use', ...(['gift', 'steal', 'peek'].includes(id) ? { targetId: other.id } : {}), ...(['gift', 'steal', 'reroll', 'remove'].includes(id) ? { count: 2 } : {}), ...(id === 'upgrade' ? { steps: 1 } : {}) });
    assert.deepEqual(peer.state.skillEvents, [peer.state.skillEvent], 'all seats receive the same public event without card faces');
  }
  assert.equal(p.skill.used, true); assert.equal(room.players[room.turn], p); assert.equal(room.deadline, deadline);
  if (id !== 'gift') assert.equal(room.log.at(-1).includes('交给'), false);
  assert.equal((await action(client, 'skill', { cardId: p.hand[0].id, targetId: other.id })).ok, false);
  const countDelta = { wild: 0, gift: -2, steal: 2, reroll: 0, remove: -2, clone: 2, draw: 4, draft: 0, peek: 0, upgrade: 0 }[id];
  assert.equal(p.hand.length, before.length + countDelta);
  assert.equal(new Set(p.hand.map(card => card.id)).size, p.hand.length);
  if (id === 'gift') { assert.equal(other.hand.length, otherCount + 2); assert.equal(before.filter(card => other.hand.some(item => item.id === card.id)).length, 2); }
  if (id === 'steal') {
    assert.equal(other.hand.length, otherCount - 2);
    assert.equal(otherBefore.filter(card => p.hand.some(item => item.id === card.id)).length, 2);
    assert.deepEqual(new Set([...p.hand, ...other.hand].map(card => card.id)), new Set([...before, ...otherBefore].map(card => card.id)));
    for (const peer of players.filter(item => item !== client && item.id !== other.id)) assert.equal(peer.state.players.find(item => item.id === p.id).hand, undefined);
    assert.match(room.log.at(-1), /拿走2张牌/);
  }
  if (id === 'wild') assert.equal(p.hand.filter(card => card.wild).length, 1);
  if (id === 'remove') for (const card of [...before].sort((a, b) => a.rank - b.rank || a.id - b.id).slice(0, 2)) assert.equal(p.hand.some(item => item.id === card.id), false);
  if (id === 'reroll') for (const card of before.slice(0, 2)) assert.equal(p.hand.some(item => item.id === card.id), false);
  if (id === 'peek') {
    assert.equal(client.state.players.find(item => item.id === p.id).skill.inspection.cards.length, 5);
    for (const peer of players.filter(item => item !== client)) assert.equal(peer.state.players.find(item => item.id === p.id).skill.inspection, undefined);
    assert.equal(other.hand.length, otherCount);
  }
  if (id === 'draft') {
    await until(() => players.every(item => item.state.revision === client.state.revision));
    const choices = p.skill.choices;
    assert.equal(choices.length, 4);
    for (const peer of players.filter(item => item !== client)) assert.equal(peer.state.players.find(item => item.id === p.id).skill.choices, undefined);
    assert.equal((await action(client, 'play', { cards: [p.hand[0].id] })).ok, false);
    assert.equal((await action(client, 'skill-choice', { cardId: -1 })).ok, false);
    await ok(client, 'skill-choice', { cardId: choices[1].id });
    await until(() => players.every(peer => peer.state.skillEvent?.stage === 'choice'));
    for (const peer of players) {
      assert.deepEqual(peer.state.skillEvents.map(event => event.stage), ['use', 'choice']);
      assert.deepEqual(Object.keys(peer.state.skillEvent).sort(), ['playerId', 'sequence', 'skillId', 'stage']);
    }
    assert.equal(p.hand.length, before.length + 1); assert.equal(p.skill.choices, null);
    assert.equal((await action(client, 'skill-choice', { cardId: choices[0].id })).ok, false);
  }
});

test('upgrade crosses A, 2 and joker boundaries without wrapping or consuming invalid uses', () => {
  for (let rank = 3; rank <= 16; rank++) {
    const card = { id: 80, rank, suit: rank >= 16 ? '★' : '♥' };
    const p = { hand: [card], skill: { id: 'upgrade', used: false } };
    const room = { mode: 'skills', phase: 'playing', turn: 0, players: [p] };
    applySkill(room, p, { cardId: card.id }, () => 0);
    assert.equal(p.hand[0].rank, rank + 1);
    assert.equal(p.hand[0].suit, rank >= 15 ? '★' : '♥');
    assert.equal(p.hand[0].id, 80);
  }
  for (const card of [{ id: 81, rank: 17, suit: '★' }, { id: 82, rank: 15, suit: '✦', wild: true }]) {
    const p = { hand: [card], skill: { id: 'upgrade', used: false } };
    assert.throws(() => applySkill({ mode: 'skills', phase: 'playing', turn: 0, players: [p] }, p, { cardId: card.id }, () => 0));
    assert.equal(p.skill.used, false); assert.deepEqual(p.hand, [card]);
  }
});

test('two-card reroll rejects duplicate picks and two-step upgrade stops at big joker', () => {
  const deck = makeDeck();
  const player = { hand: deck.slice(0, 3), skill: { id: 'reroll', used: false } };
  const room = { mode: 'skills', phase: 'playing', turn: 0, players: [player], nextCardId: 54 };
  assert.throws(() => applySkill(room, player, { cardIds: [0, 0] }, () => 0));
  assert.equal(player.skill.used, false);
  applySkill(room, player, { cardIds: [0, 1] }, () => 0);
  assert.deepEqual(new Set(player.hand.map(card => card.id)), new Set([2, 54, 55]));

  for (const rank of [15, 16]) {
    const card = { id: 80, rank, suit: rank === 16 ? '★' : '♠' };
    const actor = { hand: [card], skill: { id: 'upgrade', used: false } };
    const table = { mode: 'skills', phase: 'playing', turn: 0, players: [actor] };
    if (rank === 16) {
      assert.throws(() => applySkill(table, actor, { cardId: 80, steps: 2 }, () => 0));
      assert.equal(actor.skill.used, false);
      applySkill(table, actor, { cardId: 80, steps: 1 }, () => 0);
    } else applySkill(table, actor, { cardId: 80, steps: 2 }, () => 0);
    assert.equal(actor.hand[0].rank, 17);
  }
});

test('peek samples without replacement, shows short hands and stores an immutable private snapshot', async t => {
  for (const count of [1, 2, 3, 17]) {
    const p = { id: 'a', hand: [makeDeck()[50]], skill: { id: 'peek', used: false } };
    const target = { id: 'b', name: '朋友', hand: makeDeck().slice(0, count) };
    applySkill({ mode: 'skills', phase: 'playing', turn: 0, players: [p, target] }, p, { targetId: 'b' }, () => 0);
    assert.equal(p.skill.inspection.cards.length, Math.min(5, count));
    assert.equal(new Set(p.skill.inspection.cards.map(card => card.id)).size, Math.min(5, count));
    const rank = p.skill.inspection.cards.find(card => card.id === target.hand[0].id).rank;
    target.hand[0].rank = 17;
    assert.equal(p.skill.inspection.cards.find(card => card.id === target.hand[0].id).rank, rank);
  }
  const { players, room, begin, ok, action, connect } = await setup(t); await begin();
  const p = room.players[room.turn], client = players.find(item => item.id === p.id), target = room.players.find(item => item !== p);
  p.skill = { id: 'peek', used: false };
  for (const targetId of [p.id, 'forged']) assert.equal((await action(client, 'skill', { targetId })).ok, false);
  await ok(client, 'skill', { targetId: target.id });
  const expected = structuredClone(p.skill.inspection);
  client.socket.disconnect(); const resumed = await connect(client.token);
  await until(() => resumed.state?.players.find(item => item.id === p.id)?.skill.inspection);
  assert.deepEqual(resumed.state.players.find(item => item.id === p.id).skill.inspection, expected);
  for (const peer of players.filter(item => item !== client)) assert.equal(peer.state.players.find(item => item.id === p.id).skill.inspection, undefined);
});

test('skills reject classic mode, wrong turns, forged targets and stale requests', async t => {
  const classic = await setup(t, 'classic'); await classic.begin();
  assert.ok(classic.room.players.every(player => player.skill === null));
  assert.equal((await classic.action(classic.players[classic.room.turn], 'skill')).ok, false);
  const { players, room, begin, action } = await setup(t); await begin();
  const p = room.players[room.turn], client = players.find(item => item.id === p.id);
  p.skill = { id: 'gift', used: false };
  const other = players.find(item => item !== client);
  assert.equal((await action(other, 'skill')).ok, false);
  assert.equal((await action(client, 'skill', { targetId: 'forged' })).ok, false);
  assert.equal((await action(client, 'skill', { cardId: p.hand[0].id, targetId: p.id })).ok, false);
  assert.equal((await action(client, 'skill', { revision: -1, cardId: p.hand[0].id, targetId: other.id })).code, 'STALE_STATE');
  assert.equal(p.skill.used, false);
});

test('wildcard can represent a big joker and complete a rocket, but cannot forge ordinary cards', async t => {
  const { players, room, begin, action, ok } = await setup(t); await begin();
  const p = room.players[room.turn], client = players.find(item => item.id === p.id);
  p.hand = makeDeck().filter(card => card.id === 0 || card.rank >= 16); p.skill = { id: 'wild', used: false };
  await ok(client, 'skill');
  const wildcard = p.hand.find(card => card.wild), joker = p.hand.find(card => !card.wild && card.rank >= 16);
  const forged = p.hand.find(card => !card.wild).id;
  assert.equal((await action(client, 'play', { cards: [forged], wildRanks: { [forged]: 17 } })).ok, false);
  assert.equal((await action(client, 'play', { cards: [wildcard.id, joker.id], wildRanks: { [wildcard.id]: 18 } })).ok, false);
  await ok(client, 'play', { cards: [wildcard.id, joker.id], wildRanks: { [wildcard.id]: joker.rank === 16 ? 17 : 16 } });
  assert.equal(room.lastPlay.combo.type, 'rocket'); assert.equal(p.hand.length, 1);
});

for (const id of ['gift', 'remove']) test(`${id} can win by emptying the hand; next deal refreshes all skills`, async t => {
  const { players, room, begin, ok } = await setup(t); await begin();
  const p = room.players[room.turn], client = players.find(item => item.id === p.id);
  p.hand = [p.hand[0]]; p.skill = { id, used: false };
  await ok(client, 'skill', { cardId: p.hand[0].id, targetId: players.find(item => item !== client).id });
  assert.equal(room.phase, 'finished'); assert.equal(room.result.winnerId, p.id);
  await until(() => players.every(item => item.state.phase === 'finished'));
  for (const peer of players) await ok(peer, 'ready', { ready: true });
  assert.equal(room.phase, 'bidding'); assert.ok(room.players.every(item => SKILL_IDS.includes(item.skill.id) && !item.skill.used));
});

for (const mode of ['skills', 'fourSkills']) for (const count of [1, 2]) test(`steal in ${mode} transfers ${count} remaining cards and awards the emptied target`, async t => {
  const { players, room, begin, ok, action } = await setup(t, mode); await begin();
  const actor = room.players[room.turn], client = players.find(item => item.id === actor.id);
  const target = room.players.find(item => item !== actor), taken = target.hand.slice(0, count);
  const actorBefore = actor.hand.length;
  actor.skill = { id: 'steal', used: false, choices: null }; target.hand = taken;
  assert.equal((await action(client, 'skill', { targetId: actor.id })).ok, false);
  assert.equal((await action(client, 'skill', { targetId: 'invalid' })).ok, false);
  assert.equal(actor.skill.used, false);
  await ok(client, 'skill', { targetId: target.id });
  assert.equal(room.phase, 'finished'); assert.equal(room.result.winnerId, target.id);
  assert.equal(target.hand.length, 0); assert.equal(actor.hand.length, actorBefore + count);
  assert.ok(taken.every(card => actor.hand.some(item => item.id === card.id)));
  await until(() => players.every(peer => peer.state.phase === 'finished'));
  assert.equal(client.state.skillEvent.count, count);
  assert.equal((await action(client, 'skill', { targetId: target.id })).ok, false);
});

test('pending draft survives reconnect and a timeout finishes the choice', async t => {
  const { players, room, begin, ok, connect } = await setup(t, 'skills', false, { turnMs: 1000 }); await begin();
  const p = room.players[room.turn], client = players.find(item => item.id === p.id);
  p.skill = { id: 'draft', used: false }; await ok(client, 'skill');
  const choices = p.skill.choices.map(card => card.id), before = p.hand.length;
  client.socket.disconnect(); const resumed = await connect(client.token);
  await until(() => resumed.state?.phase === 'playing');
  assert.deepEqual(resumed.state.players.find(item => item.id === p.id).skill.choices.map(card => card.id), choices);
  await until(() => room.players[room.turn] !== p);
  assert.equal(p.skill.choices, null); assert.equal(p.hand.length, before);
});

test('generated cards remain unique past 20 cards and wildcard hints remain legal', () => {
  const p = { hand: makeDeck().slice(0, 22), skill: { id: 'draw', used: false } };
  const room = { mode: 'skills', phase: 'playing', turn: 0, players: [p], nextCardId: 54 };
  applySkill(room, p, {}, () => 0);
  assert.equal(p.hand.length, 26); assert.equal(new Set(p.hand.map(card => card.id)).size, 26);
  const hand = [makeDeck()[52], { id: 60, rank: 15, suit: '✦', wild: true }];
  const hint = findSkillHint(hand, classify(makeDeck().slice(0, 4)));
  assert.equal(classify(hint).type, 'rocket');
  assert.equal(resolveWildCards(hint, { 60: 17 })[1].rank, 17);
});

for (const [id, rank] of [['upgrade', 17], ['upgrade', 15], ['peek', 17]]) test(`bot ${id} handles rank ${rank} without stalling`, async t => {
  const { room, host, begin, ok } = await setup(t, 'skills', true, { botDelayMs: 100 }); await begin();
  clearTimeout(room.timer);
  const human = room.players.find(p => p.id === host.id), bot = room.players[1];
  room.phase = 'playing'; room.turn = 0; room.landlordId = human.id; room.lastPlay = null; room.actionAt = 0; room.multiplier = 1;
  bot.hand = [makeDeck().find(card => card.rank === rank)]; bot.skill = { id, used: false };
  await ok(host, 'play', { cards: [human.hand.find(card => card.rank < 15).id] });
  await until(() => room.phase === 'finished');
  assert.equal(room.result.winnerId, bot.id);
  assert.equal(bot.skill.used, id !== 'upgrade' || rank < 17);
  if (id === 'peek') {
    assert.equal(bot.skill.inspection.targetId, human.id);
    assert.equal(host.state.players.find(p => p.id === bot.id).skill.inspection, undefined);
  }
});

test('a human and two bots complete a skill-mode game without stalling', { timeout: 25000 }, async t => {
  const { room, host, begin, ok } = await setup(t, 'skills', true); await begin();
  for (let step = 0; step < 500 && room.phase !== 'finished'; step++) {
    if (host.state.turnId !== host.id) { await sleep(5); continue; }
    if (room.phase === 'bidding') { await ok(host, 'bid', { value: 3 }); continue; }
    const p = room.players.find(item => item.id === host.id);
    if (!p.skill.used && (p.skill.id !== 'upgrade' || p.hand.some(canUpgrade))) { await ok(host, 'skill', { cardId: (p.skill.id === 'upgrade' ? p.hand.find(canUpgrade) : p.hand.at(-1)).id, cardIds: p.hand.slice(0, 2).map(card => card.id), targetId: room.players.find(item => item !== p).id }); if (room.phase === 'finished') break; }
    if (p.skill.choices) await ok(host, 'skill-choice', { cardId: p.skill.choices[0].id });
    const hint = findSkillHint(p.hand, room.lastPlay?.combo);
    if (hint) await ok(host, 'play', { cards: hint.map(card => card.id), wildRanks: Object.fromEntries(hint.filter(card => card.wild).map(card => [card.id, card.rank])) });
    else await ok(host, 'pass');
  }
  assert.equal(room.phase, 'finished');
});
