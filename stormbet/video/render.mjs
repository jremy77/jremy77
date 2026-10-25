// Renders the promo (60 s) and teaser (15 s) videos frame by frame.
//   node video/render.mjs promo|teaser
// Needs: build/shots (capture.mjs), build/voice (voice.mjs), ffmpeg, Playwright Chromium.
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeMusic } from './music.mjs';

const which = process.argv[2] || 'promo';
const HERE = new URL('.', import.meta.url).pathname;
const ROOT = path.join(HERE, '..');
const BUILD = path.join(HERE, 'build');
const OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const FPS = 30;
const W = 1920, H = 1080;

const script = JSON.parse(fs.readFileSync(path.join(HERE, 'script.json'), 'utf8'))[which];
const voice = JSON.parse(fs.readFileSync(path.join(BUILD, 'voice', `${which}.json`), 'utf8'));

// ---------------------------------------------------------------- timeline
const LEGAL = 'FLUX : monnaie virtuelle sans valeur réelle · 18+ · Site indépendant, non affilié à Epic Games';
const TOTAL = which === 'promo' ? 60 : 15;
const lead = which === 'promo' ? 1.2 : 0.9;      // music before the first word
const tail = which === 'promo' ? 3.2 : 3.0;      // logo held after the last word
const speech = voice.reduce((s, v) => s + v.duration, 0);
const gap = (TOTAL - lead - tail - speech) / (voice.length - 1);

let t = 0;
const scenes = [];
const subs = [];
script.forEach((line, i) => {
  const v = voice[i];
  const voiceStart = i === 0 ? lead : t + gap * 0.45;
  const start = t;
  const end = i === script.length - 1 ? TOTAL : voiceStart + v.duration + gap * 0.55;
  subs.push({ start: voiceStart, end: voiceStart + v.duration + 0.2, text: line.text, file: v.file });
  const first = i === 0, last = i === script.length - 1;
  const base = { id: line.id, start, end, caption: line.caption, shot: line.shot, focus: line.focus, last };
  if (line.shot) scenes.push({ ...base, kind: line.live ? 'live' : 'shot', host: 'small' });
  else if (first && which === 'promo')
    scenes.push({ ...base, kind: 'intro', host: 'big', hostIn: 0.6, logoX: '64%', logoDelay: 0.5, flash: 0.5, tagline: 'Saute du bus. <em>Parie sur les pros.</em>' });
  else if (first) scenes.push({ ...base, kind: 'sky', host: 'none' });
  else
    scenes.push({ ...base, kind: 'outro', host: 'big', logoX: '64%', logoDelay: 0.3, flash: 0.3,
      tagline: which === 'promo' ? 'Le frisson de la compétition.' : '<em>Bientôt.</em>',
      cta: 'Inscription gratuite · 1 000 FLUX offerts', legal: LEGAL });
  t = end;
});
console.log(`${which}: ${TOTAL}s, ${scenes.length} scènes, gap ${gap.toFixed(2)}s`);

// ---------------------------------------------------------------- audio
const A = path.join(BUILD, `${which}-audio`);
fs.mkdirSync(A, { recursive: true });
const voiceTrack = path.join(A, 'voice.wav');
execFileSync('ffmpeg', [
  '-y', '-v', 'error',
  ...subs.flatMap((s) => ['-i', s.file]),
  '-filter_complex',
  subs.map((s, i) => `[${i}]adelay=${Math.round(s.start * 1000)}|${Math.round(s.start * 1000)},apad=whole_dur=${TOTAL}[v${i}]`).join(';') +
    `;${subs.map((_, i) => `[v${i}]`).join('')}amix=inputs=${subs.length}:normalize=0,atrim=0:${TOTAL}[out]`,
  '-map', '[out]', '-ar', '44100', '-ac', '1', voiceTrack,
]);
const musicFile = path.join(A, 'music.wav');
makeMusic(musicFile, TOTAL, { bpm: which === 'promo' ? 76 : 84 });
const mixFile = path.join(A, 'mix.wav');
execFileSync('ffmpeg', [
  '-y', '-v', 'error', '-i', voiceTrack, '-i', musicFile, '-filter_complex',
  '[0]aformat=channel_layouts=stereo,asplit[vo][sc];[1]volume=0.55[mu];[mu][sc]sidechaincompress=threshold=0.03:ratio=6:attack=40:release=600[duck];' +
    '[duck][vo]amix=inputs=2:normalize=0,alimiter=limit=0.9,loudnorm=I=-15:TP=-1.5:LRA=9[out]',
  '-map', '[out]', '-ar', '48000', mixFile,
]);

