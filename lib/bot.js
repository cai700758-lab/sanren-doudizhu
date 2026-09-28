import { classify, beats, findHint } from './game.js';

// Receives only its own cards and public table information, never opponents' hands.
export function chooseBotBid(hand, highestBid) {
  const counts = new Map();
  for (const card of hand) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  let strength = (counts.get(17) || 0) * 4 + (counts.get(16) || 0) * 3 + (counts.get(15) || 0);
  for (const count of counts.values()) strength += count >= 4 ? count : count === 3 ? 1 : 0;
  const wanted = strength >= 10 ? 3 : strength >= 6 ? 2 : 1;
  return wanted > highestBid ? wanted : 0;
}

export function chooseBotPlay(hand, { selfId, landlordId, lastPlay, players, mode = 'classic' }) {
  const target = lastPlay?.combo;
  if (beats(classify(hand, mode), target)) return hand;
  const enemies = players.filter(p => p.id !== selfId && (p.id === landlordId || selfId === landlordId));
  const urgent = enemies.some(p => p.count <= 2);
  if (target) {
    // Farmers leave a teammate in control, unless this hand can immediately win.
    if (selfId !== landlordId && lastPlay.playerId !== landlordId) return null;
    if (urgent && target.type === 'single') {
      const blockingCard = [...hand].sort((a, b) => b.rank - a.rank).find(c => beats(classify([c], mode), target));
      if (blockingCard) return [blockingCard];
    }
    return findHint(hand, target, mode);
  }

  const candidates = [];
  const add = (type, size, chain = 1) => {
    const cards = findHint(hand, { type, size, chain, rank: 2 }, mode);
    if (cards && classify(cards, mode)?.type === type) candidates.push(cards);
  };
  for (const [type, size] of [['single', 1], ['pair', 2], ['triple', 3], ['tripleSingle', 4], ['triplePair', 5], ['fourSingle', 6], ['fourPair', 8], ['bomb', 4], ['rocket', 2]]) add(type, size);
  if (mode === 'four') { for (let size = 5; size <= 8; size++) add('bomb', size); add('rocket', 4); }
  for (let len = 5; len <= Math.min(12, hand.length); len++) add('straight', len, len);
  for (let len = 3; len * 2 <= hand.length; len++) add('pairStraight', len * 2, len);
  for (const [type, unit] of [['airplane', 3], ['airplaneSingle', 4], ['airplanePair', 5]]) {
    for (let len = 2; len * unit <= hand.length; len++) add(type, len * unit, len);
  }
  const counts = new Map();
  for (const card of hand) counts.set(card.rank, (counts.get(card.rank) || 0) + 1);
  function score(cards) {
    const combo = classify(cards, mode);
    let value = cards.length * 9 - combo.rank * .8;
    if (['bomb', 'rocket', 'fourSingle', 'fourPair'].includes(combo.type)) value -= 45;
    for (const c of cards) {
      if (c.rank >= 15) value -= 6;
      if (counts.get(c.rank) >= 4 && !['bomb', 'fourSingle', 'fourPair'].includes(combo.type)) value -= 12;
    }
    if (combo.type === 'single' && enemies.some(p => p.count === 1)) value -= 45;
    return value;
  }
  candidates.sort((a, b) => score(b) - score(a));
  return candidates[0] || findHint(hand, null, mode);
}
