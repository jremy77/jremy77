// Ingestion pipeline: seed -> Liquipedia -> Esports Earnings -> Fortnite Tracker -> Twitch,
// then ratings, odds and settlement. Each source is optional: a missing API key or a
// network error is logged in ingest_runs and the pipeline continues with the others.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importDataset } from './import.js';
import { fetchLiquipedia } from './liquipedia.js';
import { fetchEsportsEarnings, fetchFortniteTracker, fetchTwitchProfiles, fetchTwitchLive } from './others.js';
import { recomputeRatings } from '../odds/rating.js';
import { buildAllMarkets } from '../odds/markets.js';
import { settleTournament } from '../betting.js';
import { seedShop } from '../economy.js';

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/seed.json');

function log(db, source, status, detail) {
  db.prepare('INSERT INTO ingest_runs (source, status, detail) VALUES (?, ?, ?)').run(source, status, String(detail).slice(0, 500));
  console.log(`[ingest] ${source}: ${status} ${detail}`);
}

async function step(db, source, fn) {
  try {
    const data = await fn();
    if (data) {
      const r = importDataset(db, data);
      log(db, source, 'ok', `${r.players} joueurs, ${r.tournaments} tournois`);
    }
  } catch (err) {
    log(db, source, 'skipped', err.message);
  }
}

// Marks finished tournaments as completed and settles their markets once results exist.
export function refreshStatuses(db, now = new Date()) {
  db.prepare("UPDATE markets SET status = 'suspended' WHERE status = 'open' AND closes_at <= ?").run(now.toISOString());
  const done = db
    .prepare(`SELECT t.id FROM tournaments t WHERE EXISTS (SELECT 1 FROM entries e WHERE e.tournament_id = t.id AND e.placement IS NOT NULL)
              AND EXISTS (SELECT 1 FROM markets m WHERE m.tournament_id = t.id AND m.status IN ('open', 'suspended'))`)
    .all();
  for (const { id } of done) {
    db.prepare("UPDATE tournaments SET status = 'completed' WHERE id = ?").run(id);
    settleTournament(db, id, now);
  }
}

export function rebuild(db, now = new Date()) {
  recomputeRatings(db, now);
  refreshStatuses(db, now);
  return buildAllMarkets(db);
}

export async function runIngest(db, { sources = ['seed', 'liquipedia', 'esportsearnings', 'fortnitetracker', 'twitch'] } = {}) {
  seedShop(db);
  if (sources.includes('seed')) await step(db, 'seed', () => JSON.parse(fs.readFileSync(SEED, 'utf8')));
  if (sources.includes('liquipedia')) await step(db, 'liquipedia', () => fetchLiquipedia());
  if (sources.includes('esportsearnings'))
    await step(db, 'esportsearnings', async () => {
      // Only enrich players we already track (no need for 200 inactive profiles).
      const known = new Set(db.prepare('SELECT lower(handle) h FROM players').all().map((r) => r.h));
      const data = await fetchEsportsEarnings();
      return { players: data.players.filter((p) => known.has(p.handle.toLowerCase())) };
    });
  if (sources.includes('fortnitetracker'))
    await step(db, 'fortnitetracker', () =>
      fetchFortniteTracker(db.prepare('SELECT handle FROM players ORDER BY rating DESC LIMIT 150').all().map((r) => r.handle))
    );
  if (sources.includes('twitch')) {
    await step(db, 'twitch-avatars', () =>
      fetchTwitchProfiles(db.prepare('SELECT handle, twitch AS login FROM players WHERE twitch IS NOT NULL').all())
    );
    try {
      const partners = db.prepare("SELECT id, channel FROM stream_partners WHERE platform = 'twitch' AND consent_status = 'accepted'").all();
      if (partners.length) {
        const live = await fetchTwitchLive(partners.map((p) => p.channel));
        const st = db.prepare('UPDATE stream_partners SET is_live = ? WHERE id = ?');
        for (const p of partners) st.run(live.has(p.channel.toLowerCase()) ? 1 : 0, p.id);
      }
    } catch (err) {
      log(db, 'twitch-live', 'skipped', err.message);
    }
  }
  const markets = rebuild(db);
  log(db, 'markets', 'ok', `${markets} marchés à jour`);
}
