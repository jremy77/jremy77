// Synthesises a soft, airy ambient bed (pads + sparkling arpeggio + sub) as a WAV.
// Original music generated from scratch: no licensing question.
import fs from 'node:fs';

export function makeMusic(file, seconds, { bpm = 76, seed = 3 } = {}) {
  const sr = 44100;
  const n = Math.ceil(seconds * sr);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const midi = (m) => 440 * 2 ** ((m - 69) / 12);
  // Cmaj9 - Am9 - Fmaj7#11 - G6/9 : bright, open, "landscape" colours.
  const chords = [[48, 55, 59, 62, 64, 67], [45, 52, 55, 59, 60, 64], [41, 48, 52, 55, 59, 64], [43, 50, 55, 57, 62, 64]];
  const bar = (60 / bpm) * 4;
  const xfade = 1.2;
  let rnd = seed;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);

  // Pads: each chord rings with long attack/release so consecutive chords overlap.
  for (let c = 0; c * bar < seconds + bar; c++) {
    const chord = chords[c % chords.length];
    const start = c * bar - xfade / 2;
    const len = bar + xfade;
    for (const [k, note] of chord.entries()) {
      for (const detune of [-0.06, 0.06]) {
        const f = midi(note + 12) * (1 + detune / 100 * 12);
        const pan = 0.5 + (k / chord.length - 0.5) * 0.7 + detune * 2;
        const amp = 0.035 / (1 + k * 0.15);
        const s0 = Math.max(0, Math.floor(start * sr));
        const s1 = Math.min(n, Math.floor((start + len) * sr));
        const ph0 = rand() * Math.PI * 2;
        for (let i = s0; i < s1; i++) {
          const t = i / sr - start;
          const env = Math.min(1, t / xfade, (len - t) / xfade) ** 2;
          const v = amp * env * (Math.sin(2 * Math.PI * f * t + ph0) + 0.25 * Math.sin(4 * Math.PI * f * t + ph0));
          L[i] += v * (1 - pan);
          R[i] += v * pan;
        }
      }
    }
    // Sub bass on the root.
    const f = midi(chord[0] - 12);
    const s0 = Math.max(0, Math.floor(start * sr));
    const s1 = Math.min(n, Math.floor((start + len) * sr));
    for (let i = s0; i < s1; i++) {
      const t = i / sr - start;
      const v = 0.05 * Math.min(1, t / xfade, (len - t) / xfade) * Math.sin(2 * Math.PI * f * t);
      L[i] += v; R[i] += v;
    }
  }

  // Sparkling arpeggio (eighth notes), soft bell tone with exponential decay.
  const step = 60 / bpm / 2;
  for (let s = 0; s * step < seconds; s++) {
    const chord = chords[Math.floor((s * step) / bar) % chords.length];
    const note = chord[[2, 3, 4, 5, 4, 3, 2, 5][s % 8]] + 24;
    const f = midi(note);
    const start = Math.floor(s * step * sr);
    const len = Math.floor(1.6 * sr);
    const pan = s % 2 ? 0.3 : 0.7;
    const fadeIn = Math.min(1, (s * step) / 3);
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / sr;
      const v = 0.018 * fadeIn * Math.exp(-t * 3.2) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2.01 * t));
      L[start + i] += v * (1 - pan);
      R[start + i] += v * pan;
    }
  }

  // Master fade in/out and 16-bit WAV export.
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const g = Math.min(1, t / 1.5, (seconds - t) / 2.5);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(Math.tanh(L[i] * g * 1.4) * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(Math.tanh(R[i] * g * 1.4) * 32767))), 46 + i * 4);
  }
  fs.writeFileSync(file, buf);
}
