import { classify as classifyCards, beats, findHint as hintCards, findClosestSelection as closestCards, rankLabel, MODES, modeRules, isFourMode, isSkillMode, isRaceMode, RACE_TARGET } from '/game.js';
import { tableCues } from './table-cues.js';
import { createTableSound } from './sound.js';
import { comboEffect, comboArtwork } from './combo-effects.js';
import { SKILLS, findSkillHint } from '/skills.js';
import { createSkillUI } from './skill-ui.js';
import { createSkillEffects } from './skill-effects.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const storage = {
  get(key, persistent = false) { try { return (persistent ? localStorage : sessionStorage).getItem(key); } catch { return null; } },
  set(key, value, persistent = false) { try { (persistent ? localStorage : sessionStorage).setItem(key, value); } catch { /* Private browser storage can be unavailable. */ } },
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const landscapeTable = matchMedia('(orientation: landscape) and (max-height: 550px)');
let hapticsEnabled = storage.get('sanren-haptics', true) !== 'off';
let soundEnabled = storage.get('sanren-sound', true) !== 'off';
const tableSound = createTableSound(() => soundEnabled);
const hapticsSupported = typeof navigator.vibrate === 'function';
$('#haptics-toggle').checked = hapticsEnabled;
$('#haptics-toggle').disabled = !hapticsSupported;
$('#sound-toggle').checked = soundEnabled;
if (!hapticsSupported) $('#haptics-description').textContent = '此浏览器不支持振动，保留按压动效';
else if (reducedMotion.matches) $('#haptics-description').textContent = '已跟随系统减少动态效果，暂停振动';
reducedMotion.addEventListener('change', () => {
  if (!hapticsSupported) return;
  $('#haptics-description').textContent = reducedMotion.matches ? '已跟随系统减少动态效果，暂停振动' : '选牌和操作时轻振动';
  if (reducedMotion.matches) { try { navigator.vibrate(0); } catch { /* Optional hardware. */ } }
});

function feedback(kind = 'tap') {
  // Optional device feedback must never interrupt card selection or network actions.
  if (hapticsEnabled && hapticsSupported && !reducedMotion.matches && document.visibilityState === 'visible') {
    try { navigator.vibrate(kind === 'error' ? [15, 35, 15] : kind === 'success' ? [10, 25, 18] : kind === 'turn' ? 18 : 8); } catch { /* Device policy can disable vibration. */ }
  }
  tableSound.play(kind);
}
document.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  const target = event.target.closest('button:not(:disabled), input[role="switch"]:not(:disabled)');
  if (target) feedback('tap');
}, { passive: true });
document.addEventListener('click', event => {
  if (event.detail === 0 && event.target.closest('button:not(:disabled)')) feedback('tap');
}, { capture: true });
$('#haptics-toggle').addEventListener('change', event => {
  hapticsEnabled = event.target.checked; storage.set('sanren-haptics', hapticsEnabled ? 'on' : 'off', true);
  if (hapticsEnabled) feedback('tap');
  else { try { navigator.vibrate?.(0); } catch { /* No hardware available. */ } }
});
$('#sound-toggle').addEventListener('change', event => {
  soundEnabled = event.target.checked; storage.set('sanren-sound', soundEnabled ? 'on' : 'off', true);
  if (soundEnabled) feedback('success');
  else tableSound.stop();
});
$('#feedback-button').addEventListener('click', () => $('#feedback-dialog').showModal());
$('#table-button').addEventListener('click', () => {
  const heading = state ? $('#room-title') : $('#entry-heading');
  heading.tabIndex = -1; heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'nearest' });
});
let state = null, selected = new Set(), recentDrawn = new Map(), busy = false, connected = false, clockOffset = 0, toastTimer;
let selectionAssistTimer, selectionAdjustment = null;
let roomMode = Object.hasOwn(MODES, storage.get('sanren-mode', true)) ? storage.get('sanren-mode', true) : 'classic';
$('#create-options [name="room-size"][value="' + modeRules(roomMode).players + '"]').checked = true;
$('#create-options [name="room-kind"][value="' + (isRaceMode(roomMode) ? 'race' : isSkillMode(roomMode) ? 'skills' : 'classic') + '"]').checked = true;
const classify = cards => classifyCards(cards, state?.mode);
const findHint = (cards, target) => hintCards(cards, target, state?.mode);
const findClosestSelection = (cards, target) => closestCards(cards, target, state?.mode);
const capacity = () => modeRules(state?.mode).players;
let wildRanks = {};
const skillEffects = createSkillEffects({ reducedMotion });
const skillUI = createSkillUI({ getState: () => state, send, cardHTML, getSelected: () => selected, getWildRank: id => wildRanks[id] ?? 15,
  onWildChange(id, rank) { wildRanks[id] = rank; cancelSelectionAssist(); renderHand(); renderActions(); },
  getError: () => $('#toast').textContent,
  isBlocked: () => !connected || busy || inTransition() });
$('#rules-dialog .rules-content').insertAdjacentHTML('afterbegin', '<h3>三人经典</h3>');
$('#rules-dialog .rules-content').insertAdjacentHTML('beforeend', '<h3>四人经典与四人技能</h3><p>两副牌共 108 张，每人 25 张，地主拿 8 张底牌后共 33 张。一位地主对抗三位农民，任一农民出完即为农民阵营获胜。全部准备才开局；四人都不叫则重新发牌，连续三家不出后由上一位出牌者领出。</p><p>可出单张、对子、三张、三带二、顺子、连对、飞机及飞机带对子。不能三带一、飞机带单或四带二；飞机翅膀为不同点数的对子，不能复用主体点数。两个小王或两个大王可作对子，一小王加一大王不能出。四至八张同点数为炸弹，先比张数再比点数；两小王加两大王是最大的四王炸。2 和王不能进入顺子、连对或飞机主体。</p><p>本游戏四人计分：叫分为初始倍数，每个炸弹、四王炸、春天各翻倍；地主得失三份积分，每位农民一份。八张炸弹和四王炸不会直接判胜，没有农民出炸数量限制。四人技能在上述四人规则下，每人额外获得一个技能。</p>');
$('#rules-dialog .rules-content').insertAdjacentHTML('beforeend', `<h3>技能模式</h3><p>建房时选择技能模式。每人发牌时随机获得一个技能，可能与其他玩家相同。只能在自己的出牌回合使用，每局一次；使用后继续出牌，回合计时不重置。</p><ul>${Object.values(SKILLS).map(skill => `<li><strong>${skill.name}</strong>：${skill.description}</li>`).join('')}</ul><p>随机牌来自完整的 54 张牌，包含大小王，可以与已有牌重复。万能牌可替代大小王，仍需组成合法牌型；炸弹按当前人数的牌型规则判定。赠牌、弃小牌或顺手牵羊使任一玩家清空手牌时，该玩家直接获胜。四选一的候选牌仅本人可见，超时会选第一张并继续托管。</p>`);
$('#rules-dialog .rules-content').insertAdjacentHTML('beforeend', `<h3>三人竞速</h3><p>三人各自为战。开局只洗第一副牌，三人各得18张；持有第一副红桃3的玩家先出，首手必须包含这张牌。没有叫分、地主和技能。每次打出几张，就从抽牌堆补回几张；选择“不出”可摸一张，手牌因此可能超过18张。抽牌堆用完后，弃牌重新洗入抽牌堆。最先累计打出${RACE_TARGET}张牌的玩家获胜。</p><p>牌型和三人经典一致，包含三带一、两王炸。竞速模式额外允许五张3组成“五个三”，大于两王炸，是最大牌型。其他五张同点数不作为炸弹。</p>`);
const initialCode = new URLSearchParams(location.search).get('room');
if (/^\d{6}$/.test(initialCode || '')) $('#room-code').value = initialCode;
$('#nickname').value = storage.get('sanren-name', true) || '';
const socket = window.io({ auth: { token: storage.get('sanren-session') }, reconnectionDelayMax: 3000 });
const me = () => state?.players.find(p => p.id === state.me);
const effectiveHand = () => me().hand.map(card => card.wild ? { ...card, rank: wildRanks[card.id] ?? 15 } : card);
const myTurn = () => state?.turnId === state?.me;
const active = () => ['playing', 'bidding'].includes(state?.phase);
const ascending = cards => [...cards].sort((a, b) => a.rank - b.rank || a.id - b.id);

