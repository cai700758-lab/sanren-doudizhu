import { makeDeck, sortCards, findHint, classify, beats, isSkillMode } from './game.js';

export const SKILLS = {
  wild: { name: '万能牌', icon: '✦', description: '随机一张手牌变为万能牌，出牌前可指定任意点数，包括大小王。' },
  gift: { name: '赠牌', icon: '↗', description: '随机将两张手牌交给指定玩家；不足两张则交出剩余手牌。', target: true },
  steal: { name: '顺手牵羊', icon: '↙', description: '从指定玩家手中随机拿走最多两张牌；拿空对方手牌时，对方获胜。', target: true },
  reroll: { name: '换牌', icon: '↻', description: '选择两张手牌，分别替换为随机牌；不足两张则替换剩余手牌。' },
  remove: { name: '弃小牌', icon: '−', description: '删除手中最小的两张牌；不足两张则删除剩余手牌。' },
  clone: { name: '复制', icon: '＋', description: '随机复制自己的两张手牌；只剩一张时复制它两次。' },
  draw: { name: '摸四张', icon: '✥', description: '获得四张随机牌。' },
  draft: { name: '四选一', icon: '♧', description: '查看四张随机牌，选择其中一张加入手牌。' },
  peek: { name: '知己知彼', icon: '◉', description: '查看指定玩家最多五张随机手牌，仅自己可见；不足五张则查看全部。', target: true },
  upgrade: { name: '步步高升', icon: '↑', description: '选择一张普通牌升一级或两级，按3～A、2、小王、大王排序；大王不能升级，也不能越过大王。', card: true },
};
export const SKILL_IDS = Object.keys(SKILLS);
const requireRule = (condition, message) => { if (!condition) throw new Error(message); };
const templateDeck = makeDeck();
export const canUpgrade = card => !card.wild && card.rank >= 3 && card.rank < 17;

