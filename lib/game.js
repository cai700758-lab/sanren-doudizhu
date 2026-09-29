// The same pure rules power server validation and client-side selection feedback.
export const TYPE_NAMES = {
  single: '单张', pair: '对子', triple: '三张', tripleSingle: '三带一',
  triplePair: '三带二', straight: '顺子', pairStraight: '连对',
  airplane: '飞机', airplaneSingle: '飞机带单', airplanePair: '飞机带对',
  fourSingle: '四带二', fourPair: '四带两对', bomb: '炸弹', rocket: '王炸', superBomb: '五个三',
};
export const rankLabel = rank => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' }[rank] || String(rank));
export const sortCards = cards => [...cards].sort((a, b) => b.rank - a.rank || b.id - a.id);
export const RACE_TARGET = 48;
export const MODES = {
  classic: { name: '三人经典', players: 3, dealt: 17, bottom: 3, maxHand: 20 },
  skills: { name: '三人技能', players: 3, dealt: 17, bottom: 3, maxHand: 28 },
  four: { name: '四人经典', players: 4, dealt: 25, bottom: 8, maxHand: 33 },
  fourSkills: { name: '四人技能', players: 4, dealt: 25, bottom: 8, maxHand: 43 },
  race: { name: '三人竞速', players: 3, dealt: 18, bottom: 0, maxHand: 18 },
};
export const modeRules = mode => MODES[mode] || MODES.classic;
export const isFourMode = mode => mode === 'four' || mode === 'fourSkills';
export const isSkillMode = mode => mode === 'skills' || mode === 'fourSkills';
export const isRaceMode = mode => mode === 'race';
export function makeDeck(mode = 'classic') {
  const cards = [];
  for (let rank = 3; rank <= 15; rank++) {
    for (const suit of ['♠', '♥', '♣', '♦']) cards.push({ id: cards.length, rank, suit });
  }
  cards.push({ id: 52, rank: 16, suit: '★' }, { id: 53, rank: 17, suit: '★' });
  return isFourMode(mode) || isRaceMode(mode) ? [...cards, ...cards.map(card => ({ ...card, id: card.id + 54 }))] : cards;
}
const consecutive = ranks => ranks.every((rank, i) => !i || rank === ranks[i - 1] + 1);
export function classify(cards, mode = 'classic') {
  const four = isFourMode(mode);
  if (!Array.isArray(cards) || !cards.length || cards.length > (mode === 'fourSkills' ? 43 : four ? 33 : 32)) return null;
  if (new Set(cards.map(c => c.id)).size !== cards.length) return null;
  const groups = new Map();
  for (const c of cards) {
    if (!Number.isInteger(c.rank) || c.rank < 3 || c.rank > 17) return null;
    groups.set(c.rank, (groups.get(c.rank) || 0) + 1);
  }
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  const counts = [...groups.values()];
  const n = cards.length;
  const result = (type, rank, chain = 1) => ({ type, rank, chain, size: n, name: four && type === 'rocket' ? '四王炸' : (four || isRaceMode(mode) && n >= 5) && type === 'bomb' ? `${n}张炸弹` : TYPE_NAMES[type] });
  if (isRaceMode(mode) && n === 5 && groups.get(3) === 5) return result('superBomb', 3);
  if (four ? n === 4 && groups.get(16) === 2 && groups.get(17) === 2 : n === 2 && groups.has(16) && groups.has(17)) return result('rocket', 17);
  if (ranks.length === 1) {
    if ((four || isRaceMode(mode)) && n >= 4 && n <= 8 && ranks[0] <= 15) return result('bomb', ranks[0]);
    if ((four || isRaceMode(mode)) && ranks[0] >= 16 && n > 2) return null;
    const type = { 1: 'single', 2: 'pair', 3: 'triple', 4: 'bomb' }[n];
    return type ? result(type, ranks[0]) : null;
  }
  if (!four && n === 4 && counts.includes(3)) return result('tripleSingle', ranks.find(r => groups.get(r) === 3));
  if (n === 5 && counts.includes(3) && counts.includes(2)) return result('triplePair', ranks.find(r => groups.get(r) === 3));
  if (n >= 5 && ranks.length === n && ranks.at(-1) <= 14 && consecutive(ranks)) return result('straight', ranks.at(-1), n);
  if (n >= 6 && n % 2 === 0 && counts.every(c => c === 2) && ranks.at(-1) <= 14 && consecutive(ranks)) return result('pairStraight', ranks.at(-1), n / 2);
  if (!four && counts.includes(4)) {
    const four = ranks.find(r => groups.get(r) === 4);
    if (n === 6 && !(groups.has(16) && groups.has(17))) return result('fourSingle', four);
    if (n === 8 && ranks.length === 3 && counts.filter(c => c === 2).length === 2) return result('fourPair', four);
  }
  // A wing cannot reuse a body rank. Single wings may form pairs, but not a rocket.
  for (const [type, unit] of [['airplane', 3], ['airplaneSingle', 4], ['airplanePair', 5]]) {
    if (four && unit === 4) continue;
    const len = n / unit;
    if (!Number.isInteger(len) || len < 2) continue;
    for (let start = 3; start + len - 1 <= 14; start++) {
      const body = Array.from({ length: len }, (_, i) => start + i);
      if (!body.every(r => groups.get(r) === 3)) continue;
      const wings = ranks.filter(r => !body.includes(r));
      if (unit === 3 && wings.length) continue;
      if (unit === 4 && groups.has(16) && groups.has(17)) continue;
      if (unit === 4 && wings.some(r => groups.get(r) === 4)) continue;
      if (unit === 5 && (wings.length !== len || !wings.every(r => groups.get(r) === 2))) continue;
      return result(type, body.at(-1), len);
    }
  }
  return null;
}
export function beats(play, target) {
  if (!play) return false;
  if (!target) return true;
  const bombSize = combo => combo.type === 'superBomb' ? 5 : combo.type === 'bomb' ? combo.size : 0;
  const playBomb = bombSize(play), targetBomb = bombSize(target);
  if (target.type === 'rocket') return target.size === 2 && playBomb >= 5;
  if (play.type === 'rocket') return !(play.size === 2 && targetBomb >= 5);
  if (playBomb && targetBomb) return playBomb !== targetBomb ? playBomb > targetBomb : play.rank > target.rank;
  if (targetBomb) return false;
  if (playBomb) return true;
  return play.type === target.type && play.size === target.size && play.chain === target.chain && play.rank > target.rank;
}