function toast(message) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function connectionUI() {
  $('#connection').textContent = connected ? '已连接' : '连接中…';
  $('#connection').classList.toggle('online', connected);
  $('#create-button').disabled = !connected || busy;
  $('#join-button').disabled = !connected || busy;
  $('#create-confirm').disabled = !connected || busy;
  $('#join-confirm').disabled = !connected || busy;
  if (state) renderActions();
}
socket.on('connect', () => { connected = true; connectionUI(); });
socket.on('session', session => { storage.set('sanren-session', session.token); socket.auth.token = session.token; });
socket.on('disconnect', () => { connected = false; connectionUI(); if (state) toast('连接断开，正在重新连接。座位和手牌已保留。'); });
socket.on('connect_error', () => { connected = false; connectionUI(); $('#connection').textContent = '重连中'; });
socket.on('replaced', () => { socket.disconnect(); connected = false; connectionUI(); toast('此座位已在另一个页面打开。请使用那个页面继续游玩。'); });
socket.on('chat', message => toast(`${message.name}：${message.text}`));
socket.on('state', next => {
  cancelSelectionAssist();
  const previous = state;
  const origins = captureCardOrigins();
  cancelCardMotion();
  endSelectionGesture(false);
  state = next;
  if (state) { $('#create-dialog').close(); $('#join-dialog').close(); }
  if (state) {
    clockOffset = state.serverNow - Date.now();
    const handIds = new Set(me().hand.map(c => c.id));
    if (previous?.code !== state.code || previous?.dealId !== state.dealId) { wildRanks = {}; recentDrawn.clear(); }
    else wildRanks = Object.fromEntries(Object.entries(wildRanks).filter(([id]) => handIds.has(Number(id))));
    recentDrawn = new Map([...recentDrawn].filter(([id, expiry]) => handIds.has(id) && expiry > Date.now()));
    selected = new Set([...selected].filter(id => handIds.has(id)));
    if (previous?.round !== state.round || previous?.phase !== state.phase) selected.clear();
    const url = new URL(location.href); url.searchParams.set('room', state.code); history.replaceState(null, '', url);
  } else {
    selected.clear();
    recentDrawn.clear();
    if (previous) { const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url); }
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  }
  render();
  animateTableUpdate(previous, state, origins);
  skillEffects.update(previous, state);
  presentTableCues(previous, state);
});
async function send(event, data = {}) {
  if (!connected) { toast('正在重新连接，请稍候。'); return false; }
  if (busy) return false;
  busy = true; connectionUI();
  for (const b of document.querySelectorAll('#actions button, #entry-form button, #create-confirm, #join-confirm')) b.setAttribute('aria-busy', 'true');
  try {
    const response = await socket.timeout(6000).emitWithAck(event, { ...data, revision: state?.revision });
    if (!response.ok) {
      feedback('error');
      if (!state) { $( $('#create-dialog').open ? '#create-error' : $('#join-dialog').open ? '#join-error' : '#entry-error').textContent = response.error; }
      else toast(response.error);
      return false;
    }
    if (['create', 'join', 'ready', 'skill', 'skill-choice'].includes(event)) feedback('success');
    return true;
  } catch {
    toast('暂未收到确认，请先查看牌桌是否更新。');
    return false;
  } finally {
    busy = false; connectionUI();
    for (const b of document.querySelectorAll('[aria-busy]')) b.removeAttribute('aria-busy');
  }
}
function entryName() {
  $('#entry-error').textContent = '';
  const name = $('#nickname').value.trim();
  if (!name) { $('#nickname').setAttribute('aria-invalid', 'true'); $('#nickname').focus(); $('#entry-error').textContent = '请输入昵称。'; feedback('error'); return null; }
  $('#nickname').removeAttribute('aria-invalid');
  storage.set('sanren-name', name, true);
  return name;
}
$('#entry-form').addEventListener('submit', event => { event.preventDefault(); if (entryName()) $('#create-dialog').showModal(); });
$('#create-options [name="room-size"][value="4"]').addEventListener('change', () => {
  const race = $('#create-options [name="room-kind"][value="race"]');
  race.disabled = true;
  if (race.checked) $('#create-options [name="room-kind"][value="classic"]').checked = true;
});
$('#create-options [name="room-size"][value="3"]').addEventListener('change', () => { $('#create-options [name="room-kind"][value="race"]').disabled = false; });
if (modeRules(roomMode).players === 4) $('#create-options [name="room-kind"][value="race"]').disabled = true;
$('#join-button').addEventListener('click', () => { if (entryName()) { $('#join-error').textContent = ''; $('#join-dialog').showModal(); $('#room-code').focus(); } });
$('#create-options').addEventListener('submit', event => {
  event.preventDefault();
  const players = Number($('#create-options [name="room-size"]:checked').value);
  const kind = $('#create-options [name="room-kind"]:checked').value;
  roomMode = players === 4 ? (kind === 'skills' ? 'fourSkills' : 'four') : kind === 'race' ? 'race' : kind === 'skills' ? 'skills' : 'classic';
  storage.set('sanren-mode', roomMode, true);
  $('#create-error').textContent = '';
  const name = entryName(); if (name) send('create', { name, mode: roomMode });
});
$('#join-options').addEventListener('submit', event => { event.preventDefault(); const name = entryName(); if (name) send('join', { name, code: $('#room-code').value.trim() }); });
$('#room-code').addEventListener('input', event => { event.target.value = event.target.value.replace(/\D/g, '').slice(0, 6); });

