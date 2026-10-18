// Turns entry ratings into probabilities (Monte Carlo Plackett-Luce) and odds.
import { entryRating } from './rating.js';
import { tx } from '../db.js';

export const ODDS_CONFIG = {
  beta: 110,         // rating points per unit of log-strength; lower = favourites win more
  simulations: 20000,
  margin: { winner: 0.12, top3: 0.1, top10: 0.08, h2h: 0.05 },
  minOdds: 1.01,
  maxOdds: 500,
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Plackett-Luce sampling via the Gumbel-max trick: sort log-strength + Gumbel noise.
// Returns per-entry probabilities of winning, top 3, top 10 and the pairwise
// "finishes ahead" matrix needed for head-to-head markets.
export function simulate(ratings, { simulations = ODDS_CONFIG.simulations, beta = ODDS_CONFIG.beta, seed = 1 } = {}) {
  const n = ratings.length;
  const rand = mulberry32(seed);
  const logStrength = ratings.map((r) => r / beta);
  const win = new Float64Array(n);
  const top3 = new Float64Array(n);
  const top10 = new Float64Array(n);
  const ahead = Array.from({ length: n }, () => new Float64Array(n));
  const keys = new Float64Array(n);
  const order = Array.from({ length: n }, (_, i) => i);
  const rank = new Int32Array(n);

  for (let s = 0; s < simulations; s++) {
    for (let i = 0; i < n; i++) keys[i] = logStrength[i] - Math.log(-Math.log(rand() || 1e-12));
    order.sort((a, b) => keys[b] - keys[a]);
    for (let k = 0; k < n; k++) rank[order[k]] = k;
    win[order[0]]++;
    for (let k = 0; k < Math.min(3, n); k++) top3[order[k]]++;
    for (let k = 0; k < Math.min(10, n); k++) top10[order[k]]++;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      if (rank[i] < rank[j]) ahead[i][j]++; else ahead[j][i]++;
    }
  }
  const norm = (arr) => Array.from(arr, (v) => v / simulations);
  return {
    win: norm(win),
    top3: norm(top3),
    top10: norm(top10),
    ahead: ahead.map((row) => norm(row)),
  };
}

export function toOdds(probability, margin) {
  const p = Math.max(probability, 1e-6) * (1 + margin);
  const raw = Math.min(ODDS_CONFIG.maxOdds, Math.max(ODDS_CONFIG.minOdds, 1 / p));
  // Bookmaker-style ladder: finer steps for short prices.
  const step = raw < 3 ? 0.01 : raw < 10 ? 0.05 : raw < 50 ? 0.5 : 1;
  return Math.max(ODDS_CONFIG.minOdds, +(Math.floor(raw / step) * step).toFixed(2));
}

// (Re)builds the markets of one upcoming tournament. Existing selection ids are kept
// so placed bets keep pointing at them; only probabilities/odds are refreshed.
export function buildMarkets(db, tournamentId) {
  const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(tournamentId);
  if (!t || t.status !== 'upcoming') return 0;
  const entries = db.prepare('SELECT id, name FROM entries WHERE tournament_id = ? ORDER BY id').all(tournamentId);
  if (entries.length < 2) return 0;

  const ratings = entries.map((e) => entryRating(db, e.id));
  const sim = simulate(ratings, { seed: tournamentId * 7919 + entries.length });
  const m = ODDS_CONFIG.margin;

  const upsertMarket = db.prepare(`
    INSERT INTO markets (tournament_id, kind, label, closes_at, margin) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (tournament_id, kind, label) DO UPDATE SET closes_at = excluded.closes_at, margin = excluded.margin
    RETURNING id, status`);
  const upsertSel = db.prepare(`
    INSERT INTO selections (market_id, entry_id, probability, odds) VALUES (?, ?, ?, ?)
    ON CONFLICT (market_id, entry_id) DO UPDATE SET probability = excluded.probability, odds = excluded.odds`);

  let count = 0;
  tx(db, () => {
    const market = (kind, label, margin) => {
      const row = upsertMarket.get(t.id, kind, label, t.start_at, margin);
      return row.status === 'open' ? row.id : null;
    };

    const outright = [['winner', `Vainqueur du tournoi`, sim.win, m.winner]];
    if (entries.length >= 10) outright.push(['top3', `Podium (Top 3)`, sim.top3, m.top3]);
    if (entries.length >= 25) outright.push(['top10', `Top 10`, sim.top10, m.top10]);
    for (const [kind, label, probs, margin] of outright) {
      const id = market(kind, label, margin);
      if (!id) continue;
      entries.forEach((e, i) => upsertSel.run(id, e.id, probs[i], toOdds(probs[i], margin)));
      count++;
    }

    // Head-to-heads between neighbours in the rating table (1v2, 3v4, ...), top 16 only.
    const ranked = entries.map((e, i) => ({ ...e, i, r: ratings[i] })).sort((a, b) => b.r - a.r).slice(0, 16);
    for (let k = 0; k + 1 < ranked.length; k += 2) {
      const a = ranked[k];
      const b = ranked[k + 1];
      const id = market('h2h', `Duel : ${a.name} vs ${b.name}`, m.h2h);
      if (!id) continue;
      const pa = sim.ahead[a.i][b.i];
      upsertSel.run(id, a.id, pa, toOdds(pa, m.h2h));
      upsertSel.run(id, b.id, 1 - pa, toOdds(1 - pa, m.h2h));
      count++;
    }
  });
  return count;
}

export function buildAllMarkets(db) {
  const ids = db.prepare("SELECT id FROM tournaments WHERE status = 'upcoming'").all();
  return ids.reduce((n, { id }) => n + buildMarkets(db, id), 0);
}
