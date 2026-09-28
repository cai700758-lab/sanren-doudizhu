// Lightweight original sound effects; no downloads or background music.
export function createTableSound(enabled) {
  let context, output, noiseBuffer, lastTap = 0;
  const sources = new Set();
  function stop() {
    for (const source of sources) { try { source.stop(); } catch { /* Already ended. */ } }
    sources.clear();
  }
  function sourceEnvelope(source, time, duration, volume, destination = output) {
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, time);
    gain.gain.linearRampToValueAtTime(volume, time + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, time + duration);
    source.connect(gain); gain.connect(destination);
    sources.add(source); source.start(time); source.stop(time + duration + .02);
    source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
  }
  function tone(frequency, time, duration = .14, volume = .3, end = frequency, type = 'sine') {
    const source = context.createOscillator(); source.type = type;
    source.frequency.setValueAtTime(frequency, time);
    source.frequency.exponentialRampToValueAtTime(Math.max(20, end), time + duration);
    sourceEnvelope(source, time, duration, volume);
  }
  function noise(time, duration, volume, frequency = 2400) {
    if (!noiseBuffer) {
      noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const source = context.createBufferSource(); source.buffer = noiseBuffer;
    const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = frequency;
    filter.connect(output);
    sourceEnvelope(source, time, duration, volume, filter);
    const cleanup = source.onended;
    source.onended = () => { cleanup(); filter.disconnect(); };
  }
  function play(kind) {
    if (!enabled() || document.hidden) return;
    try {
      const Engine = window.AudioContext || window.webkitAudioContext;
      if (!Engine) return;
      if (!context) {
        context = new Engine(); output = context.createGain(); output.gain.value = .16; output.connect(context.destination);
      }
      if (context.state === 'suspended') { context.resume().catch(() => {}); return; }
      if (context.state !== 'running') return;
      const time = context.currentTime + .01;
      if (kind === 'tap') {
        if (time - lastTap < .07) return;
        lastTap = time; noise(time, .04, .15, 3500); tone(780, time, .035, .09, 400); return;
      }
      if (kind === 'play') { noise(time, .10, .6); tone(190, time, .10, .3, 85); return; }
      if (kind === 'pass') { tone(340, time, .16, .17, 210); return; }
      if (kind === 'straight' || kind === 'pairs') {
        [392, 494, 587, 698, 784].forEach((note, i) => {
          tone(note, time + i * .085, .13, .16, note, 'triangle');
          if (kind === 'pairs') tone(note * .75, time + i * .085, .1, .1);
        });
        return;
      }
      if (kind === 'plane') { noise(time, .65, .24, 1800); tone(200, time, .65, .16, 650, 'triangle'); return; }
      if (kind === 'triple' || kind === 'four') {
        for (let i = 0; i < 3; i++) noise(time + i * .07, .06, .25);
        tone(660, time + .2, .2, .18); return;
      }
      if (kind === 'shuffle' || kind === 'deal') {
        for (let i = 0; i < (kind === 'shuffle' ? 6 : 12); i++) noise(time + i * (kind === 'shuffle' ? .11 : .10), .07, .23, 3000);
        return;
      }
      if (kind === 'bomb' || kind === 'rocket') {
        if (kind === 'rocket') { noise(time, .45, .28, 5000); tone(180, time, .35, .2, 1000, 'triangle'); }
        const hit = time + (kind === 'rocket' ? .32 : 0);
        noise(hit, .48, .65, 1100); tone(140, hit, .55, .65, 38); tone(70, hit, .4, .3, 30);
        return;
      }
      const notes = {
        success: [660, 880], error: [220, 175], turn: [520, 660], warning: [880, 880, 1046],
        landlord: [392, 523, 659], win: [523, 659, 784, 1046], lose: [392, 330, 262],
      }[kind] || [];
      const step = ['win', 'lose'].includes(kind) ? .19 : .12;
      notes.forEach((note, i) => tone(note, time + i * step, kind === 'win' && i === notes.length - 1 ? .6 : .18, .26, note, 'triangle'));
    } catch { /* Device audio policy must never interrupt play. */ }
  }
  return { play, stop };
}
