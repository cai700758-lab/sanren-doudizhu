// Derive presentation events from authoritative snapshots, never from local clicks.
import { comboEffect } from './combo-effects.js';
export function tableCues(previous, next) {
  if (!previous || !next || previous.code !== next.code) return [];
  if (next.dealId !== previous.dealId && ['bidding', 'playing'].includes(next.phase)) return [{ kind: 'deal' }];
  if (previous.round !== next.round || previous.dealId !== next.dealId) return [];
  const cues = [];
  if (previous.phase === 'bidding' && next.phase === 'playing') cues.push({ kind: 'landlord', playerId: next.landlordId });
  for (const player of next.players) {
    const play = next.tablePlays?.[player.id];
    if (play && play.sequence !== previous.tablePlays?.[player.id]?.sequence) {
      cues.push({ kind: comboEffect(play.combo.type) ? play.combo.type : 'play', playerId: player.id });
      if (next.mode !== 'race' && next.phase === 'playing' && player.count > 0 && player.count <= 2) {
        cues.push({ kind: 'warning', playerId: player.id, count: player.count });
      }
    }
    const pass = next.tablePasses?.[player.id];
    if (pass && pass.sequence !== previous.tablePasses?.[player.id]?.sequence) cues.push({ kind: 'pass', playerId: player.id });
  }
  if (previous.phase !== 'finished' && next.phase === 'finished') {
    const delta = next.result.deltas.find(item => item.id === next.me)?.delta || 0;
    cues.push({ kind: delta > 0 ? 'win' : 'lose', playerId: next.result.winnerId, delta });
  }
  return cues;
}
