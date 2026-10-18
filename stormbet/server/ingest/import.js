// Merges a normalized dataset (same shape as data/seed.json) into the database.
// Every adapter (seed, Liquipedia, Fortnite Tracker, Esports Earnings, Twitch)
// produces this shape, so sources can be combined and re-run safely.
import { slugify, tx, json } from '../db.js';

function findPlayer(db, handle) {
  const slug = slugify(handle);
  const direct = db.prepare('SELECT * FROM players WHERE slug = ?').get(slug);
  if (direct) return direct;
  return db
    .prepare("SELECT p.* FROM players p, json_each(p.aliases) a WHERE lower(a.value) = lower(?)")
    .get(handle);
}

function upsertTeam(db, name) {
  if (!name) return null;
  const slug = slugify(name);
  db.prepare('INSERT INTO teams (slug, name) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING').run(slug, name);
  return db.prepare('SELECT id FROM teams WHERE slug = ?').get(slug).id;
}

const mergeList = (a, b) => JSON.stringify([...new Set([...json.parse(a, []), ...(b || [])])]);

// Non-null incoming values win; missing ones keep what we already know.
export function upsertPlayer(db, p) {
  const teamId = p.team !== undefined ? upsertTeam(db, p.team) : undefined;
  const existing = findPlayer(db, p.handle);
  if (!existing) {
    return db
      .prepare(`INSERT INTO players (slug, handle, aliases, country, region, team_id, avatar_url, avatar_credit, twitch, earnings_usd, pr_points, sources)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
      .get(
        slugify(p.handle), p.handle, JSON.stringify(p.aliases || []), p.country ?? null, p.region ?? null, teamId ?? null,
        p.avatar_url ?? null, p.avatar_credit ?? null, p.twitch ?? null, p.earnings_usd ?? null, p.pr_points ?? null,
        JSON.stringify(p.sources || [])
      ).id;
  }
  db.prepare(`UPDATE players SET
      aliases = ?, country = COALESCE(?, country), region = COALESCE(?, region), team_id = COALESCE(?, team_id),
      avatar_url = COALESCE(?, avatar_url), avatar_credit = COALESCE(?, avatar_credit), twitch = COALESCE(?, twitch),
      earnings_usd = COALESCE(?, earnings_usd), pr_points = COALESCE(?, pr_points), sources = ?
    WHERE id = ?`).run(
    mergeList(existing.aliases, p.aliases), p.country ?? null, p.region ?? null, teamId ?? null,
    p.avatar_url ?? null, p.avatar_credit ?? null, p.twitch ?? null, p.earnings_usd ?? null, p.pr_points ?? null,
    mergeList(existing.sources, p.sources), existing.id
  );
  return existing.id;
}

function upsertEntry(db, tournamentId, players, extra = {}) {
  const ids = players.map((h) => findPlayer(db, h)?.id ?? upsertPlayer(db, { handle: h }));
  const name = players.join(' & ');
  db.prepare(`INSERT INTO entries (tournament_id, name, placement, points, prize_usd) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT (tournament_id, name) DO UPDATE SET
                placement = COALESCE(excluded.placement, placement), points = COALESCE(excluded.points, points),
                prize_usd = COALESCE(excluded.prize_usd, prize_usd)`).run(
    tournamentId, name, extra.placement ?? null, extra.points ?? null, extra.prize_usd ?? null
  );
  const entryId = db.prepare('SELECT id FROM entries WHERE tournament_id = ? AND name = ?').get(tournamentId, name).id;
  const link = db.prepare('INSERT OR IGNORE INTO entry_players (entry_id, player_id) VALUES (?, ?)');
  for (const id of ids) link.run(entryId, id);
  return entryId;
}

export function upsertTournament(db, t) {
  db.prepare(`INSERT INTO tournaments (slug, name, series, tier, mode, region, location, start_at, end_at, prize_pool_usd,
                field_size, status, field_status, source_url, notes, sources)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (slug) DO UPDATE SET name = excluded.name, series = excluded.series, tier = excluded.tier,
                mode = excluded.mode, region = excluded.region, location = COALESCE(excluded.location, location),
                start_at = excluded.start_at, end_at = COALESCE(excluded.end_at, end_at),
                prize_pool_usd = COALESCE(excluded.prize_pool_usd, prize_pool_usd), field_size = COALESCE(excluded.field_size, field_size),
                status = CASE WHEN status = 'completed' THEN status ELSE excluded.status END,
                field_status = excluded.field_status, source_url = COALESCE(excluded.source_url, source_url),
                notes = COALESCE(excluded.notes, notes), sources = excluded.sources`).run(
    t.slug, t.name, t.series ?? null, t.tier || 'major', t.mode || 'solo', t.region ?? null, t.location ?? null,
    t.start_at, t.end_at ?? null, t.prize_pool_usd ?? null, t.field_size ?? null, t.status || 'upcoming',
    t.field_status || 'confirmed', t.source_url ?? null, t.notes ?? null, JSON.stringify(t.sources || [])
  );
  const id = db.prepare('SELECT id FROM tournaments WHERE slug = ?').get(t.slug).id;
  // Once the official field is known, the projected entries are replaced.
  if (t.field_status === 'confirmed' && t.entries?.length) {
    const keep = new Set(t.entries.map((e) => e.join(' & ')));
    for (const e of db.prepare('SELECT id, name FROM entries WHERE tournament_id = ?').all(id))
      if (!keep.has(e.name) && !db.prepare('SELECT 1 FROM selections s JOIN bet_legs l ON l.selection_id = s.id WHERE s.entry_id = ?').get(e.id))
        db.prepare('DELETE FROM entries WHERE id = ?').run(e.id);
  }
  for (const e of t.entries || []) upsertEntry(db, id, e);
  for (const r of t.results || []) upsertEntry(db, id, r.players, r);
  return id;
}

export function importDataset(db, data) {
  return tx(db, () => {
    for (const team of data.teams || []) upsertTeam(db, team.name);
    for (const p of data.players || []) upsertPlayer(db, p);
    for (const t of data.tournaments || []) upsertTournament(db, t);
    return {
      players: data.players?.length || 0,
      tournaments: data.tournaments?.length || 0,
    };
  });
}