export function applySkill(room, player, data, random) {
  requireRule(isSkillMode(room.mode), '经典模式不能使用技能。');
  requireRule(room.phase === 'playing' && room.players[room.turn] === player, '只能在自己的出牌回合使用技能。');
  requireRule(player.skill && !player.skill.used && !player.skill.choices, '本局技能已经使用。');
  const id = player.skill.id;
  requireRule(Object.hasOwn(SKILLS, id), '技能不存在。');
  requireRule(player.hand.length > 0, '没有可操作的手牌。');
  const card = player.hand.find(item => item.id === data.cardId);
  if (SKILLS[id].card) requireRule(card, '请选择自己的手牌。');
  const recipient = room.players.find(item => item.id === data.targetId && item !== player);
  if (SKILLS[id].target) requireRule(recipient, '请选择另一名玩家。');
  if (id === 'upgrade') requireRule(canUpgrade(card), '大王和万能牌不能升级，请选择其他手牌。');
  const steps = data.steps === undefined ? 1 : data.steps;
  if (id === 'upgrade') requireRule((steps === 1 || steps === 2) && card.rank + steps <= 17, '升级不能越过大王。');
  const fresh = () => ({ ...templateDeck[random(templateDeck.length)], id: room.nextCardId++ });
  let affectedCount = 0;
  const sample = (hand, count) => {
    const pool = [...hand], picked = [];
    while (picked.length < count && pool.length) picked.push(pool.splice(random(pool.length), 1)[0]);
    return picked;
  };
  if (id === 'wild') {
    const chosen = player.hand[random(player.hand.length)];
    player.hand = player.hand.map(item => item.id === chosen.id ? { ...item, rank: 15, suit: '✦', wild: true } : item);
  } else if (id === 'gift') {
    const given = sample(player.hand, 2), ids = new Set(given.map(item => item.id));
    affectedCount = given.length;
    player.hand = player.hand.filter(item => !ids.has(item.id));
    recipient.hand = sortCards([...recipient.hand, ...given]);
  } else if (id === 'steal') {
    const taken = sample(recipient.hand, 2), ids = new Set(taken.map(item => item.id));
    affectedCount = taken.length;
    recipient.hand = recipient.hand.filter(item => !ids.has(item.id));
    player.hand = sortCards([...player.hand, ...taken]);
  } else if (id === 'reroll') {
    const ids = data.cardIds;
    requireRule(Array.isArray(ids) && ids.length === Math.min(2, player.hand.length) && new Set(ids).size === ids.length && ids.every(cardId => player.hand.some(item => item.id === cardId)), '请选择两张不同的手牌。');
    affectedCount = ids.length;
    const replacing = new Set(ids);
    player.hand = player.hand.map(item => replacing.has(item.id) ? fresh() : item);
  } else if (id === 'remove') {
    const smallest = [...player.hand].sort((a, b) => a.rank - b.rank || a.id - b.id).slice(0, 2);
    affectedCount = smallest.length;
    const ids = new Set(smallest.map(item => item.id));
    player.hand = player.hand.filter(item => !ids.has(item.id));
  } else if (id === 'clone') {
    const originals = player.hand.length === 1 ? [player.hand[0], player.hand[0]] : sample(player.hand, 2);
    player.hand.push(...originals.map(item => ({ ...item, id: room.nextCardId++ })));
  } else if (id === 'draw') {
    player.hand.push(fresh(), fresh(), fresh(), fresh());
  } else if (id === 'draft') {
    player.skill.choices = [fresh(), fresh(), fresh(), fresh()];
  } else if (id === 'peek') {
    const cards = sample(recipient.hand, 5).map(item => ({ ...item }));
    player.skill.inspection = { targetId: recipient.id, targetName: recipient.name, cards: sortCards(cards) };
  } else if (id === 'upgrade') {
    player.hand = player.hand.map(item => item.id === card.id ? { ...item, rank: item.rank + steps, suit: item.rank + steps >= 16 ? '★' : item.suit } : item);
  }
  player.skill.used = true;
  player.hand = sortCards(player.hand);
  return { id, targetId: SKILLS[id].target ? recipient.id : undefined, steps: id === 'upgrade' ? steps : undefined, count: ['gift', 'steal', 'reroll', 'remove'].includes(id) ? affectedCount : undefined };
}

export function chooseSkillCard(room, player, cardId) {
  requireRule(isSkillMode(room.mode) && room.phase === 'playing' && room.players[room.turn] === player, '只能在自己的回合完成选牌。');
  const card = player.skill?.choices?.find(item => item.id === cardId);
  requireRule(card, '请选择本次技能提供的牌。');
  player.hand = sortCards([...player.hand, card]);
  player.skill.choices = null;
}

export function resolveWildCards(cards, assignments = {}) {
  requireRule(assignments && typeof assignments === 'object' && !Array.isArray(assignments), '万能牌点数格式不正确。');
  for (const key of Object.keys(assignments)) requireRule(cards.some(card => card.wild && String(card.id) === key), '只能指定本次出牌中的万能牌。');
  return cards.map(card => {
    if (!card.wild) return card;
    const rank = assignments[card.id] ?? 15;
    requireRule(Number.isInteger(rank) && rank >= 3 && rank <= 17, '请选择有效的万能牌点数。');
    return { ...card, rank };
  });
}

// There is at most one wildcard per naturally dealt skill; keep the helper general for copied cards.
export function* wildHands(hand, index = 0) {
  const next = hand.findIndex((card, i) => i >= index && card.wild);
  if (next < 0) { yield hand; return; }
  for (let rank = 3; rank <= 17; rank++) yield* wildHands(hand.map((card, i) => i === next ? { ...card, rank } : card), next + 1);
}
export function findSkillHint(hand, target, mode = 'skills') {
  let best = null;
  for (const variant of wildHands(hand)) {
    const candidate = beats(classify(variant, mode), target) ? variant : findHint(variant, target, mode);
    if (candidate && (!best || candidate.length > best.length || (candidate.length === best.length && classify(candidate, mode).rank < classify(best, mode).rank))) best = candidate;
  }
  return best;
}