function cardHTML(card, { mini = false, interactive = false } = {}) {
  const red = ['♥', '♦'].includes(card.suit) || card.rank === 17;
  const isSelected = selected.has(card.id);
  const label = card.wild ? `<span>万</span><span class="wild-rank-label">${rankLabel(card.rank)}</span>` : card.rank >= 16 ? `<span class="joker-text">${rankLabel(card.rank)}</span>` : `<span>${rankLabel(card.rank)}</span><span class="suit">${card.suit}</span>`;
  const content = `<span class="card-index">${label}</span><span class="center-suit" aria-hidden="true">${card.suit}</span>`;
  const classes = `playing-card${red ? ' red' : ''}${card.wild ? ' wild-card' : ''}${mini ? ' mini' : ''}${interactive && isSelected ? ' selected' : ''}${interactive && isRaceMode(state?.mode) && (recentDrawn.get(card.id) || 0) > Date.now() ? ' just-drawn' : ''}`;
  const name = card.wild ? `万能牌，当作${rankLabel(card.rank)}` : `${card.rank >= 16 ? '' : card.suit}${rankLabel(card.rank)}`;
  return interactive
    ? `<button class="${classes}" data-card="${card.id}" data-card-id="${card.id}" data-rank="${card.rank}" aria-label="${name}" aria-pressed="${isSelected}" type="button">${content}</button>`
    : `<span class="${classes}" data-card-id="${card.id}" data-rank="${card.rank}" role="img" aria-label="${name}">${content}</span>`;
}
const role = p => (isRaceMode(state.mode) ? '竞速' : state.landlordId ? (p.id === state.landlordId ? '地主' : '农民') : p.id === state.hostId ? '房主' : '牌友') + (p.bot ? ' · 人机' : '');
function roleHTML(p) {
  const type = isRaceMode(state.mode) ? 'race' : state.landlordId ? (p.id === state.landlordId ? 'landlord' : 'farmer') : 'waiting';
  const labels = { landlord: '地主', farmer: '农民', race: '竞速', waiting: p.id === state.hostId ? '房主' : '牌友' };
  const icons = {
    landlord: '<path d="m2 6 3 3 3-5 4 5 3-3-1 8H3L2 6Z"/><path d="M3 16h11"/>',
    farmer: '<path d="M8 16V7M8 10C5 10 3 8 3 5c3 0 5 2 5 5ZM8 8c0-3 2-5 5-5 0 3-2 5-5 5ZM5 16h6"/>',
    race: '<path d="M8 2v9m-3-6 3-3 3 3M3 15h10M5 12h6"/>',
    waiting: '<path d="m8 2 2 4 4 2-4 2-2 4-2-4-4-2 4-2 2-4Z"/>',
    bot: '<rect x="2" y="5" width="12" height="9" rx="2"/><path d="M8 5V2m-3 14h6M5 9h.01M11 9h.01"/>',
  };
  const icon = kind => `<svg viewBox="0 0 16 18" aria-hidden="true" focusable="false">${icons[kind]}</svg>`;
  return `<span class="role-tag role-${type}">${icon(type)}${labels[type]}</span>${p.bot ? `<span class="role-tag role-bot">${icon('bot')}人机</span>` : ''}`;
}
function characterHTML(p) {
  const variant = Math.max(0, state.players.findIndex(player => player.id === p.id)) % 4;
  const hair = [
    '<path class="character-hair" d="M22 45V32C22 10 73 8 75 34L73 48H66L62 31C52 38 39 28 31 39L30 48Z"/><circle class="character-hair" cx="29" cy="25" r="10"/><circle class="character-hair" cx="43" cy="20" r="12"/>',
    '<circle class="character-hair" cx="66" cy="16" r="12"/><path class="character-hair" d="M21 67V34C21 10 76 9 76 36V68L64 70 28 70Z"/>',
    '<path class="character-hair" d="M23 47V32C23 15 73 15 74 35V49H65L29 51Z"/>',
    '<path class="character-hair" d="M22 46V29Q25 9 48 15L65 9 63 18Q79 20 75 48L67 46 60 31 32 34 29 49Z"/>',
  ][variant];
  const accessory = [
    '<g class="character-lines"><rect x="29" y="40" width="17" height="13" rx="5"/><rect x="51" y="40" width="17" height="13" rx="5"/><path d="M46 45H51"/></g>',
    '<path class="character-hair" d="M24 37C30 19 55 15 68 29L73 43C61 39 54 30 50 26 46 39 33 43 24 42Z"/><circle class="character-earring" cx="26" cy="57" r="3"/><circle class="character-earring" cx="71" cy="57" r="3"/>',
    '<path class="character-cap" d="M21 32C22 7 73 7 76 32Z"/><path class="character-cap-brim" d="M19 31Q49 22 81 33L81 39Q46 34 19 38Z"/>',
    '<path class="character-lines" d="M23 40Q18 40 18 49v8m56-17q6 0 6 9v8M18 52h7m48 0h7"/><path class="character-hair" d="m27 33 8-16 7 10 10-14 6 14 9-8 4 19Z"/>',
  ][variant];
  const crown = p.id === state.landlordId ? '<path class="character-crown" d="M36 17 32 3 43 9 49 0 55 9 66 3 62 17Z"/>' : '';
  return `<svg class="character character-${variant}" viewBox="0 0 96 104" aria-hidden="true" focusable="false"><path class="character-shirt" d="M8 104V94C8 73 29 72 38 70H60C75 73 88 78 88 94V104Z"/>${hair}<path class="character-skin" d="M39 62H58V76Q49 86 39 76Z"/><circle class="character-skin" cx="25" cy="47" r="7"/><circle class="character-skin" cx="72" cy="47" r="7"/><rect class="character-skin" x="27" y="26" width="43" height="45" rx="20"/><path class="character-collar" d="M35 73 48 83 40 91 28 78ZM61 73 49 83 56 91 69 78Z"/><g class="character-eyes"><ellipse cx="38" cy="46" rx="2.3" ry="3.2"/><ellipse cx="59" cy="46" rx="2.3" ry="3.2"/></g><path class="character-smile" d="M41 58Q49 65 57 58"/>${accessory}${crown}</svg>`;
}
function avatarHTML(p) {
  return `<span class="avatar character-avatar${p.id === state.landlordId ? ' landlord' : ''}${active() && p.id === state.turnId ? ' current' : ''}" aria-hidden="true">${characterHTML(p)}</span>`;
}
function portraitHTML(p) {
  if (!isRaceMode(state.mode)) return avatarHTML(p);
  return `<span class="avatar-progress">${avatarHTML(p)}<span class="race-progress" aria-label="${escape(p.name)}已打出${p.playedCount}张，目标${RACE_TARGET}张"><strong>${p.playedCount}</strong><small>/${RACE_TARGET}</small></span></span>`;
}
function opponentHandHTML(p) {
  if (!active() || !p.count) return '<div class="opponent-hand" aria-hidden="true"></div>';
  return `<div class="opponent-hand" role="img" aria-label="${escape(p.name)}剩余 ${p.count} 张手牌">${'<span class="facedown-card" aria-hidden="true"></span>'.repeat(p.count)}</div>`;
}
function playerHTML(p, mine = false) {
  if (!p) return '<div class="empty-seat"><div class="avatar">+</div><span>等待加入</span></div>';
  return `<div class="player-info" data-player-id="${p.id}">${portraitHTML(p)}<div><div class="player-name" title="${escape(p.name)}">${escape(p.name)}${mine ? ' · 你' : ''}</div><div class="player-role" aria-label="${role(p)}${!p.connected ? ' · 离线' : ''}">${roleHTML(p)}${!p.connected ? '<span class="role-offline">离线</span>' : ''}</div></div></div>${!mine ? `${opponentHandHTML(p)}<div class="seat-status"><span class="player-status">${!active() ? (p.ready ? '已准备 ✓' : '未准备') : escape(p.lastAction)}</span>${active() || state.phase === 'finished' ? isRaceMode(state.mode) ? '' : `<span class="player-count${p.count <= 2 ? ' danger' : ''}"><strong>${p.count}</strong>张</span>` : ''}</div>` : ''}${p.bot && !active() && state.hostId === state.me ? `<button class="text-button bot-remove" data-action="remove-bot" data-bot-id="${escape(p.id)}" aria-label="移除机器人${escape(p.name)}">移除</button>` : ''}`;
}
function render() {
  $('#lobby').hidden = Boolean(state); $('#game').hidden = !state;
  document.body.classList.toggle('in-game', Boolean(state));
  document.body.classList.toggle('landscape-mode', landscapeTable.matches);
  document.body.classList.toggle('skills-mode', isSkillMode(state?.mode));
  document.body.classList.toggle('four-mode', isFourMode(state?.mode));
  document.body.classList.toggle('race-mode', isRaceMode(state?.mode));
  $('#table-nav-label').textContent = state ? '当前牌桌' : '开始游戏';
  document.title = state ? `房间 ${state.code} · ${modeRules(state.mode).name}` : '三人局 · 联机斗地主';
  if (!state) { connectionUI(); return; }
  $('#room-title').textContent = state.code;
  $('#round-label').textContent = `${modeRules(state.mode).name} · ${state.round ? `第 ${String(state.round).padStart(2, '0')} 局 · ${{ waiting: '等待加入', bidding: '叫分中', playing: '对局中', finished: '本局结束' }[state.phase]}` : '等待开局'}`;
  $('.arena').dataset.phase = state.phase;
  $('#multiplier-label').textContent = isRaceMode(state.mode) ? `先打出${RACE_TARGET}张 · 牌堆 ${state.round ? state.drawCount : '待发牌'}` : state.landlordId ? `当前倍数 × ${state.multiplier}` : `${capacity()} 人 · ${isFourMode(state.mode) ? 108 : 54} 张牌`;
  $('.sidebar-note p').textContent = isRaceMode(state.mode) ? '每回合 45 秒。出牌后按张数补牌；不出时摸一张。超时自动不出并摸牌，领出时自动打一张。' : '每回合 45 秒。超时自动不叫或不出，领出时自动打一张最小牌。';
  const index = state.players.findIndex(p => p.id === state.me);
  // Turn order is self → right → left; consistent on every device.
  const right = state.players[(index + 1) % capacity()];
  const left = state.players[(index + capacity() - 1) % capacity()];
  const top = capacity() === 4 ? state.players[(index + 2) % 4] : null;
  $('#left-player').innerHTML = playerHTML(left);
  $('#right-player').innerHTML = playerHTML(right);
  $('#top-player').hidden = capacity() !== 4;
  $('#top-player').innerHTML = capacity() === 4 ? playerHTML(top) : '';
  $('#top-play').hidden = capacity() !== 4;
  $('#my-player').innerHTML = playerHTML(me(), true);
  $('#bottom-label').textContent = isRaceMode(state.mode) ? '抽牌堆' : state.landlordId ? '地主底牌 · 已公开' : '地主底牌';
  $('#bottom-cards').innerHTML = isRaceMode(state.mode) ? `<span class="draw-count">${state.round ? `${state.drawCount} 张` : '待发牌'}</span>` : state.bottom.length ? ascending(state.bottom).map(c => cardHTML(c, { mini: true })).join('') : '<span class="playing-card mini back"></span>'.repeat(modeRules(state.mode).bottom);
  renderCenter(); renderPlayedCards(left, right, top); renderActions(); renderHand(); renderScores(); tick();
}
function renderCenter() {
  const center = $('#table-center');
  if (state.phase === 'waiting') {
    center.innerHTML = `<h2 class="waiting-title">${state.players.length === capacity() ? '等待准备' : `等待玩家（${state.players.length}/${capacity()}）`}</h2><p>${state.players.some(p => p.bot) ? '真人玩家准备后自动开始' : state.players.length < capacity() ? '邀请好友或由房主添加机器人' : '全部准备后自动开始'}</p>`;
  } else if (state.phase === 'bidding') {
    center.innerHTML = `<h2>叫地主</h2><span class="play-caption">${state.highestBid ? `当前最高 ${state.highestBid} 分` : '暂无叫分'}</span>`;
  } else if (state.phase === 'finished') {
    center.innerHTML = '';
  } else {
    center.innerHTML = '';
  }
}
function renderPlayedCards(left, right, top) {
  for (const [selector, player] of [['#left-play', left], ['#top-play', top], ['#right-play', right], ['#my-play', me()]]) {
    const zone = $(selector);
    const play = player && state.tablePlays?.[player.id];
    const passed = state.phase === 'playing' && player && state.tablePasses?.[player.id];
    const revealed = state.phase === 'finished' && player && player.id !== state.me;
    zone.dataset.playerId = player?.id || '';
    zone.classList.toggle('latest-play', Boolean(play && state.lastPlay?.playerId === player.id));
    zone.classList.toggle('has-play', Boolean(play && !passed && state.phase === 'playing'));
    zone.classList.toggle('has-pass', Boolean(passed));
    zone.classList.toggle('revealed-hand', Boolean(revealed));
    if (passed) {
      const passDetail = [passed.auto ? '超时自动不出' : '', isRaceMode(state.mode) ? passed.drawn ? '摸 1 张' : '牌堆已空' : ''].filter(Boolean).join(' · ');
      zone.innerHTML = `<strong class="pass-label">不出</strong>${passDetail ? `<span class="play-caption">${passDetail}</span>` : ''}`;
      continue;
    }
    if (!revealed && (!play || state.phase !== 'playing')) { zone.innerHTML = ''; continue; }
    const cards = ascending(revealed ? player.hand || [] : play.cards);
    const mobile = window.innerWidth < 600;
    const cardWidth = landscapeTable.matches ? 40 : mobile ? 44 : 58;
    const step = landscapeTable.matches ? 16 : mobile ? 18 : 24;
    const scrolls = cardWidth + Math.max(0, cards.length - 1) * step > zone.clientWidth - 8;
    const caption = revealed ? (cards.length ? `剩余 ${cards.length} 张` : '手牌已出完') : `${play.combo.name} · ${cards.length} 张`;
    zone.innerHTML = `<span class="play-caption">${caption}${scrolls ? ' · 可滑动' : ''}</span><div class="table-cards"${scrolls ? ' tabindex="0" aria-label="左右滑动查看全部牌"' : ''}><div class="played-row" style="--played-w:${cardWidth}px;--played-step:${step}px">${cards.map(c => cardHTML(c)).join('')}</div></div>`;
  }
}
let actionLocked = false;
const inTransition = () => active() && Date.now() + clockOffset < (state.actionAt || 0);
function renderActions() {
  if (!state) return;
  actionLocked = inTransition();
  const disabled = !connected || busy || actionLocked || Boolean(me().skill?.pending);
  let html = '', message = '';
  const button = (action, text, primary = false, off = false) => `<button class="${primary ? 'primary' : 'secondary'}" data-action="${action}"${disabled || off ? ' disabled' : ''}>${text}</button>`;
  if (['waiting', 'finished'].includes(state.phase)) {
    html = button('ready', me().ready ? '取消准备' : state.phase === 'finished' ? '准备下一局' : '准备开局', !me().ready);
    if (state.me === state.hostId && state.players.length < capacity()) html += button('fill-bots', '机器人补位');
    message = me().ready ? '已准备' : '';
    if (state.phase === 'finished') {
      const delta = state.result.deltas.find(d => d.id === state.me).delta;
      message = isRaceMode(state.mode) ? `${state.players.find(p => p.id === state.result.winnerId).name}率先打出${RACE_TARGET}张 · 已准备 ${state.players.filter(p => p.ready).length}/${capacity()}` : `${delta > 0 ? '获胜 +' : '本局 '}${delta} 分 · 已准备 ${state.players.filter(p => p.ready).length}/${capacity()}`;
    }
  } else if (state.phase === 'bidding') {
    message = myTurn() ? '轮到你叫分' : `等待 ${state.players.find(p => p.id === state.turnId).name} 叫分`;
    if (myTurn()) html = button('bid-0', '不叫') + [1, 2, 3].map(value => button(`bid-${value}`, `${value} 分`, value === 3, value <= state.highestBid)).join('');
  } else {
    message = myTurn() ? (state.lastPlay ? '轮到你出牌' : '轮到你领出') : `等待 ${state.players.find(p => p.id === state.turnId).name} 出牌`;
    const selectedCards = effectiveHand().filter(c => selected.has(c.id));
    const valid = beats(classify(selectedCards), state.lastPlay?.combo) && (!state.openingLead || selectedCards.some(card => card.id === 1));
    const canDrawOnPass = (state.drawCount || 0) + (state.discardCount || 0) > 0;
    html = button('pass', isRaceMode(state.mode) && canDrawOnPass ? '不出+1' : '不出', false, !myTurn() || !state.lastPlay) + button('hint', '提示', false, !myTurn()) + button('clear', '重选', false, !selected.size) + button('play', '出牌', true, !myTurn() || !valid);
  }
  $('#actions').innerHTML = html;
  $('#turn-message').textContent = connected ? message : '连接中，恢复后继续对局';
  $('.turn-line').classList.toggle('my-turn', active() && myTurn());
  renderSelection();
  skillUI.render();
}
function renderSelection() {
  const message = $('#selection-message');
  message.classList.remove('invalid');
  if (me().skill?.pending) { message.textContent = '请点击「选牌」完成四选一'; return; }
  if (state.phase !== 'playing' || !selected.size) {
    message.textContent = state.phase === 'playing' ? state.openingLead && myTurn() ? '首手须包含红桃3' : isRaceMode(state.mode) ? `已打 ${me().playedCount}/${RACE_TARGET} · ${(state.drawCount || 0) + (state.discardCount || 0) ? '不出摸1张' : '牌堆已空'}` : '点击或滑动选牌，再次选中取消' : state.phase === 'finished' ? isRaceMode(state.mode) ? `${state.players.find(p => p.id === state.result.winnerId).name}获胜 · 率先打出${RACE_TARGET}张` : `${state.result.landlordWon ? '地主' : '农民'}获胜${state.result.spring ? ' · 春天翻倍' : ''} · ${state.result.multiplier} 倍` : '';
    return;
  }
  const combo = classify(effectiveHand().filter(c => selected.has(c.id)));
  if (!combo) { message.textContent = `已选 ${selected.size} 张 · 暂未组成有效牌型`; message.classList.add('invalid'); }
  else if (state.openingLead && !effectiveHand().filter(c => selected.has(c.id)).some(card => card.id === 1)) { message.textContent = '首手须包含红桃3'; message.classList.add('invalid'); }
  else if (!beats(combo, state.lastPlay?.combo)) { message.textContent = `${combo.name} · 压不过上一手牌`; message.classList.add('invalid'); }
  else if (selectionAdjustment) message.innerHTML = `已整理为${escape(combo.name)} · ${selected.size} 张 <button type="button" class="selection-undo" data-action="undo-selection">撤销</button>`;
  else message.textContent = `已选 ${selected.size} 张 · ${combo.name}`;
}
function renderHand() {
  const container = $('#hand');
  endSelectionGesture(false);
  const hand = ascending(effectiveHand());
  const skillMode = isSkillMode(state.mode);
  const raceMode = isRaceMode(state.mode);
  const four = isFourMode(state.mode);
  const landscape = landscapeTable.matches;
  const mobile = window.innerWidth < 600;
  const cardWidth = landscape ? 60 : mobile ? (four ? 46 : 54) : 92;
  const compact = window.innerHeight < 1150;
  const shortPhone = mobile && window.innerHeight < 760;
  const shortDesktop = !mobile && window.innerHeight < 800;
  const tightHand = skillMode && window.innerWidth < 1000;
  const handCapacity = raceMode ? Math.max(18, hand.length) : modeRules(state.mode).maxHand;
  const doubleRow = skillMode && (four || hand.length > 20) || raceMode && hand.length > 18;
  container.classList.toggle('multi-row-skill', landscape && doubleRow);
  const rowGap = landscape ? (doubleRow ? 2 : 0) : shortPhone ? (four && skillMode ? 2 : 4) : compact ? (mobile ? 8 : 6) : (mobile ? 20 : 12);
  const topSpace = landscape ? (doubleRow ? 6 : 10) : shortPhone ? (four && skillMode ? 4 : 8) : compact ? 12 : 24;
  const gridRows = landscape && doubleRow ? getComputedStyle($('.arena')).gridTemplateRows.split(' ') : [];
  const doubleRowHeight = gridRows.length === 6 ? Math.floor((parseFloat(gridRows[4]) - topSpace) / 2) - rowGap : 42;
  const cardHeight = landscape ? doubleRow ? Math.max(24, doubleRowHeight) : Math.max(48, Math.min(88, window.innerHeight - 260)) : shortPhone ? (four && skillMode ? 42 : 54) : shortDesktop ? 84 : compact ? (mobile ? 68 : tightHand ? 80 : 94) : (mobile ? 94 : 132);
  const handStyle = getComputedStyle(container);
  const width = container.clientWidth - parseFloat(handStyle.paddingLeft) - parseFloat(handStyle.paddingRight) - 4;
  const minStep = mobile ? (skillMode ? 17 : 22) : (skillMode || four ? 25 : 30);
  const rowSize = landscape ? (doubleRow ? Math.ceil(handCapacity / 2) : handCapacity) : four && mobile ? (skillMode ? Math.ceil(handCapacity / 2) : 17) : Math.max(1, Math.min(mobile ? (skillMode ? 14 : raceMode && hand.length > 20 ? 12 : 10) : (four ? 33 : skillMode ? 28 : 20), Math.floor((width - cardWidth) / minStep) + 1));
  container.style.height = `${topSpace + Math.ceil(handCapacity / rowSize) * (cardHeight + rowGap)}px`;
  if (!hand.length) { container.innerHTML = `<div class="hand-placeholder">${state.phase === 'finished' ? '手牌已出完' : '等待发牌'}</div>`; return; }
  const rows = [];
  for (let i = 0; i < hand.length; i += rowSize) rows.push(hand.slice(i, i + rowSize));
  const step = Math.min(mobile ? 28 : 40, (width - cardWidth) / Math.max(1, Math.min(rowSize, hand.length) - 1));
  container.innerHTML = rows.map(row => {
    const fontSize = landscape ? Math.min(24, Math.floor(step * .88), Math.floor(cardHeight * .39)) : mobile ? (four ? Math.min(16, Math.floor(step * .9)) : skillMode ? 16 : 20) : skillMode || four ? Math.min(30, Math.floor(step * .9)) : 30;
    return `<div class="hand-row" style="--card-w:${cardWidth}px;--card-h:${cardHeight}px;--step:${step}px;--rank-size:${fontSize}px">${row.map(c => cardHTML(c, { interactive: state.phase === 'playing' })).join('')}</div>`;
  }).join('');
}
const cueTimers = new Set();
let bannerTimer, turnCueTimer, turnCueKey = '';
function cueLater(callback, delay) {
  const timer = setTimeout(() => { cueTimers.delete(timer); callback(); }, delay);
  cueTimers.add(timer); return timer;
}
function resetTableCues() {
  for (const timer of cueTimers) clearTimeout(timer);
  cueTimers.clear(); clearTimeout(turnCueTimer); clearTimeout(bannerTimer);
  $('#table-event').hidden = true; $('#table-event').replaceChildren();
  tableSound.stop();
}
function eventBanner(kind, title, detail, score = '', effect = null, cards = []) {
  if (['win', 'lose'].includes(kind) && skillEffects.isPresenting()) {
    cueLater(() => eventBanner(kind, title, detail, score, effect, cards), 300);
    return;
  }
  const banner = $('#table-event');
  const symbols = { bomb: '✦', rocket: '↟', warning: '!', landlord: '♛', win: '★', lose: '♠', skill: '✦' };
  clearTimeout(bannerTimer);
  banner.dataset.event = kind;
  banner.dataset.effect = effect?.family || '';
  banner.innerHTML = `${effect ? comboArtwork(effect.family, cards) : ''}<div class="event-card">${effect ? '' : `<span class="event-symbol" aria-hidden="true">${symbols[kind]}</span>`}<div><strong>${escape(title)}</strong><small>${escape(detail)}</small></div>${score ? `<b class="event-score">${escape(score)}</b>` : ''}</div>`;
  banner.hidden = false;
  bannerTimer = setTimeout(() => { banner.hidden = true; }, effect?.duration || (['win', 'lose'].includes(kind) ? 2800 : kind === 'warning' ? 1800 : 1500));
}
function reactAtSeat(playerId, kind) {
  const zone = [...document.querySelectorAll('.player-play')].find(node => node.dataset.playerId === playerId);
  const avatar = $(zone?.id === 'left-play' ? '#left-player .avatar' : zone?.id === 'top-play' ? '#top-player .avatar' : zone?.id === 'right-play' ? '#right-player .avatar' : '#my-player .avatar');
  if (!avatar) return;
  if (['bomb', 'rocket', 'win', 'landlord'].includes(kind)) {
    moveCard(avatar, [{ transform: 'translateY(0)' }, { transform: 'translateY(-7px) rotate(-4deg)', offset: .4 }, { transform: 'translateY(0)' }], { duration: 650 });
  } else if (kind === 'warning') {
    moveCard(avatar, [{ boxShadow: '0 0 0 0 #ffcf5480' }, { boxShadow: '0 0 0 12px #ffcf5400' }], { duration: 800, iterations: 2 });
  }
}
function presentTableCues(previous, next) {
  const key = next ? `${next.code}:${next.dealId}:${next.phase}:${next.turnId}:${next.actionAt}` : '';
  const newTurn = key !== turnCueKey; turnCueKey = key;
  if (!previous || !next || previous.code !== next.code || next.dealId !== previous.dealId || next.phase === 'waiting') resetTableCues();
  if (document.hidden || !previous || !next || previous.code !== next.code) return;
  if (newTurn) {
    clearTimeout(turnCueTimer);
    if (active() && myTurn()) turnCueTimer = setTimeout(() => {
      if (state && active() && myTurn() && !document.hidden) feedback('turn');
    }, Math.max(0, next.actionAt - next.serverNow) + 120);
  }
  const cues = tableCues(previous, next);
  let emphasisDelay = 0;
  for (const cue of cues) {
    const player = next.players.find(item => item.id === cue.playerId);
    const effect = comboEffect(cue.kind);
    if (cue.kind === 'deal') {
      tableSound.play('shuffle'); cueLater(() => tableSound.play('deal'), 900);
    } else if (cue.kind === 'play' || cue.kind === 'pass') {
      tableSound.play(cue.kind);
    } else if (cue.kind === 'landlord') {
      tableSound.play('landlord'); reactAtSeat(cue.playerId, cue.kind);
      eventBanner('landlord', '地主就位', `${player.name} · ${next.highestBid} 分`);
    } else if (effect) {
      tableSound.play(effect.family); reactAtSeat(cue.playerId, cue.kind);
      const detail = ['bomb', 'rocket'].includes(cue.kind) ? '倍数 ×2' : `${next.tablePlays[cue.playerId].cards.length} 张`;
      eventBanner(cue.kind, next.tablePlays[cue.playerId].combo.name, `${player.name} · ${detail}`, '', effect, next.tablePlays[cue.playerId].cards);
      emphasisDelay = effect.duration + 50;
    } else if (cue.kind === 'warning') {
      cueLater(() => {
        if (state?.phase !== 'playing' || state.players.find(item => item.id === cue.playerId)?.count !== cue.count) return;
        tableSound.play('warning'); reactAtSeat(cue.playerId, cue.kind);
        eventBanner('warning', `仅剩 ${cue.count} 张`, player.name);
      }, emphasisDelay || 420);
    } else if (cue.kind === 'win' || cue.kind === 'lose') {
      cueLater(() => {
        tableSound.play(cue.kind); reactAtSeat(cue.playerId, 'win');
        eventBanner(cue.kind, cue.kind === 'win' ? '胜利' : '本局惜败', isRaceMode(next.mode) ? `${next.players.find(p => p.id === next.result.winnerId).name}率先打出${RACE_TARGET}张` : `${next.result.landlordWon ? '地主' : '农民'}获胜${next.result.spring ? ' · 春天' : ''}`, isRaceMode(next.mode) ? '' : `${cue.delta > 0 ? '+' : ''}${cue.delta} 分`);
        for (const score of document.querySelectorAll('.score-value')) moveCard(score, [{ transform: 'scale(.8)', opacity: .4 }, { transform: 'scale(1.15)', offset: .65 }, { transform: 'scale(1)', opacity: 1 }], { duration: 650 });
      }, emphasisDelay || 450);
    }
  }
}

