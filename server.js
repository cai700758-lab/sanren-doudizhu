import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Server } from 'socket.io';
import { makeDeck, sortCards, classify, beats, MODES, modeRules, isSkillMode, isRaceMode } from './lib/game.js';
import { chooseBotBid, chooseBotPlay } from './lib/bot.js';
import { SKILLS, SKILL_IDS, applySkill, chooseSkillCard, resolveWildCards, wildHands, canUpgrade } from './lib/skills.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TURN_MS = 45_000;
const fail = (message, code = 'INVALID_ACTION') => { throw Object.assign(new Error(message), { code }); };

export function createGameServer({ turnMs = TURN_MS, botDelayMs = 2200, dealDelayMs = 2600, actionDelayMs = 1000 } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'");
    next();
  });
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/tokens.css', (_req, res) => res.sendFile(path.join(ROOT, 'tokens.css')));
  app.get('/game.js', (_req, res) => res.sendFile(path.join(ROOT, 'lib/game.js')));
  app.get('/skills.js', (_req, res) => res.sendFile(path.join(ROOT, 'lib/skills.js')));
  app.use(express.static(path.join(ROOT, 'public')));
  const httpServer = createServer(app);
  const io = new Server(httpServer, { maxHttpBufferSize: 16_384 });
  const rooms = new Map();
  const sessions = new Map();
  const stopTimer = room => { clearTimeout(room.timer); room.timer = null; room.deadline = null; };
  const active = room => ['bidding', 'playing'].includes(room.phase);
  const log = (room, text) => { room.log.push(text); room.log = room.log.slice(-30); };
  function snapshot(room, me) {
    return {
      code: room.code, mode: room.mode || 'classic', capacity: modeRules(room.mode).players, revision: room.revision, phase: room.phase, me: me.id,
      hostId: room.hostId, round: room.round, turnId: room.players[room.turn]?.id,
      landlordId: room.landlordId, highestBid: room.highestBid, multiplier: room.multiplier,
      deadline: room.deadline, actionAt: room.actionAt || 0, serverNow: Date.now(), bottom: room.landlordId ? room.bottom : [],
      drawCount: room.drawPile?.length || 0, openingLead: Boolean(room.openingLead),
      lastPlay: room.lastPlay, tablePlays: room.tablePlays || {}, dealId: room.dealId || 0,
      tablePasses: room.tablePasses || {}, result: room.result, log: room.log, skillEvent: room.skillEvent || null,
      skillEvents: room.skillEvents || [],
      players: room.players.map(p => ({
        id: p.id, name: p.name, bot: Boolean(p.bot), connected: Boolean(p.bot || p.socketId), ready: p.ready,
        count: p.hand.length, hand: p.id === me.id || room.phase === 'finished' ? p.hand : undefined,
        score: p.score, playedCount: p.playedCount || 0, bid: p.bid, lastAction: p.lastAction,
        skill: p.skill ? { id: p.skill.id, used: p.skill.used, pending: Boolean(p.skill.choices), choices: p.id === me.id ? p.skill.choices || [] : undefined,
          inspection: p.id === me.id ? p.skill.inspection : undefined } : null,
      })),
    };
  }
  function publish(room) {
    room.revision++;
    room.updatedAt = Date.now();
    for (const p of room.players) if (p.socketId) io.to(p.socketId).emit('state', snapshot(room, p));
  }
  function schedule(room, pauseMs = actionDelayMs) {
    stopTimer(room);
    if (!active(room)) return;
    room.actionAt = Date.now() + pauseMs;
    room.deadline = room.actionAt + turnMs;
    delete room.tablePasses[room.players[room.turn].id];
    const actor = room.players[room.turn];
    const thinkingMs = actor.bot ? Math.min(turnMs, botDelayMs * (actor.hand.length <= 2 ? .65 : room.lastPlay ? 1 : .85)) : turnMs;
    room.timer = setTimeout(() => {
      const p = room.players[room.turn];
      if (!p) return;
      if (p.skill?.choices) completeSkillChoice(room, p, p.skill.choices[0].id);
      if (p.bot) {
        if (room.phase === 'bidding') bid(room, p, chooseBotBid(p.hand, room.highestBid));
        else {
          if (p.skill && !p.skill.used && (p.skill.id !== 'upgrade' || p.hand.some(canUpgrade))) {
            const recipient = ['peek', 'steal'].includes(p.skill.id)
              ? room.players.find(player => player !== p && (p.id === room.landlordId || player.id === room.landlordId) && (p.skill.id !== 'steal' || player.hand.length > 2))
              : room.players.find(player => player !== p && player.id !== room.landlordId && p.id !== room.landlordId) || room.players.find(player => player !== p);
            const skillCard = p.skill.id === 'upgrade' ? p.hand.find(canUpgrade) : p.hand.at(-1);
            if (recipient) useSkill(room, p, { cardId: skillCard.id, cardIds: p.skill.id === 'reroll' ? p.hand.slice(0, 2).map(card => card.id) : undefined, steps: p.skill.id === 'upgrade' ? Math.min(2, 17 - skillCard.rank) : undefined, targetId: recipient.id });
            if (room.phase === 'finished') { publish(room); return; }
            if (p.skill.choices) completeSkillChoice(room, p, p.skill.choices[0].id);
          }
          const table = {
            mode: room.mode, selfId: p.id, landlordId: room.landlordId, lastPlay: room.lastPlay,
            players: room.players.map(player => ({ id: player.id, count: player.hand.length })),
          };
          let cards = null;
          for (const variant of wildHands(p.hand)) {
            const candidate = chooseBotPlay(variant, table);
            if (candidate && (!cards || candidate.length > cards.length)) cards = candidate;
          }
          if (room.openingLead) cards = [p.hand.find(card => card.id === 1)];
          if (cards) play(room, p, cards.map(c => c.id), false, Object.fromEntries(cards.filter(c => c.wild).map(c => [c.id, c.rank])));
          else pass(room, p);
        }
      } else if (room.phase === 'bidding') bid(room, p, 0, true);
      else if (room.lastPlay) pass(room, p, true);
      else play(room, p, [room.openingLead ? p.hand.find(card => card.id === 1).id : p.hand.at(-1).id], true);
      publish(room);
    }, pauseMs + thinkingMs);
    room.timer.unref?.();
  }
  function deal(room, redeal = false) {
    stopTimer(room);
    const rules = modeRules(room.mode);
    const deck = makeDeck(room.mode);
    const shuffle = (cards, start = 0, end = cards.length) => {
      for (let i = end - 1; i > start; i--) { const j = start + randomInt(i - start + 1); [cards[i], cards[j]] = [cards[j], cards[i]]; }
    };
    if (isRaceMode(room.mode)) { shuffle(deck, 0, 54); shuffle(deck, 54, 108); }
    else shuffle(deck);
    if (!redeal) room.round++;
    room.dealId = (room.dealId || 0) + 1; room.playSequence = 0; room.tablePlays = {}; room.tablePasses = {};
    room.nextCardId = deck.length; room.skillEvent = null; room.skillSequence = 0; room.skillEvents = [];
    room.phase = isRaceMode(room.mode) ? 'playing' : 'bidding'; room.landlordId = null; room.lastPlay = null; room.result = null;
    room.highestBid = 0; room.bidderId = null; room.bidCount = 0; room.multiplier = 1; room.passes = 0;
    room.bottom = isRaceMode(room.mode) ? [] : deck.slice(rules.players * rules.dealt);
    room.drawPile = isRaceMode(room.mode) ? deck.slice(54) : [];
    room.discardPile = []; room.openingLead = isRaceMode(room.mode);
    room.turn = randomInt(rules.players);
    room.players.forEach((p, i) => { p.hand = sortCards(deck.slice(i * rules.dealt, (i + 1) * rules.dealt)); p.ready = false; p.bid = null; p.lastAction = ''; p.playCount = 0; p.playedCount = 0; });
    if (room.openingLead) room.turn = room.players.findIndex(player => player.hand.some(card => card.id === 1));
    room.players.forEach(p => { p.skill = isSkillMode(room.mode) ? { id: SKILL_IDS[randomInt(SKILL_IDS.length)], used: false, choices: null } : null; });
    log(room, room.openingLead ? `第 ${room.round} 局开始，${room.players[room.turn].name}持有红桃3，率先出牌。` : redeal ? '所有人都不叫，重新洗牌。' : `第 ${room.round} 局开始，轮流叫分。`);
    schedule(room, dealDelayMs);
  }
  function bid(room, p, value, auto = false) {
    if (room.phase !== 'bidding' || room.players[room.turn] !== p) fail('还没轮到你叫分。');
    if (!Number.isInteger(value) || value < 0 || value > 3 || (value !== 0 && value <= room.highestBid)) fail('叫分必须高于当前分数。');
    p.bid = value; p.lastAction = value ? `叫 ${value} 分` : '不叫';
    log(room, `${p.name}${auto ? '超时，' : '：'}${p.lastAction}`);
    if (value) { room.highestBid = value; room.bidderId = p.id; }
    room.bidCount++;
    if (value === 3 || room.bidCount === modeRules(room.mode).players) {
      if (!room.bidderId) return deal(room, true);
      room.landlordId = room.bidderId;
      room.turn = room.players.findIndex(player => player.id === room.landlordId);
      const landlord = room.players[room.turn];
      landlord.hand = sortCards([...landlord.hand, ...room.bottom]);
      room.phase = 'playing'; room.multiplier = room.highestBid;
      room.players.forEach(player => { player.lastAction = ''; });
      log(room, `${landlord.name}成为地主，先出牌。`);
    } else room.turn = (room.turn + 1) % modeRules(room.mode).players;
    schedule(room, actionDelayMs * 1.3);
  }
  function finish(room, winner) {
    stopTimer(room);
    const landlord = room.players.find(p => p.id === room.landlordId);
    const landlordWon = winner.id === landlord.id;
    const spring = landlordWon ? room.players.filter(p => p !== landlord).every(p => p.playCount === 0) : landlord.playCount === 1;
    if (spring) room.multiplier *= 2;
    const deltas = room.players.map(p => {
      const won = (p === landlord) === landlordWon;
      const delta = room.multiplier * (p === landlord ? modeRules(room.mode).players - 1 : 1) * (won ? 1 : -1);
      p.score += delta; p.ready = Boolean(p.bot);
      return { id: p.id, delta };
    });
    room.phase = 'finished';
    room.actionAt = 0;
    room.result = { winnerId: winner.id, landlordWon, spring, multiplier: room.multiplier, deltas };
    log(room, `${landlordWon ? '地主' : '农民'}获胜${spring ? '，春天翻倍' : ''}，本局 ${room.multiplier} 倍。`);
  }
  function finishRace(room, winner) {
    stopTimer(room);
    const deltas = room.players.map(player => {
      const delta = player === winner ? 1 : 0;
      player.score += delta; player.ready = Boolean(player.bot);
      return { id: player.id, delta };
    });
    room.phase = 'finished'; room.actionAt = 0;
    room.result = { winnerId: winner.id, race: true, deltas };
    log(room, `${winner.name}累计打出${winner.playedCount}张牌，率先达到30张，获胜。`);
  }
  function drawRaceCards(room, player, count) {
    for (let i = 0; i < count; i++) {
      if (!room.drawPile.length) {
        room.drawPile = room.discardPile.splice(0);
        for (let j = room.drawPile.length - 1; j > 0; j--) { const k = randomInt(j + 1); [room.drawPile[j], room.drawPile[k]] = [room.drawPile[k], room.drawPile[j]]; }
        log(room, '抽牌堆已用完，弃牌重新洗入抽牌堆。');
      }
      player.hand.push(room.drawPile.pop());
    }
    player.hand = sortCards(player.hand);
  }
  function recordSkillEvent(room, p, skillId, extra = {}) {
    // Only public effects travel to other seats; card faces and draft choices stay private.
    room.skillEvent = { sequence: ++room.skillSequence, playerId: p.id, skillId, stage: 'use', ...extra };
    room.skillEvents = [...(room.skillEvents || []), room.skillEvent].slice(-12);
  }
  function completeSkillChoice(room, p, cardId) {
    chooseSkillCard(room, p, cardId);
    recordSkillEvent(room, p, 'draft', { stage: 'choice' });
    log(room, `${p.name}完成四选一，获得一张牌。`);
  }
  function useSkill(room, p, data) {
    const effect = applySkill(room, p, data, randomInt);
    p.lastAction = `技能 · ${SKILLS[effect.id].name}`;
    recordSkillEvent(room, p, effect.id, { ...(effect.targetId ? { targetId: effect.targetId } : {}), ...(effect.steps ? { steps: effect.steps } : {}), ...(effect.count ? { count: effect.count } : {}) });
    const targetName = room.players.find(player => player.id === effect.targetId)?.name;
    log(room, `${p.name}使用${SKILLS[effect.id].name}${effect.id === 'gift' ? `，交给${targetName}${effect.count}张牌` : effect.id === 'steal' ? `，从${targetName}手中拿走${effect.count}张牌` : effect.id === 'peek' ? `，查看${targetName}的随机手牌` : effect.id === 'upgrade' ? `，升${effect.steps}级` : ''}。`);
    if (!p.hand.length) finish(room, p);
    else if (effect.id === 'steal') {
      const target = room.players.find(player => player.id === effect.targetId);
      if (!target.hand.length) finish(room, target);
    }
  }
  function play(room, p, ids, auto = false, assignments = {}) {
    if (room.phase !== 'playing' || room.players[room.turn] !== p) fail('还没轮到你出牌。');
    if (p.skill?.choices) fail('请先完成技能选牌。');
    if (!Array.isArray(ids) || !ids.length || ids.length > modeRules(room.mode).maxHand || new Set(ids).size !== ids.length) fail('请选择要出的牌。');
    let cards = ids.map(id => p.hand.find(c => c.id === id));
    if (cards.some(c => !c)) fail('只能打出自己手中的牌。');
    cards = resolveWildCards(cards, assignments);
    const combo = classify(cards, room.mode);
    if (!combo) fail('这些牌不能组成有效牌型，请重新选择。');
    if (room.openingLead && !cards.some(card => card.id === 1)) fail('首手必须带上红桃3。');
    if (!beats(combo, room.lastPlay?.combo)) fail('这手牌压不过桌面上的牌。');
    p.hand = p.hand.filter(c => !ids.includes(c.id)); p.playCount++;
    p.lastAction = `${auto ? '托管 · ' : ''}${combo.name}`;
    room.lastPlay = { playerId: p.id, cards: sortCards(cards), combo };
    room.tablePlays[p.id] = { ...room.lastPlay, sequence: ++room.playSequence };
    delete room.tablePasses[p.id];
    room.passes = 0;
    if (!isRaceMode(room.mode) && ['bomb', 'rocket'].includes(combo.type)) room.multiplier *= 2;
    if (isRaceMode(room.mode)) {
      room.openingLead = false;
      p.playedCount += cards.length;
      room.discardPile.push(...cards);
      drawRaceCards(room, p, cards.length);
      log(room, `${p.name}${auto ? '超时，自动打出' : '打出'}${combo.name}${cards.length}张，累计 ${p.playedCount}/30。`);
      if (p.playedCount >= 30) return finishRace(room, p);
      room.turn = (room.turn + 1) % modeRules(room.mode).players;
      schedule(room, actionDelayMs * (['bomb', 'rocket', 'superBomb'].includes(combo.type) ? 1.8 : 1));
      return;
    }
    log(room, `${p.name}${auto ? '超时，自动打出' : '打出'}${combo.name}${p.hand.length <= 2 ? `，剩 ${p.hand.length} 张` : ''}`);
    if (!p.hand.length) return finish(room, p);
    room.turn = (room.turn + 1) % modeRules(room.mode).players;
    schedule(room, actionDelayMs * (['bomb', 'rocket'].includes(combo.type) ? 1.8 : 1));
  }
  function pass(room, p, auto = false) {
    if (room.phase !== 'playing' || room.players[room.turn] !== p) fail('还没轮到你。');
    if (p.skill?.choices) fail('请先完成技能选牌。');
    if (!room.lastPlay || room.lastPlay.playerId === p.id) fail('新一轮由你领出，不能不出。');
    p.lastAction = auto ? '超时 · 不出' : '不出'; log(room, `${p.name}：${p.lastAction}`);
    delete room.tablePlays[p.id];
    room.tablePasses[p.id] = { sequence: ++room.playSequence, auto };
    room.passes++; room.turn = (room.turn + 1) % modeRules(room.mode).players;
    if (room.passes === modeRules(room.mode).players - 1) {
      room.turn = room.players.findIndex(player => player.id === room.lastPlay.playerId);
      room.lastPlay = null; room.passes = 0;
      room.tablePlays = {};
      room.players.forEach(player => { player.lastAction = ''; });
    }
    schedule(room, actionDelayMs * 1.15);
  }
  function leave(p) {
    const room = rooms.get(p.roomCode);
    p.roomCode = null;
    if (!room) return;
    if (active(room)) {
      stopTimer(room); room.phase = 'waiting'; room.lastPlay = null; room.tablePlays = {}; room.tablePasses = {}; room.result = null; room.landlordId = null;
      room.drawPile = []; room.discardPile = []; room.openingLead = false;
      room.players.forEach(player => { player.ready = Boolean(player.bot); player.hand = []; player.bid = null; player.lastAction = ''; player.skill = null; player.playedCount = 0; });
      log(room, `${p.name}离开，本局取消，不计分。等待新玩家加入。`);
    } else log(room, `${p.name}离开房间。`);
    room.players = room.players.filter(player => player !== p);
    if (!room.players.some(player => !player.bot)) { stopTimer(room); rooms.delete(room.code); }
    else {
      if (room.hostId === p.id) room.hostId = room.players.find(player => !player.bot).id;
      if (room.phase === 'finished') { room.phase = 'waiting'; room.result = null; room.landlordId = null; room.lastPlay = null; room.tablePlays = {}; room.players.forEach(player => { player.hand = []; player.ready = Boolean(player.bot); player.skill = null; }); }
      publish(room);
    }
  }
  function startIfReady(room) {
    if (room.players.length === modeRules(room.mode).players && room.players.every(player => player.ready && (player.bot || player.socketId))) deal(room);
  }
  io.on('connection', socket => {
    const token = socket.handshake.auth?.token;
    let p = typeof token === 'string' ? sessions.get(token) : null;
    if (!p) {
      p = { id: randomBytes(8).toString('hex'), token: randomBytes(32).toString('hex'), name: '', score: 0, hand: [], ready: false, roomCode: null };
      sessions.set(p.token, p);
    }
    if (p.socketId) { io.to(p.socketId).emit('replaced'); io.sockets.sockets.get(p.socketId)?.disconnect(true); }
    p.socketId = socket.id; p.lastSeen = Date.now();
    socket.emit('session', { token: p.token, id: p.id });
    if (p.roomCode && rooms.has(p.roomCode)) publish(rooms.get(p.roomCode));
    else socket.emit('state', null);
    let windowStart = Date.now(), count = 0;
    const on = (name, fn) => socket.on(name, (data = {}, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (Date.now() - windowStart > 10_000) { windowStart = Date.now(); count = 0; }
        if (++count > 80) fail('操作太频繁，请稍后再试。');
        if (p.socketId !== socket.id) fail('此页面已在其他窗口接管，请刷新。');
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail('请求格式不正确。');
        p.lastSeen = Date.now();
        fn(data); ack({ ok: true });
      } catch (error) { ack({ ok: false, error: error.message, code: error.code || 'INVALID_ACTION' }); }
    });
    const getRoom = () => { const room = rooms.get(p.roomCode); if (!room) fail('房间已失效，请重新创建或加入。'); return room; };
    const setName = data => {
      const name = typeof data.name === 'string' ? data.name.trim() : '';
      if (!name || [...name].length > 12 || /[\x00-\x1f\x7f]/.test(name)) fail('请填写 1–12 个字的昵称。');
      p.name = name;
    };
    on('create', data => {
      if (p.roomCode) fail('请先离开当前房间。');
      if (rooms.size >= 1000) fail('房间已满，请稍后再试。');
      setName(data);
      if (data.mode !== undefined && !Object.hasOwn(MODES, data.mode)) fail('请选择有效的游戏模式。');
      let code; do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
      p.roomCode = code; p.hand = []; p.ready = false; p.score = 0; p.bid = null; p.lastAction = '';
      const room = { code, hostId: p.id, players: [p], phase: 'waiting', revision: 0, round: 0, turn: 0, landlordId: null, bottom: [], highestBid: 0, multiplier: 1, lastPlay: null, result: null, log: ['房间已创建，把邀请链接发给朋友吧。'], updatedAt: Date.now() };
      room.mode = data.mode || 'classic'; p.skill = null;
      rooms.set(code, room); publish(room);
    });
    on('join', data => {
      if (p.roomCode) fail('请先离开当前房间。');
      const code = typeof data.code === 'string' ? data.code.trim() : '';
      if (!/^\d{6}$/.test(code)) fail('请输入 6 位房间码。');
      const room = rooms.get(code);
      if (!room) fail('找不到这个房间，请检查房间码。');
      if (active(room)) fail('这局已经开始，请等待下一局。');
      const replacement = room.players.length >= modeRules(room.mode).players ? room.players.find(player => player.bot) : null;
      if (room.players.length >= modeRules(room.mode).players && !replacement) fail(`房间已坐满 ${modeRules(room.mode).players} 人。`);
      setName(data);
      if (replacement) leave(replacement);
      p.roomCode = room.code; p.hand = []; p.ready = false; p.score = 0; p.bid = null; p.lastAction = '';
      p.skill = null;
      room.players.push(p); log(room, `${p.name}加入了房间。`); publish(room);
    });
    on('leave', () => { leave(p); socket.emit('state', null); });
    on('fill-bots', () => {
      const room = getRoom();
      if (room.hostId !== p.id) fail('只有房主可以添加机器人。');
      if (active(room)) fail('请在本局结束后添加机器人。');
      if (room.players.length >= modeRules(room.mode).players) fail('座位已满。');
      const names = ['小麦', '豆豆', '芽芽'];
      while (room.players.length < modeRules(room.mode).players) {
        const name = names.find(name => !room.players.some(player => player.name === name)) || '机器人';
        room.players.push({ id: randomBytes(8).toString('hex'), name, bot: true, socketId: null, roomCode: room.code, hand: [], score: 0, ready: true, bid: null, lastAction: '', playCount: 0 });
        log(room, `${name}（机器人）加入房间。`);
      }
      startIfReady(room); publish(room);
    });
    on('remove-bot', data => {
      const room = getRoom();
      if (room.hostId !== p.id) fail('只有房主可以移除机器人。');
      if (active(room)) fail('请在本局结束后移除机器人。');
      const bot = room.players.find(player => player.id === data.id && player.bot);
      if (!bot) fail('该座位不是机器人。');
      leave(bot);
    });
    on('ready', data => {
      const room = getRoom();
      if (!['waiting', 'finished'].includes(room.phase)) fail('对局已经开始。');
      if (typeof data.ready !== 'boolean') fail('准备状态不正确。');
      p.ready = data.ready;
      startIfReady(room);
      publish(room);
    });
    for (const [event, fn] of [['bid', (r, d) => bid(r, p, d.value)], ['play', (r, d) => play(r, p, d.cards, false, d.wildRanks)], ['pass', r => pass(r, p)], ['skill', (r, d) => useSkill(r, p, d)], ['skill-choice', (r, d) => completeSkillChoice(r, p, d.cardId)]]) {
      on(event, data => {
        const room = getRoom();
        if (data.revision !== room.revision) fail('牌桌已更新，请按当前轮次重新操作。', 'STALE_STATE');
        if (Date.now() < room.actionAt) fail('请稍等，上一手牌正在展示。', 'TRANSITION');
        fn(room, data); publish(room);
      });
    }
    let lastChat = 0;
    on('chat', data => {
      const room = getRoom();
      const phrases = ['大家好，来一局！', '这手牌有点意思。', '打得漂亮！', '别急，慢慢来。', '承让，下局继续！'];
      if (!Number.isInteger(data.index) || !phrases[data.index]) fail('请选择一条快捷消息。');
      if (Date.now() - lastChat < 2000) fail('消息发送太快了。');
      lastChat = Date.now();
      for (const player of room.players) if (player.socketId) io.to(player.socketId).emit('chat', { playerId: p.id, name: p.name, text: phrases[data.index] });
    });
    socket.on('disconnect', () => {
      if (p.socketId !== socket.id) return;
      p.socketId = null; p.lastSeen = Date.now();
      const room = rooms.get(p.roomCode);
      if (room) { p.ready = false; publish(room); }
    });
  });
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const p of sessions.values()) if (!p.socketId && now - p.lastSeen > 30 * 60_000) { leave(p); sessions.delete(p.token); }
  }, 60_000);
  cleanup.unref();
  return { app, io, httpServer, rooms, sessions, close: async () => {
    clearInterval(cleanup); for (const room of rooms.values()) stopTimer(room);
    await new Promise(resolve => io.close(resolve));
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const game = createGameServer();
  const port = Number(process.env.PORT || 3000);
  game.httpServer.listen(port, '0.0.0.0', () => {
    console.log(`\n三人斗地主已启动\n本机：http://localhost:${port}`);
    for (const list of Object.values(networkInterfaces())) for (const address of list || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) console.log(`局域网：http://${address.address}:${port}`);
    }
    console.log('同一 Wi-Fi 的朋友访问局域网地址即可加入。按 Ctrl+C 停止。\n');
  });
  game.httpServer.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 被占用，请关闭已启动的游戏或设置 PORT。` : error.message); process.exitCode = 1; game.close(); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => game.close().then(() => process.exit(0)));
}
