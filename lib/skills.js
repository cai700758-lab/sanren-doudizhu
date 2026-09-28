import { makeDeck, sortCards, findHint, classify, beats, isSkillMode } from './game.js';

export const SKILLS = {
  wild: { name: '万能牌', icon: '✦', description: '最大的手牌变为万能牌，出牌前可指定为任意点数，包括大小王。' },
  gift: { name: '赠牌', icon: '↗', description: '选择一张手牌，交给另一名玩家。', card: true, target: true },
  reroll: { name: '换牌', icon: '↻', description: '选择一张手牌，替换为一张随机牌。', card: true },
  remove: { name: '弃小牌', icon: '−', description: '删除最小的一张手牌。' },
  clone: { name: '复制', icon: '＋', description: '随机复制自己的一张手牌。' },
  draw: { name: '摸三张', icon: '✥', description: '获得三张随机牌。' },
  draft: { name: '三选一', icon: '♧', description: '查看三张随机牌，选择其中一张加入手牌。' },
  peek: { name: '知己知彼', icon: '◉', description: '查看指定玩家最多三张随机手牌，仅自己可见；不足三张则查看全部。', target: true },
  upgrade: { name: '步步高升', icon: '↑', description: '选择一张牌升一级：3～A、2、小王、大王。2可变小王，小王可变大王，大王不能升级。', card: true },
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
  const fresh = () => ({ ...templateDeck[random(templateDeck.length)], id: room.nextCardId++ });
  if (id === 'wild') {
    const largest = sortCards(player.hand)[0];
    player.hand = player.hand.map(item => item.id === largest.id ? { ...item, rank: 15, suit: '✦', wild: true } : item);
  } else if (id === 'gift') {
    player.hand = player.hand.filter(item => item.id !== card.id);
    recipient.hand = sortCards([...recipient.hand, card]);
  } else if (id === 'reroll') {
    player.hand = player.hand.map(item => item.id === card.id ? fresh() : item);
  } else if (id === 'remove') {
    const smallest = [...player.hand].sort((a, b) => a.rank - b.rank || a.id - b.id)[0];
    player.hand = player.hand.filter(item => item.id !== smallest.id);
  } else if (id === 'clone') {
    player.hand.push({ ...player.hand[random(player.hand.length)], id: room.nextCardId++ });
  } else if (id === 'draw') {
    player.hand.push(fresh(), fresh(), fresh());
  } else if (id === 'draft') {
    player.skill.choices = [fresh(), fresh(), fresh()];
  } else if (id === 'peek') {
    const pool = [...recipient.hand], cards = [];
    while (cards.length < 3 && pool.length) cards.push({ ...pool.splice(random(pool.length), 1)[0] });
    player.skill.inspection = { targetId: recipient.id, targetName: recipient.name, cards: sortCards(cards) };
  } else if (id === 'upgrade') {
    player.hand = player.hand.map(item => item.id === card.id ? { ...item, rank: item.rank + 1, suit: item.rank >= 15 ? '★' : item.suit } : item);
  }
  player.skill.used = true;
  player.hand = sortCards(player.hand);
  return { id, targetId: SKILLS[id].target ? recipient.id : undefined };
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