function renderScores() {
  $('#player-count').textContent = `${state.players.length} / ${capacity()}`;
  $('#scores').innerHTML = state.players.map(p => `<div class="score-row">${avatarHTML(p)}<div><div class="player-name">${escape(p.name)}${p.id === state.me ? ' · 你' : ''}</div><small>${role(p)} · ${isRaceMode(state.mode) ? `已打 ${p.playedCount}/${RACE_TARGET} · ` : ''}${p.connected ? '在线' : '离线'}</small></div><span class="score-value">${isRaceMode(state.mode) ? `${p.score}胜` : `${p.score > 0 ? '+' : ''}${p.score}`}</span></div>`).join('');
  $('#game-log').innerHTML = state.log.map(text => `<li>${escape(text)}</li>`).join('');
  $('#game-log').scrollTop = $('#game-log').scrollHeight;
}
function tick() {
  if (state && actionLocked !== inTransition()) renderActions();
  const timer = $('#timer');
  if (!state?.deadline || !active()) { timer.hidden = true; return; }
  timer.hidden = false;
  const seconds = Math.min(45, Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000)));
  timer.textContent = seconds; timer.classList.toggle('urgent', seconds <= 10); timer.setAttribute('aria-label', `剩余 ${seconds} 秒`);
}
setInterval(tick, 250);

