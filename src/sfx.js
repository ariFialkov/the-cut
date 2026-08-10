// Tiny WebAudio synth — no assets, works offline, safe to fail silently.

let ctx = null;

function ac() {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function env(gain, t0, a, d, peak = 1) {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(peak, t0 + a);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}

function tone(freq, dur, type = 'sine', vol = 0.3, slide = 0) {
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, c.currentTime);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + dur);
  env(g, c.currentTime, 0.005, dur, vol);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + dur + 0.05);
}

function noiseBurst(dur, vol = 0.3, low = 400, high = 4000) {
  const c = ac();
  if (!c) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(high, c.currentTime);
  bp.frequency.exponentialRampToValueAtTime(low, c.currentTime + dur);
  bp.Q.value = 0.8;
  const g = c.createGain();
  env(g, c.currentTime, 0.003, dur, vol);
  src.connect(bp).connect(g).connect(c.destination);
  src.start();
}

export const sfx = {
  unlock() {
    ac();
  },
  click() {
    tone(660, 0.05, 'square', 0.08);
  },
  chipIn() {
    tone(520, 0.07, 'triangle', 0.15);
    setTimeout(() => tone(780, 0.09, 'triangle', 0.15), 60);
  },
  strike(quality = 1) {
    // club contact: sharp tick + whoosh scaled by quality
    noiseBurst(0.12 + 0.1 * quality, 0.35, 300, 5000);
    tone(180 + 140 * quality, 0.06, 'square', 0.22);
  },
  whoosh() {
    noiseBurst(0.25, 0.12, 200, 1200);
  },
  bounce() {
    tone(220, 0.05, 'sine', 0.12, -80);
  },
  splash() {
    noiseBurst(0.5, 0.4, 150, 900);
  },
  onGreen() {
    tone(880, 0.12, 'sine', 0.14);
  },
  cheer() {
    // crowd-ish noise swell
    const c = ac();
    if (!c) return;
    noiseBurst(0.9, 0.25, 500, 2500);
    setTimeout(() => noiseBurst(0.7, 0.18, 600, 2200), 200);
    tone(523, 0.3, 'triangle', 0.1);
    setTimeout(() => tone(659, 0.3, 'triangle', 0.1), 140);
    setTimeout(() => tone(784, 0.45, 'triangle', 0.12), 280);
  },
  groan() {
    tone(300, 0.4, 'sawtooth', 0.08, -120);
  },
  cut() {
    tone(140, 0.5, 'sawtooth', 0.2, -60);
    noiseBurst(0.3, 0.2, 100, 700);
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.35, 'triangle', 0.16), i * 130));
  },
  cash() {
    [880, 1174, 1568].forEach((f, i) => setTimeout(() => tone(f, 0.12, 'square', 0.1), i * 70));
  },
};