// Mouth animation: RMS of the voice per video frame, normalised to 0..1.
const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', voiceTrack, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 64 * 1024 * 1024 });
const per = Math.floor(16000 / FPS);
const amp = [];
for (let f = 0; f < TOTAL * FPS; f++) {
  let sum = 0;
  for (let i = 0; i < per; i++) { const o = (Math.floor((f * 16000) / FPS) + i) * 2; if (o + 1 < pcm.length) { const v = pcm.readInt16LE(o) / 32768; sum += v * v; } }
  amp.push(Math.sqrt(sum / per));
}
const peak = [...amp].sort((a, b) => a - b)[Math.floor(amp.length * 0.97)] || 1;
const smooth = amp.map((a, i) => Math.min(1, ((amp[i - 1] ?? a) * 0.25 + a * 0.5 + (amp[i + 1] ?? a) * 0.25) / peak));

// ---------------------------------------------------------------- static server
const MIME = { '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file;
  if (url === '/') file = path.join(HERE, 'stage.html');
  else if (url.startsWith('/fonts/')) { const [, , fam, name] = url.split('/'); file = path.join(ROOT, 'node_modules/@fontsource', fam, 'files', name); }
  else if (url.startsWith('/img/')) file = path.join(ROOT, 'public', url);
  else if (url.startsWith('/shots/')) file = path.join(BUILD, url);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(0);
const port = server.address().port;

// ---------------------------------------------------------------- frames -> ffmpeg
const outFile = path.join(OUT, which === 'promo' ? 'stormbet-pub-60s.mp4' : 'stormbet-teaser-15s.mp4');
const ff = spawn('ffmpeg', [
  '-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', mixFile,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outFile,
], { stdio: ['pipe', 'inherit', 'inherit'] });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(`http://127.0.0.1:${port}/`);
await page.evaluate((tl) => { window.TIMELINE = tl; }, { fps: FPS, scenes, subs: subs.map(({ file, ...s }) => s), amp: smooth });
await page.evaluate(() => window.ready);
// Preload every screenshot so frames never show a half-decoded image.
await page.evaluate(async (shots) => { await Promise.all(shots.map((s) => { const i = new Image(); i.src = `/shots/${s}.png`; return i.decode(); })); }, [...new Set(scenes.map((s) => s.shot).filter(Boolean))]);

if (process.env.PREVIEW) {
  const dir = path.join(BUILD, 'preview');
  fs.mkdirSync(dir, { recursive: true });
  for (const tt of process.env.PREVIEW.split(',').map(Number)) {
    await page.evaluate((x) => window.render(x), tt);
    await page.screenshot({ path: path.join(dir, `${which}-${tt}.png`) });
  }
  await browser.close(); server.close(); ff.kill();
  console.log('preview in', dir);
  process.exit(0);
}
const frames = TOTAL * FPS;
for (let f = 0; f < frames; f++) {
  await page.evaluate((tt) => window.render(tt), f / FPS);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (f % (FPS * 5) === 0) process.stdout.write(`\r${which} ${Math.round((f / frames) * 100)}%`);
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
await browser.close();
server.close();
console.log(`\n${outFile}`);
