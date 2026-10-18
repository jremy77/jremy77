// Player strength model ("Storm Rating").
//
// Every known result becomes a performance score between 0 and 1 based on the
// placement relative to the field size (log scale: winning a 50-duo final is 1.0,
// 10th is ~0.41). Scores are averaged with weights for the event tier and for
// recency (half-life), then shrunk towards a prior built from career earnings and
// Fortnite Tracker power-ranking points. The result is mapped to a rating around
// 1000-1800 that drives the odds simulation.

export const TIER_WEIGHT = {
  world: 1.6,      // World Cup, FNCS Global Championship
  major: 1.0,      // FNCS Major grand finals
  summit: 1.1,
  qualifier: 0.45,
  cup: 0.3,        // cash cups
};

export const MODEL = {
  halfLifeDays: 180,
  priorWeight: 1.0,
  basePrior: 0.3,
  ratingFloor: 1000,
  ratingSpan: 800,
};

export function performanceScore(placement, fieldSize) {
  const n = Math.max(fieldSize || 0, placement + 1, 2);
  return Math.max(0, 1 - Math.log(placement) / Math.log(n));
}

export function recencyWeight(eventDate, now = new Date()) {
  const days = Math.max(0, (now - new Date(eventDate)) / 86400000);
  return Math.pow(0.5, days / MODEL.halfLifeDays);
}

export function priorScore({ earnings_usd, pr_percentile }) {
  let p = MODEL.basePrior;
  if (earnings_usd > 0) p += Math.min(2, Math.max(0, Math.log10(earnings_usd / 1e5))) * 0.08;
  if (pr_percentile != null) p += pr_percentile * 0.1;
  return Math.min(p, 0.75);
}

export function ratePlayer(results, prior, now = new Date()) {
  let wSum = 0;
  let sSum = 0;
  for (const r of results) {
    const w = (TIER_WEIGHT[r.tier] ?? 0.5) * recencyWeight(r.date, now);
    wSum += w;
    sSum += w * performanceScore(r.placement, r.field_size);
  }
  const k = MODEL.priorWeight;
  const score = (sSum + k * prior) / (wSum + k);
  return {
    rating: Math.round(MODEL.ratingFloor + MODEL.ratingSpan * score),
    confidence: +(wSum / (wSum + k)).toFixed(3),
  };
}

// Recomputes every player's rating and recent form from the database.
export function recomputeRatings(db, now = new Date()) {
  const players = db.prepare('SELECT id, earnings_usd, pr_points FROM players').all();
  const prSorted = players.map((p) => p.pr_points).filter((x) => x != null).sort((a, b) => a - b);
  const percentile = (v) =>
    v == null || prSorted.length < 2 ? null : prSorted.filter((x) => x <= v).length / prSorted.length;

  const resultsStmt = db.prepare(`
    SELECT e.placement, t.tier, COALESCE(t.end_at, t.start_at) AS date, t.name,
           COALESCE(t.field_size, (SELECT COUNT(*) FROM entries e2 WHERE e2.tournament_id = t.id)) AS field_size
    FROM entry_players ep
    JOIN entries e ON e.id = ep.entry_id
    JOIN tournaments t ON t.id = e.tournament_id
    WHERE ep.player_id = ? AND e.placement IS NOT NULL AND t.status = 'completed'
    ORDER BY date DESC`);
  const update = db.prepare(
    'UPDATE players SET rating = ?, rating_confidence = ?, form = ?, updated_at = ? WHERE id = ?'
  );

  for (const p of players) {
    const results = resultsStmt.all(p.id);
    const prior = priorScore({ earnings_usd: p.earnings_usd, pr_percentile: percentile(p.pr_points) });
    const { rating, confidence } = ratePlayer(results, prior, now);
    const form = results.slice(0, 5).map((r) => ({ placement: r.placement, event: r.name, date: r.date }));
    update.run(rating, confidence, JSON.stringify(form), now.toISOString(), p.id);
  }
  return players.length;
}

// Strength of a solo/duo/trio entry: mean rating of its players, plus a small
// chemistry bonus when the same players already competed together.
export function entryRating(db, entryId) {
  const players = db
    .prepare('SELECT p.id, p.rating FROM entry_players ep JOIN players p ON p.id = ep.player_id WHERE ep.entry_id = ?')
    .all(entryId);
  if (!players.length) return MODEL.ratingFloor + MODEL.ratingSpan * MODEL.basePrior;
  const mean = players.reduce((s, p) => s + p.rating, 0) / players.length;
  if (players.length < 2) return mean;
  const ids = players.map((p) => p.id);
  const together = db
    .prepare(`
      SELECT COUNT(*) AS n FROM entries e
      WHERE e.id != ? AND e.placement IS NOT NULL AND (
        SELECT COUNT(*) FROM entry_players ep WHERE ep.entry_id = e.id AND ep.player_id IN (${ids.map(() => '?').join(',')})
      ) = ?`)
    .get(entryId, ...ids, ids.length).n;
  return mean + Math.min(together, 3) * 8;
}