let selectionGesture = null;
function cancelSelectionAssist() {
  clearTimeout(selectionAssistTimer);
  selectionAdjustment = null;
}
function scheduleSelectionAssist() {
  clearTimeout(selectionAssistTimer);
  // A short pause lets several clicks build a combination without fighting the player.
  selectionAssistTimer = setTimeout(() => {
    if (selectionGesture || state?.phase !== 'playing' || !myTurn() || me().skill?.pending || busy || !connected || document.hidden || selected.size < 2) return;
    const cards = effectiveHand().filter(card => selected.has(card.id));
    if (beats(classify(cards), state.lastPlay?.combo)) return;
    const closest = findClosestSelection(cards, state.lastPlay?.combo);
    if (!closest || closest.length === cards.length) return;
    selectionAdjustment = new Set(selected);
    selected = new Set(closest.map(card => card.id));
    syncSelection(); feedback('tap');
  }, 600);
}
function syncSelection() {
  for (const card of $('#hand').querySelectorAll('[data-card]')) {
    const chosen = selected.has(Number(card.dataset.card));
    if (chosen && card.classList.contains('just-drawn')) {
      recentDrawn.delete(Number(card.dataset.card));
      card.classList.remove('just-drawn');
      for (const animation of card.getAnimations()) {
        if (animation.effect?.getKeyframes().some(frame => frame.transform === 'translateY(-16px)')) animation.cancel();
      }
    }
    card.classList.toggle('selected', chosen); card.setAttribute('aria-pressed', String(chosen));
  }
  renderActions();
}
function endSelectionGesture(restore) {
  if (!selectionGesture) return;
  const gesture = selectionGesture;
  selectionGesture = null;
  if ($('#hand').hasPointerCapture(gesture.pointerId)) $('#hand').releasePointerCapture(gesture.pointerId);
  if (restore) { cancelSelectionAssist(); selected = gesture.before; syncSelection(); }
}
function selectAlongPath(x, y) {
  const gesture = selectionGesture;
  if (!gesture) return;
  const distance = Math.hypot(x - gesture.x, y - gesture.y);
  const steps = Math.max(1, Math.ceil(distance / 5));
  let changed = false;
  for (let step = 1; step <= steps; step++) {
    const px = gesture.x + (x - gesture.x) * step / steps;
    const py = gesture.y + (y - gesture.y) * step / steps;
    const hit = gesture.cards.findLast(card => px >= card.rect.left && px <= card.rect.right && py >= card.rect.top && py <= card.rect.bottom);
    if (!hit || gesture.visited.has(hit.id)) continue;
    gesture.visited.add(hit.id);
    if (gesture.choose) selected.add(hit.id); else selected.delete(hit.id);
    changed = true;
  }
  gesture.x = x; gesture.y = y;
  if (changed) { syncSelection(); if (gesture.visited.size > 1) feedback('tap'); }
}
$('#hand').addEventListener('pointerdown', event => {
  const card = event.target.closest('[data-card]');
  if (!card || state?.phase !== 'playing' || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  endSelectionGesture(false);
  cancelSelectionAssist();
  const id = Number(card.dataset.card);
  selectionGesture = {
    pointerId: event.pointerId, before: new Set(selected), choose: !selected.has(id), visited: new Set(),
    x: event.clientX, y: event.clientY,
    cards: [...$('#hand').querySelectorAll('[data-card]')].map(node => ({ id: Number(node.dataset.card), rect: node.getBoundingClientRect() })),
  };
  $('#hand').setPointerCapture(event.pointerId);
  card.focus({ preventScroll: true });
  selectAlongPath(event.clientX, event.clientY);
});
$('#hand').addEventListener('pointermove', event => {
  if (selectionGesture?.pointerId !== event.pointerId) return;
  event.preventDefault(); selectAlongPath(event.clientX, event.clientY);
});
$('#hand').addEventListener('pointerup', event => {
  if (selectionGesture?.pointerId !== event.pointerId) return;
  const adding = selectionGesture.choose;
  selectAlongPath(event.clientX, event.clientY); endSelectionGesture(false);
  if (adding) scheduleSelectionAssist();
});
$('#hand').addEventListener('pointercancel', () => endSelectionGesture(true));
$('#hand').addEventListener('lostpointercapture', () => endSelectionGesture(true));
$('#hand').addEventListener('click', event => {
  // Pointer gestures already commit their selection. Keep keyboard activation working.
  if (event.detail !== 0 || event.pointerType) return;
  const card = event.target.closest('[data-card]');
  if (!card || state?.phase !== 'playing') return;
  cancelSelectionAssist();
  const id = Number(card.dataset.card);
  const adding = !selected.has(id);
  if (adding) selected.add(id); else selected.delete(id);
  syncSelection();
  if (adding) scheduleSelectionAssist();
});

const cardAnimations = new Set();
const motionTimers = new Set();
function later(callback, delay) {
  const timer = setTimeout(() => { motionTimers.delete(timer); callback(); }, delay);
  motionTimers.add(timer);
}
function cancelCardMotion() {
  for (const animation of cardAnimations) animation.cancel();
  cardAnimations.clear();
  for (const timer of motionTimers) clearTimeout(timer);
  motionTimers.clear();
  $('#animation-layer').replaceChildren();
  $('.arena').removeAttribute('data-motion');
}
function moveCard(node, frames, options) {
  if (reducedMotion.matches || !node?.animate) return;
  const animation = node.animate(frames, { duration: 700, easing: 'cubic-bezier(.22,.7,.3,1)', ...options });
  cardAnimations.add(animation);
  animation.finished.then(() => { cardAnimations.delete(animation); animation.cancel(); }, () => cardAnimations.delete(animation));
  return animation;
}
function captureCardOrigins() {
  return {
    hand: new Map([...$('#hand').querySelectorAll('[data-card-id]')].map(node => [Number(node.dataset.cardId), node.getBoundingClientRect()])),
    top: $('#top-player').getBoundingClientRect(), left: $('#left-player').getBoundingClientRect(), right: $('#right-player').getBoundingClientRect(),
    bottom: $('#bottom-cards').getBoundingClientRect(),
  };
}
function flyToCard(node, source, delay = 0, duration = 700) {
  if (!source || !node || reducedMotion.matches) return;
  const target = node.getBoundingClientRect();
  const dx = source.left + source.width / 2 - target.left - target.width / 2;
  const dy = source.top + source.height / 2 - target.top - target.height / 2;
  let animated = node;
  if (node.closest('.table-cards')) {
    const visible = node.closest('.table-cards').getBoundingClientRect();
    if (target.left >= visible.right || target.right <= visible.left) return;
    const layer = $('#animation-layer');
    const origin = layer.getBoundingClientRect();
    animated = node.cloneNode(true);
    animated.classList.add('flying-card');
    const styles = getComputedStyle(node);
    Object.assign(animated.style, { position: 'absolute', left: `${target.left - origin.left}px`, top: `${target.top - origin.top}px`, width: `${target.width}px`, height: `${target.height}px`, margin: '0', fontSize: styles.fontSize, padding: styles.padding, borderRadius: styles.borderRadius, borderWidth: styles.borderWidth });
    for (const selector of ['.card-index', '.center-suit', '.joker-text']) {
      const original = node.querySelector(selector), copy = animated.querySelector(selector);
      if (!original || !copy) continue;
      const style = getComputedStyle(original);
      Object.assign(copy.style, { width: style.width, fontSize: style.fontSize, letterSpacing: style.letterSpacing, right: style.right, bottom: style.bottom, display: style.display });
    }
    layer.append(animated);
    node.style.visibility = 'hidden';
  }
  const animation = moveCard(animated, [{ opacity: 0, transform: `translate(${dx}px,${dy}px) scale(.55) rotate(-8deg)` }, { opacity: 1, transform: 'translate(0,0) scale(1) rotate(0deg)' }], { duration, delay, fill: 'backwards' });
  if (animated !== node) {
    const cleanup = () => { animated.remove(); node.style.visibility = ''; };
    if (animation) animation.finished.then(cleanup, cleanup); else cleanup();
  }
}
function animateRaceDraw(previous, next, origins, motion = true) {
  if (!isRaceMode(next.mode)) return;
  const actor = next.players.find(player => {
    const old = previous.players.find(item => item.id === player.id);
    const played = player.playedCount > (old?.playedCount || 0);
    const passed = next.tablePasses?.[player.id];
    return played || player.count > (old?.count || 0) && passed?.sequence !== previous.tablePasses?.[player.id]?.sequence;
  });
  if (!actor) return;
  const played = actor.playedCount > (previous.players.find(old => old.id === actor.id)?.playedCount || 0);
  if (actor.id === next.me) {
    const oldIds = new Set(previous.players.find(player => player.id === next.me).hand.map(card => card.id));
    const playedIds = new Set(next.tablePlays?.[next.me]?.cards.map(card => card.id) || []);
    const hand = [...$('#hand').querySelectorAll('[data-card-id]')];
    const drawn = hand.filter(node => !oldIds.has(Number(node.dataset.cardId)) || playedIds.has(Number(node.dataset.cardId)));
    const drawnIds = new Set(drawn.map(node => Number(node.dataset.cardId)));
    for (const node of hand) {
      const id = Number(node.dataset.cardId), old = origins.hand.get(id);
      if (!old || drawnIds.has(id)) continue;
      const target = node.getBoundingClientRect(), dx = old.left - target.left, dy = old.top - target.top;
      if (motion && Math.abs(dx) + Math.abs(dy) > 2) moveCard(node, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 420, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
    drawn.forEach((node, index) => {
      const id = Number(node.dataset.cardId), expiry = Date.now() + 2200;
      recentDrawn.set(id, expiry);
      node.classList.add('just-drawn');
      if (motion) moveCard(node, [
        { transform: 'translateY(0)' },
        { transform: 'translateY(-16px)', offset: .18 },
        { transform: 'translateY(-16px)', offset: .58 },
        { transform: 'translateY(0)', offset: 1 },
      ], { duration: 1100, delay: Math.min(index, 8) * 65, easing: 'cubic-bezier(.2,.75,.25,1)' });
      setTimeout(() => {
        if (recentDrawn.get(id) !== expiry) return;
        recentDrawn.delete(id);
        $('#hand').querySelector(`[data-card-id="${id}"]`)?.classList.remove('just-drawn');
      }, 2200);
    });
  } else if (motion) {
    const seat = [...document.querySelectorAll('.player-info')].find(node => node.dataset.playerId === actor.id)?.closest('.player-slot');
    moveCard(seat?.querySelector('.opponent-hand'), [{ filter: 'brightness(1)' }, { filter: 'brightness(1.35)', offset: .45 }, { filter: 'brightness(1)' }], { duration: 600 });
  }
  const counter = [...document.querySelectorAll('.player-info')].find(node => node.dataset.playerId === actor.id)?.querySelector('.race-progress');
  if (motion && played) moveCard(counter, [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(1.22)', filter: 'brightness(1.25)', offset: .45 }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: 760 });
  if (motion) moveCard($('#bottom-cards .draw-count'), [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: .45 }, { transform: 'scale(1)' }], { duration: 620 });
}
function animateTableUpdate(previous, next, origins) {
  if (!previous || !next || previous.code !== next.code || document.visibilityState !== 'visible') return;
  if (reducedMotion.matches) { animateRaceDraw(previous, next, origins, false); return; }
  if (next.dealId !== previous.dealId && ['bidding', 'playing'].includes(next.phase)) {
    $('.arena').dataset.motion = 'shuffle';
    const layer = $('#animation-layer');
    layer.innerHTML = '<div class="shuffle-deck"><span class="playing-card back"></span><span class="playing-card back"></span><span class="playing-card back"></span><span class="shuffle-label">洗牌中</span></div>';
    const deck = layer.querySelector('.shuffle-deck');
    const source = deck.getBoundingClientRect();
    deck.querySelectorAll('.playing-card').forEach((card, i) => {
      moveCard(card, [{ transform: `translateX(${(i - 1) * 5}px) rotate(0deg)` }, { transform: `translateX(${(i - 1) * 52}px) rotate(${(i - 1) * 18}deg)` }, { transform: `translateX(${(i - 1) * 5}px) rotate(0deg)` }], { duration: 850, easing: 'ease-in-out' });
    });
    $('#hand').querySelectorAll('.playing-card').forEach((card, i) => flyToCard(card, source, 900 + i * 45));
    for (const target of ['#left-player .avatar', '#top-player .avatar', '#right-player .avatar']) {
      const destination = $(target)?.getBoundingClientRect();
      if (!destination) continue;
      for (let i = 0; i < 4; i++) {
        const back = document.createElement('span'); back.className = 'playing-card back deal-back';
        deck.append(back);
        moveCard(back, [{ opacity: 0, transform: 'translate(0,0) scale(.6)' }, { opacity: 1, offset: .2, transform: 'translate(0,0) scale(.6)' }, { opacity: 0, transform: `translate(${destination.left - source.left}px,${destination.top - source.top}px) scale(.35)` }], { duration: 600, delay: 900 + i * 200, fill: 'both' });
      }
    }
    later(() => { $('.arena').dataset.motion = 'deal'; const label = $('.shuffle-label'); if (label) label.textContent = '发牌中'; }, 900);
    later(() => { layer.replaceChildren(); $('.arena').removeAttribute('data-motion'); }, 2500);
    return;
  }
  if (previous.phase === 'bidding' && next.phase === 'playing' && next.landlordId === next.me) {
    $('#hand').querySelectorAll('[data-card-id]').forEach(card => { if (!origins.hand.has(Number(card.dataset.cardId))) flyToCard(card, origins.bottom); });
  }
  for (const zone of document.querySelectorAll('.player-play.has-play')) {
    const id = zone.dataset.playerId;
    const play = next.tablePlays[id];
    if (previous.tablePlays?.[id]?.sequence === play.sequence) continue;
    zone.querySelectorAll('.playing-card').forEach((card, i) => {
      const source = id === next.me ? origins.hand.get(Number(card.dataset.cardId)) : zone.id === 'left-play' ? origins.left : zone.id === 'top-play' ? origins.top : origins.right;
      flyToCard(card, source, i * 12, ['bomb', 'rocket', 'superBomb'].includes(play.combo.type) ? 650 : 420);
    });
  }
  animateRaceDraw(previous, next, origins);
  for (const zone of document.querySelectorAll('.player-play.has-pass')) {
    const id = zone.dataset.playerId;
    if (previous.tablePasses?.[id]?.sequence === next.tablePasses[id].sequence) continue;
    moveCard(zone.querySelector('.pass-label'), [{ opacity: 0, transform: 'translateY(10px) scale(.85)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }], { duration: 650 });
  }
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) cancelCardMotion(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelCardMotion(); resetTableCues(); endSelectionGesture(true); cancelSelectionAssist(); } });
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || !state) return;
  const action = button.dataset.action;
  if (action === 'undo-selection') {
    if (selectionAdjustment) {
      const before = selectionAdjustment;
      cancelSelectionAssist();
      selected = new Set(me().hand.filter(card => before.has(card.id)).map(card => card.id));
      syncSelection();
    }
    return;
  }
  if (['play', 'pass', 'clear', 'hint'].includes(action)) cancelSelectionAssist();
  if (action === 'invite') invite();
  if (action === 'ready') await send('ready', { ready: !me().ready });
  if (action === 'fill-bots') await send('fill-bots');
  if (action === 'remove-bot') await send('remove-bot', { id: button.dataset.botId });
  if (action.startsWith('bid-')) await send('bid', { value: Number(action.slice(4)) });
  if (action === 'play') {
    const revision = state.revision;
    if (await send('play', { cards: [...selected], wildRanks: Object.fromEntries(effectiveHand().filter(card => card.wild && selected.has(card.id)).map(card => [card.id, card.rank])) })) {
      selected.clear();
      if (state.revision === revision) renderHand(); else syncSelection();
      renderActions();
    }
  }
  if (action === 'pass') {
    const revision = state.revision;
    if (await send('pass')) {
      selected.clear();
      if (state.revision === revision) renderHand(); else syncSelection();
      renderActions();
    }
  }
  if (action === 'clear') { selected.clear(); renderHand(); renderActions(); }
  if (action === 'hint') {
    const hint = state.openingLead ? [me().hand.find(card => card.id === 1)] : isSkillMode(state.mode) ? findSkillHint(me().hand, state.lastPlay?.combo, state.mode) : findHint(me().hand, state.lastPlay?.combo);
    for (const card of hint || []) if (card.wild) wildRanks[card.id] = card.rank;
    selected = new Set(hint?.map(c => c.id)); renderHand(); renderActions();
    if (!hint) toast('没有能压过的牌，可以选择「不出」。');
  }
});
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const box = dialog.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close();
});
$('#rules-button').addEventListener('click', () => $('#rules-dialog').showModal());
function invite() {
  if (!state) return;
  const url = new URL(location.href); url.searchParams.set('room', state.code);
  $('#invite-code').textContent = state.code; $('#invite-link').value = url.href;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
  $('#invite-tip').textContent = local ? '当前是本机地址，其他设备无法使用。异地联机请先打开已部署的公网网址，再邀请好友。' : lan ? '当前是局域网地址，适合同一 Wi-Fi。不同网络的朋友请使用公网游戏网址。' : '把链接发给朋友，手机或电脑打开后即可加入房间，无需连接同一 Wi-Fi。';
  $('#copy-link').textContent = '复制邀请链接'; $('#invite-dialog').showModal();
}
$('#invite-button').addEventListener('click', invite);
$('#copy-link').addEventListener('click', async () => {
  const input = $('#invite-link');
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(input.value);
    else { input.focus(); input.select(); if (!document.execCommand('copy')) throw new Error('copy unavailable'); }
    $('#copy-link').textContent = '已复制 ✓';
  } catch { input.focus(); input.select(); $('#copy-link').textContent = '请长按或 Ctrl+C 复制'; }
});
$('#leave-button').addEventListener('click', () => {
  if (active()) $('#leave-dialog').showModal(); else send('leave');
});
$('#confirm-leave').addEventListener('click', async () => { if (await send('leave')) $('#leave-dialog').close(); });
const phrases = ['大家好，来一局！', '这手牌有点意思。', '打得漂亮！', '别急，慢慢来。', '承让，下局继续！'];
$('#chat-options').innerHTML = phrases.map((phrase, index) => `<button class="secondary" data-chat="${index}">${phrase}</button>`).join('');
$('#chat-button').addEventListener('click', () => $('#chat-dialog').showModal());
$('#history-button').addEventListener('click', () => {
  $('#history-content').innerHTML = `<div>${$('#scores').innerHTML}</div><h3>本局记录</h3><ol>${state.log.map(line => `<li>${escape(line)}</li>`).join('')}</ol>`;
  $('#history-dialog').showModal();
});
$('#chat-options').addEventListener('click', async event => {
  const b = event.target.closest('[data-chat]');
  if (b && await send('chat', { index: Number(b.dataset.chat) })) $('#chat-dialog').close();
});
let resizeTimer;
const resizeTable = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state) { cancelCardMotion(); render(); } }, 100); };
window.addEventListener('resize', resizeTable);
window.visualViewport?.addEventListener('resize', resizeTable);
connectionUI();
