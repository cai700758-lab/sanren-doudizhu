import { SKILLS } from '/skills.js';
import { isSkillMode } from '/game.js';
import { skillIcon } from './skill-icons.js';

export const SKILL_NOTICE_MS = 5200;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function skillOutcome(event, players) {
  const target = players.find(player => player.id === event.targetId)?.name || '另一位玩家';
  return {
    wild: '最大手牌已变为万能牌 · 可替代大小王',
    gift: `已交给 ${target} 一张牌 · 自己 −1 / 对方 +1`,
    reroll: '一张手牌已随机替换 · 张数不变',
    remove: '最小手牌已移除 · 手牌 −1',
    clone: '已随机复制一张手牌 · 手牌 +1',
    draw: '已获得三张随机牌 · 手牌 +3',
    draft: event.stage === 'choice' ? '已选取一张牌加入手牌 · 手牌 +1' : '正在三张随机牌中选择 · 候选牌仅本人可见',
    peek: `已查看 ${target} 的随机手牌 · 牌面仅使用者可见`,
    upgrade: '一张手牌已升一级 · 张数不变',
  }[event.skillId];
}

// Separate from ordinary card animations: a subsequent play must not cancel a skill.
export function createSkillEffects({ reducedMotion }) {
  const arena = document.querySelector('.arena');
  const notice = document.createElement('section');
  notice.className = 'skill-announcement'; notice.hidden = true;
  notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite'); notice.setAttribute('aria-atomic', 'true');
  document.querySelector('.table-stage').append(notice);
  const layer = document.createElement('div');
  layer.className = 'skill-motion-layer'; layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  let active = null, timer, startedAt = 0;
  const queue = [], animations = new Set();

  function clearMotion() {
    for (const animation of animations) animation.cancel();
    animations.clear(); layer.replaceChildren();
  }
  function reset() {
    clearTimeout(timer); queue.length = 0; active = null;
    notice.hidden = true; notice.replaceChildren();
    arena.classList.remove('showing-skill'); clearMotion();
  }
  function seat(playerId) {
    const zone = [...document.querySelectorAll('.player-play')].find(node => node.dataset.playerId === playerId);
    const selector = zone?.id === 'my-play' ? '#hand' : zone?.id === 'left-play' ? '#left-player .opponent-hand' : zone?.id === 'top-play' ? '#top-player .opponent-hand' : '#right-player .opponent-hand';
    const node = document.querySelector(selector) || document.querySelector('#bottom-cards');
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  function deck() {
    const box = document.querySelector('#bottom-cards').getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  function animate(node, frames, options) {
    const motion = node.animate(frames, { duration: 1700, easing: 'cubic-bezier(.25,.65,.25,1)', fill: 'both', ...options });
    animations.add(motion);
    motion.finished.then(() => { animations.delete(motion); node.remove(); }, () => { animations.delete(motion); node.remove(); });
  }
  const transform = (point, scale = 1, angle = 0) => `translate(${point.x}px, ${point.y}px) translate(-50%, -50%) scale(${scale}) rotate(${angle}deg)`;
  function card(point, face = '', index = 0) {
    const node = document.createElement('div');
    node.className = `skill-fx-card${face ? ' skill-fx-face' : ''}`;
    node.dataset.skill = active.event.skillId; node.dataset.index = index;
    node.style.transform = transform(point);
    node.innerHTML = face ? skillIcon(face) : '<span>♠</span>';
    layer.append(node); return node;
  }
  function pulse(point, text, delay = 0) {
    const node = document.createElement('div'); node.className = 'skill-fx-pulse';
    node.textContent = text; layer.append(node);
    animate(node, [
      { transform: transform(point, .65), opacity: 0 },
      { transform: transform({ x: point.x, y: point.y - 16 }, 1), opacity: 1, offset: .25 },
      { transform: transform({ x: point.x, y: point.y - 40 }, 1.1), opacity: 0 },
    ], { duration: 1600, delay });
  }
  function fly(from, to, { delay = 350, index = 0, face = '' } = {}) {
    const node = card(from, face, index);
    const middle = { x: (from.x + to.x) / 2 + (index - 1) * 16, y: (from.y + to.y) / 2 - 70 };
    animate(node, [
      { transform: transform(from, .7, -12), opacity: 0 },
      { transform: transform(from, 1, -8), opacity: 1, offset: .12 },
      { transform: transform(middle, 1.1, 10), opacity: 1, offset: .5 },
      { transform: transform(to, .8), opacity: 1, offset: .9 },
      { transform: transform(to, .65), opacity: 0 },
    ], { delay });
  }
  function perform(event) {
    clearMotion();
    if (reducedMotion.matches || document.hidden) return;
    const from = seat(event.playerId), source = deck();
    const raised = { x: from.x, y: from.y - 55 };
    layer.dataset.skill = event.skillId;
    layer.dataset.actor = event.playerId;
    layer.dataset.target = event.targetId || '';
    if (event.skillId === 'gift') {
      const to = seat(event.targetId);
      fly(from, to); pulse(from, '−1', 350); pulse(to, '+1', 1700);
    } else if (event.skillId === 'peek') {
      const target = seat(event.targetId);
      const node = card(target, 'peek');
      animate(node, [
        { transform: transform(target, .6), opacity: 0 },
        { transform: transform({ x: target.x, y: target.y - 38 }, 1.2), opacity: 1, offset: .3 },
        { transform: transform({ x: target.x, y: target.y - 38 }, 1.2), opacity: 1, offset: .75 },
        { transform: transform(target, .6), opacity: 0 },
      ], { duration: 2600, delay: 350 });
      pulse(target, '查看手牌', 1100);
    } else if (event.skillId === 'upgrade') {
      const node = card(from, 'upgrade');
      animate(node, [
        { transform: transform(from, .7), opacity: 0 },
        { transform: transform(raised, 1.15), opacity: 1, offset: .35 },
        { transform: transform({ x: raised.x, y: raised.y - 25 }, 1.2), opacity: 1, offset: .65 },
        { transform: transform(from, .7), opacity: 0 },
      ], { duration: 2500, delay: 350 });
      pulse(raised, '↑ 升一级', 1100);
    } else if (event.skillId === 'draw') {
      for (let i = 0; i < 3; i++) fly({ x: source.x + (i - 1) * 18, y: source.y }, from, { delay: 350 + i * 230, index: i });
      pulse(from, '+3', 2100);
    } else if (event.skillId === 'draft') {
      if (event.stage === 'choice') {
        fly(raised, from, { face: 'draft' }); pulse(from, '+1', 1700);
      } else for (let i = 0; i < 3; i++) {
        const node = card(source, '', i), fan = { x: from.x + (i - 1) * 42, y: from.y - 65 };
        animate(node, [
          { transform: transform(source, .5), opacity: 0 },
          { transform: transform(fan, 1, (i - 1) * 12), opacity: 1, offset: .3 },
          { transform: transform(fan, 1, (i - 1) * 12), opacity: 1, offset: .85 },
          { transform: transform(fan, .8), opacity: 0 },
        ], { duration: 3000, delay: i * 180 });
      }
    } else if (event.skillId === 'clone') {
      for (let i = 0; i < 2; i++) {
        const node = card(from, '', i);
        animate(node, [
          { transform: transform(from, .7), opacity: 0 },
          { transform: transform(raised), opacity: 1, offset: .25 },
          { transform: transform({ x: raised.x + (i ? 34 : -34), y: raised.y }, 1, i ? 10 : -10), opacity: 1, offset: .65 },
          { transform: transform(from, .7), opacity: 0 },
        ], { duration: 2300, delay: 350 });
      }
      pulse(from, '+1', 2150);
    } else if (event.skillId === 'remove') {
      const node = card(from, 'remove');
      animate(node, [
        { transform: transform(from, .7), opacity: 0, filter: 'blur(0px)' },
        { transform: transform(raised), opacity: 1, filter: 'blur(0px)', offset: .35 },
        { transform: transform({ x: raised.x, y: raised.y - 35 }, .1, -30), opacity: 0, filter: 'blur(8px)' },
      ], { duration: 2100, delay: 350 });
      pulse(from, '−1', 1550);
    } else {
      // Wildcard lights up; reroll flips out the old card and reveals a new back.
      const node = card(from, event.skillId);
      animate(node, [
        { transform: `${transform(from, .7)} rotateY(0deg)`, opacity: 0 },
        { transform: `${transform(raised, 1.15)} rotateY(0deg)`, opacity: 1, offset: .25 },
        { transform: `${transform(raised, 1.15)} rotateY(${event.skillId === 'wild' ? 360 : 540}deg)`, opacity: 1, offset: .65 },
        { transform: `${transform(from, .7)} rotateY(720deg)`, opacity: 0 },
      ], { duration: 2500, delay: 350 });
      pulse(raised, event.skillId === 'wild' ? '✦ 万能牌' : '↻ 换牌', 1100);
    }
  }
  function paint() {
    const { event, players } = active, skill = SKILLS[event.skillId];
    const actor = players.find(player => player.id === event.playerId);
    notice.dataset.skill = event.skillId; notice.dataset.sequence = event.sequence; notice.dataset.stage = event.stage;
    notice.innerHTML = `<div class="skill-announcement-icon">${skillIcon(event.skillId)}</div><div class="skill-announcement-heading"><span>${escape(actor?.name || '玩家')} 使用了</span><strong>${skill.name}</strong></div><p class="skill-announcement-description">${skill.description}</p><p class="skill-announcement-result">${escape(skillOutcome(event, players))}</p>`;
  }
  function next() {
    clearTimeout(timer); clearMotion(); active = queue.shift() || null;
    if (!active) { notice.hidden = true; arena.classList.remove('showing-skill'); return; }
    startedAt = Date.now(); paint(); notice.hidden = false; arena.classList.add('showing-skill');
    perform(active.event); timer = setTimeout(next, SKILL_NOTICE_MS);
  }
  function enqueue(event, players) {
    if (!Object.hasOwn(SKILLS, event.skillId)) return;
    // A draft completion updates its existing notice instead of repeating the introduction.
    const matching = event.stage === 'choice' && [active, ...queue].find(item => item?.event.skillId === 'draft' && item.event.playerId === event.playerId);
    if (matching) {
      matching.event = event;
      if (matching === active) {
        paint(); perform(event); clearTimeout(timer);
        timer = setTimeout(next, Math.max(2800, SKILL_NOTICE_MS - (Date.now() - startedAt)));
      }
      return;
    }
    queue.push({ event, players }); if (!active) next();
  }
  function update(previous, state) {
    if (!previous || !state || !isSkillMode(state.mode) || previous.code !== state.code || previous.dealId !== state.dealId || state.phase === 'waiting') { reset(); return; }
    if (document.hidden) return;
    const after = previous.skillEvent?.sequence || 0;
    const events = state.skillEvents?.length ? state.skillEvents : state.skillEvent ? [state.skillEvent] : [];
    for (const event of events.filter(event => event.sequence > after)) enqueue(event, state.players);
  }
  reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) clearMotion(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  window.addEventListener('resize', clearMotion);
  return { update, reset, isPresenting: () => Boolean(active) };
}
