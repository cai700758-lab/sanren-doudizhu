const effects = {
  straight: { family: 'straight', title: '顺子', duration: 1400 },
  pairStraight: { family: 'pairs', title: '连对', duration: 1400 },
  airplane: { family: 'plane', title: '飞机', duration: 1600 },
  airplaneSingle: { family: 'plane', title: '飞机带单', duration: 1600 },
  airplanePair: { family: 'plane', title: '飞机带对', duration: 1600 },
  tripleSingle: { family: 'triple', title: '三带一', duration: 1200 },
  triplePair: { family: 'triple', title: '三带二', duration: 1200 },
  fourSingle: { family: 'four', title: '四带二', duration: 1200 },
  fourPair: { family: 'four', title: '四带两对', duration: 1200 },
  bomb: { family: 'bomb', title: '炸弹', duration: 1700 },
  rocket: { family: 'rocket', title: '王炸', duration: 1800 },
};
export const comboEffect = type => Object.hasOwn(effects, type) ? effects[type] : null;

const svg = (className, content) => `<svg class="${className}" viewBox="0 0 160 100" fill="none" aria-hidden="true">${content}</svg>`;
const rocket = svg('fx-rocket', '<path class="fx-flame" d="M62 68Q80 115 98 68L80 58Z" fill="#ffad45"/><path d="M64 43 48 70 62 73 70 59M96 43 112 70 98 73 90 59" fill="#ff9764" stroke="#174839" stroke-width="3"/><path d="M65 66C59 36 70 14 80 5 90 14 101 36 95 66Z" fill="#fff8df" stroke="#174839" stroke-width="3"/><path d="M70 19 80 5 90 19" fill="#ff9764"/><circle cx="80" cy="39" r="10" fill="#7cd4d4" stroke="#174839" stroke-width="3"/><path d="M66 64h28" stroke="#174839" stroke-width="4"/>');
export function comboArtwork(family, cards = []) {
  if (['straight', 'pairs', 'triple', 'four'].includes(family)) {
    let ordered = [...cards].sort((a, b) => a.rank - b.rank || a.id - b.id);
    if (family === 'triple' || family === 'four') {
      const count = family === 'triple' ? 3 : 4;
      const body = ordered.find(card => ordered.filter(other => other.rank === card.rank).length === count)?.rank;
      ordered = [...ordered.filter(card => card.rank === body), ...ordered.filter(card => card.rank !== body)];
    }
    const sample = ordered.slice(0, 6);
    const label = rank => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王' }[rank] || String(Number(rank)));
    return `<div class="combo-art fx-card-fan" aria-hidden="true"><i class="fx-sweep"></i>${sample.map((card, i) => `<span class="fx-mini-card${['♥', '♦'].includes(card.suit) || card.rank === 17 ? ' fx-red' : ''}" style="--i:${i};--tilt:${(i - (sample.length - 1) / 2) * 5}deg"><b>${label(card.rank)}</b><span>${['♠', '♥', '♣', '♦', '★'].includes(card.suit) ? card.suit : ''}</span></span>`).join('')}</div>`;
  }
  if (family === 'plane') return `<div class="combo-art fx-flight" aria-hidden="true"><i class="fx-flight-trail"></i>${svg('fx-plane', '<path d="M12 59 24 63 55 53 78 13 91 9 82 49 137 40Q152 39 149 47L91 68 65 90 51 92 65 69 30 78Z" fill="#fff8df" stroke="#174839" stroke-width="3" stroke-linejoin="round"/><path d="M32 57 23 37 34 34 54 51M93 47 119 43" stroke="#ffbc57" stroke-width="7" stroke-linecap="round"/>')}</div>`;
  if (family === 'bomb') return `<div class="combo-art fx-explosion" aria-hidden="true"><i class="fx-shockwave"></i>${Array.from({ length: 10 }, (_, i) => `<i class="fx-spark" style="--angle:${i * 36}deg;--i:${i}"></i>`).join('')}${svg('fx-bomb', '<path d="M86 25Q93 7 107 15" stroke="#ffe09a" stroke-width="5" stroke-linecap="round"/><path d="m105 7 3 6 8-1-6 5 2 8-7-6-6 2 4-6Z" fill="#ffd35c"/><path d="m69 24 21 5-4 13-21-5Z" fill="#789b89" stroke="#173d33" stroke-width="3"/><circle cx="74" cy="62" r="31" fill="#224e40" stroke="#ffdc83" stroke-width="3"/><path d="M53 58Q53 43 67 41" stroke="#a9cdb6" stroke-width="5" stroke-linecap="round"/>')}</div>`;
  if (family === 'rocket') return `<div class="combo-art fx-launch" aria-hidden="true"><i class="fx-launch-glow"></i><div class="fx-launcher fx-launcher-one">${rocket}</div><div class="fx-launcher fx-launcher-two">${rocket}</div><i class="fx-star fx-star-one">✦</i><i class="fx-star fx-star-two">✦</i></div>`;
  return '';
}