// Keep as many selected cards as possible, without adding cards from the hand.
// Enumerating legal bodies and wings avoids a 2^20 subset search on the UI thread.
export function findClosestSelection(cards, target = null, mode = 'classic') {
  const four = isFourMode(mode);
  if (!Array.isArray(cards) || !cards.length || cards.length > (mode === 'fourSkills' ? 43 : four ? 33 : 32) || new Set(cards.map(card => card.id)).size !== cards.length) return null;
  if (beats(classify(cards, mode), target)) return [...cards];
  const groups = new Map();
  for (const card of [...cards].sort((a, b) => a.rank - b.rank || a.id - b.id)) {
    if (!Number.isInteger(card.rank) || card.rank < 3 || card.rank > 17) return null;
    if (!groups.has(card.rank)) groups.set(card.rank, []);
    groups.get(card.rank).push(card);
  }
  const entries = [...groups];
  const chainTypes = new Set(['straight', 'pairStraight', 'airplane', 'airplaneSingle', 'airplanePair']);
  let best = null, bestScore = null;
  function consider(candidate) {
    const combo = classify(candidate, mode);
    if (!beats(combo, target)) return false;
    const score = [candidate.length, chainTypes.has(combo.type) ? 1 : 0, ['bomb', 'rocket', 'superBomb'].includes(combo.type) ? 0 : 1, -combo.rank];
    if (!bestScore || score.some((value, i) => value > bestScore[i] && score.slice(0, i).every((v, j) => v === bestScore[j]))) {
      best = candidate; bestScore = score;
    }
    return true;
  }
  function withWings(body, count, pairs) {
    const total = body.length + count * (pairs ? 2 : 1);
    if (total > cards.length || (best && total < best.length)) return;
    const bodyRanks = new Set(body.map(card => card.rank));
    const available = entries.filter(([rank, list]) => !bodyRanks.has(rank) && (!pairs || list.length >= 2));
    function visit(index, remaining, wings) {
      if (!remaining) return consider([...body, ...wings]);
      if (index === available.length) return false;
      if (available.slice(index).reduce((sum, [, list]) => sum + (pairs ? 1 : Math.min(3, list.length)), 0) < remaining) return false;
      const list = available[index][1];
      for (let take = Math.min(remaining, pairs ? 1 : Math.min(3, list.length)); take >= 0; take--) {
        if (visit(index + 1, remaining - take, [...wings, ...list.slice(0, take * (pairs ? 2 : 1))])) return true;
      }
      return false;
    }
    visit(0, count, []);
  }
  for (const [, list] of entries) {
    for (let size = 1; size <= Math.min(four || isRaceMode(mode) ? 8 : 4, list.length); size++) consider(list.slice(0, size));
    if (list.length >= 3) { if (!four) withWings(list.slice(0, 3), 1, false); withWings(list.slice(0, 3), 1, true); }
    if (!four && list.length >= 4) { withWings(list.slice(0, 4), 2, false); withWings(list.slice(0, 4), 2, true); }
  }
  if (groups.has(16) && groups.has(17)) consider([...groups.get(16).slice(0, four ? 2 : 1), ...groups.get(17).slice(0, four ? 2 : 1)]);
  for (const width of [1, 2, 3]) {
    const minimum = width === 1 ? 5 : width === 2 ? 3 : 2;
    for (let start = 3; start <= 14; start++) {
      const body = [];
      for (let end = start; end <= 14; end++) {
        if ((groups.get(end)?.length || 0) < width) break;
        body.push(...groups.get(end).slice(0, width));
        const length = end - start + 1;
        if (length < minimum) continue;
        consider([...body]);
        if (width === 3) { if (!four) withWings(body, length, false); withWings(body, length, true); }
      }
    }
  }
  return best;
}
function* choose(items, count, index = 0, prefix = []) {
  if (count === 0) { yield prefix; return; }
  for (let i = index; i <= items.length - count; i++) yield* choose(items, count - 1, i + 1, [...prefix, items[i]]);
}
export function findHint(hand, target = null, mode = 'classic') {
  const four = isFourMode(mode);
  const groups = new Map();
  for (const c of [...hand].sort((a, b) => a.rank - b.rank || a.id - b.id)) {
    if (!groups.has(c.rank)) groups.set(c.rank, []);
    groups.get(c.rank).push(c);
  }
  const entries = [...groups];
  const accept = cards => beats(classify(cards, mode), target);
  const types = target ? [target.type] : ['single'];
  for (const type of types) {
    if (four && ['tripleSingle', 'fourSingle', 'fourPair', 'airplaneSingle'].includes(type)) continue;
    const amount = { single: 1, pair: 2, triple: 3, bomb: four || isRaceMode(mode) ? target?.size || 4 : 4 }[type];
    if (amount) for (const [, cs] of entries) if (cs.length >= amount && accept(cs.slice(0, amount))) return cs.slice(0, amount);
    if (['tripleSingle', 'triplePair', 'fourSingle', 'fourPair'].includes(type)) {
      const coreSize = type.startsWith('four') ? 4 : 3;
      const pairs = type.endsWith('Pair');
      const wingCount = type.startsWith('four') ? 2 : 1;
      for (const [rank, cs] of entries) {
        if (cs.length < coreSize) continue;
        const wingGroups = entries.filter(([r, list]) => r !== rank && (!pairs || list.length >= 2));
        const options = pairs ? wingGroups.map(([, list]) => list.slice(0, 2)) : wingGroups.flatMap(([, list]) => list.map(c => [c]));
        for (const wings of choose(options, wingCount)) {
          const cards = [...cs.slice(0, coreSize), ...wings.flat()];
          if (accept(cards)) return cards;
        }
      }
    }
    if (['straight', 'pairStraight', 'airplane', 'airplaneSingle', 'airplanePair'].includes(type)) {
      const width = type === 'straight' ? 1 : type === 'pairStraight' ? 2 : 3;
      const len = target.chain;
      for (let start = 3; start + len - 1 <= 14; start++) {
        const ranks = Array.from({ length: len }, (_, i) => start + i);
        if (!ranks.every(r => (groups.get(r)?.length || 0) >= width)) continue;
        const core = ranks.flatMap(r => groups.get(r).slice(0, width));
        if (['straight', 'pairStraight', 'airplane'].includes(type)) { if (accept(core)) return core; continue; }
        const pairs = type === 'airplanePair';
        const rest = entries.filter(([r, cs]) => !ranks.includes(r) && (!pairs || cs.length >= 2));
        const options = pairs ? rest.map(([, cs]) => cs.slice(0, 2)) : rest.flatMap(([, cs]) => cs.map(c => [c]));
        for (const wings of choose(options, len)) {
          const cards = [...core, ...wings.flat()];
          if (accept(cards)) return cards;
        }
      }
    }
  }
  for (let size = 4; size <= (four || isRaceMode(mode) ? 8 : 4); size++) {
    for (const [, cs] of entries) if (cs.length >= size && accept(cs.slice(0, size))) return cs.slice(0, size);
  }
  if (groups.has(16) && groups.has(17)) {
    const rocket = [...groups.get(16).slice(0, four ? 2 : 1), ...groups.get(17).slice(0, four ? 2 : 1)];
    if (accept(rocket)) return rocket;
  }
  if (mode === 'race' && (groups.get(3)?.length || 0) >= 5) {
    const superBomb = groups.get(3).slice(0, 5);
    if (accept(superBomb)) return superBomb;
  }
  return null;
}
