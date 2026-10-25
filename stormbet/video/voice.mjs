// Generates the French voice-over (Piper neural TTS, local) for each line of script.json
// and writes build/voice/<video>.json with the duration of every line.
// PIPER_BIN: path to the piper executable, PIPER_VOICES: folder with fr-siwis-medium.onnx.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const script = JSON.parse(fs.readFileSync(`${here}script.json`, 'utf8'));
const PIPER = process.env.PIPER_BIN || 'piper';
const VOICES = process.env.PIPER_VOICES || '.';
const out = `${here}build/voice/`;
fs.mkdirSync(out, { recursive: true });

// "Honeyed" treatment: slightly lower pitch, warm low-mids, softened highs, gentle
// compression and a short airy reverb.
const WARM = [
  'asetrate=22050*0.95', 'aresample=44100', 'atempo=1/0.95',
  'equalizer=f=180:t=q:w=1.2:g=3', 'equalizer=f=3200:t=q:w=1.5:g=-2', 'highshelf=f=7500:g=-4',
  'acompressor=threshold=-20dB:ratio=3:attack=15:release=200', 'aecho=0.8:0.6:45|85:0.16|0.1',
  'loudnorm=I=-18:TP=-2:LRA=7',
].join(',');

const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());

for (const video of ['promo', 'teaser']) {
  const lines = [];
  for (const line of script[video]) {
    const rawWav = `${out}${video}-${line.id}.raw.wav`;
    const wav = `${out}${video}-${line.id}.wav`;
    execFileSync(PIPER, [
      '-m', `${VOICES}/${script.voice.model}.onnx`, '-f', rawWav,
      '--length_scale', String(script.voice.length_scale), '--noise_scale', String(script.voice.noise_scale), '--noise_w', String(script.voice.noise_w),
    ], { input: line.text, stdio: ['pipe', 'ignore', 'ignore'] });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', rawWav, '-af', WARM, '-ar', '44100', '-ac', '1', wav]);
    fs.rmSync(rawWav);
    lines.push({ id: line.id, file: wav, duration: +dur(wav).toFixed(3) });
  }
  fs.writeFileSync(`${out}${video}.json`, JSON.stringify(lines, null, 1));
  console.log(video, lines.map((l) => `${l.id}:${l.duration}`).join(' '), 'total', lines.reduce((s, l) => s + l.duration, 0).toFixed(1));
}
