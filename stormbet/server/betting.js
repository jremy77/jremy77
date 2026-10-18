import { tx } from './db.js';
import { ECONOMY, EconomyError, move, addXp } from './economy.js';

const ODDS_TOLERANCE = 0.02; // accept the bet if odds moved less than 2% since the slip was filled

// legs: [{ selectionId, odds }] — odds are the ones the user saw, used to detect changes.
export function placeBet(db, userId, { stake, legs }, now = new Date()) {
  stake = Math.floor(Number(stake));
  if (!Number.isFinite(stake) || stake < ECONOMY.minStake || stake > ECONOMY.maxStake)
    throw new EconomyError('bad_stake', `Mise entre ${ECONOMY.minStake} et ${ECONOMY.maxStake} FLUX`);
  if (!Array.isArray(legs) || legs.length < 1 || legs.length > 10)
    throw new EconomyError('bad_legs', 'Entre 1 et 10 sélections par pari');

  return tx(db, () => {
    const seenMarkets = new Set();
    const rows = legs.map((leg) => {
      const s = db
        .prepare(`SELECT s.id, s.odds, s.market_id, m.status, m.closes_at, m.tournament_id
                  FROM selections s JOIN markets m ON m.id = s.market_id WHERE s.id = ?`)
        .get(Number(leg.selectionId));
      if (!s) throw new EconomyError('unknown_selection', 'Sélection introuvable');
      if (s.status !== 'open' || new Date(s.closes_at) <= now)
        throw new EconomyError('market_closed', 'Ce marché est fermé');
      if (seenMarkets.has(s.market_id))
        throw new EconomyError('same_market', 'Un combiné ne peut contenir qu’une sélection par marché');
      seenMarkets.add(s.market_id);
      if (leg.odds != null && Math.abs(s.odds - leg.odds) / leg.odds > ODDS_TOLERANCE)
        throw new EconomyError('odds_changed', 'Les cotes ont changé', { selectionId: s.id, odds: s.odds });
      return s;
    });
    // Correlated legs (same tournament) can't be combined, e.g. "X wins" + "X top 10".
    if (rows.length > 1 && new Set(rows.map((r) => r.tournament_id)).size !== rows.length)
      throw new EconomyError('correlated', 'Un combiné doit porter sur des tournois différents');

    const totalOdds = +rows.reduce((p, r) => p * r.odds, 1).toFixed(2);
    const potential = Math.min(ECONOMY.maxPayout, Math.floor(stake * totalOdds));
    const bet = db
      .prepare('INSERT INTO bets (user_id, stake, total_odds, potential_payout) VALUES (?, ?, ?, ?) RETURNING *')
      .get(userId, stake, totalOdds, potential);
    const legStmt = db.prepare('INSERT INTO bet_legs (bet_id, selection_id, odds) VALUES (?, ?, ?)');
    for (const r of rows) legStmt.run(bet.id, r.id, r.odds);
    const balance = move(db, userId, -stake, 'bet_stake', `bet:${bet.id}`);
    addXp(db, userId, Math.round(stake * ECONOMY.xpPerFlux));
    return { bet, balance };
  });
}

// Decides each selection of a finished tournament from the entries' placements.
// An entry without a known placement is considered to have finished below every
// known placement (results are sometimes only published for the top of the table).
export function settleTournament(db, tournamentId, now = new Date()) {
  return tx(db, () => {
    const markets = db
      .prepare("SELECT * FROM markets WHERE tournament_id = ? AND status IN ('open', 'suspended')")
      .all(tournamentId);
    const placement = new Map(
      db.prepare('SELECT id, placement FROM entries WHERE tournament_id = ?').all(tournamentId).map((e) => [e.id, e.placement])
    );
    if (![...placement.values()].some((p) => p != null)) throw new EconomyError('no_results', 'Aucun résultat connu');

    const setSel = db.prepare('UPDATE selections SET result = ? WHERE id = ?');
    for (const m of markets) {
      const sels = db.prepare('SELECT id, entry_id FROM selections WHERE market_id = ?').all(m.id);
      const k = { winner: 1, top3: 3, top10: 10 }[m.kind];
      if (k) {
        for (const s of sels) {
          const p = placement.get(s.entry_id);
          setSel.run(p != null && p <= k ? 'won' : 'lost', s.id);
        }
      } else if (m.kind === 'h2h') {
        const [a, b] = sels.map((s) => ({ ...s, p: placement.get(s.entry_id) ?? Infinity }));
        if (a.p === b.p) { setSel.run('void', a.id); setSel.run('void', b.id); }
        else { setSel.run(a.p < b.p ? 'won' : 'lost', a.id); setSel.run(b.p < a.p ? 'won' : 'lost', b.id); }
      }
      db.prepare("UPDATE markets SET status = 'settled' WHERE id = ?").run(m.id);
    }
    return settleOpenBets(db, now);
  });
}

// Settles every open bet whose legs are all decided. Void legs count as odds 1.00.
export function settleOpenBets(db, now = new Date()) {
  const open = db.prepare("SELECT * FROM bets WHERE status = 'open'").all();
  let settled = 0;
  for (const bet of open) {
    const legs = db
      .prepare('SELECT l.selection_id, l.odds, s.result FROM bet_legs l JOIN selections s ON s.id = l.selection_id WHERE l.bet_id = ?')
      .all(bet.id);
    for (const l of legs) if (l.result) db.prepare('UPDATE bet_legs SET result = ? WHERE bet_id = ? AND selection_id = ?').run(l.result, bet.id, l.selection_id);
    if (legs.some((l) => l.result === 'lost')) {
      db.prepare("UPDATE bets SET status = 'lost', payout = 0, settled_at = ? WHERE id = ?").run(sqlNow(now), bet.id);
      settled++;
      continue;
    }
    if (legs.some((l) => !l.result)) continue;
    const live = legs.filter((l) => l.result === 'won');
    if (!live.length) {
      db.prepare("UPDATE bets SET status = 'void', payout = ?, settled_at = ? WHERE id = ?").run(bet.stake, sqlNow(now), bet.id);
      move(db, bet.user_id, bet.stake, 'bet_refund', `bet:${bet.id}`);
    } else {
      const odds = live.reduce((p, l) => p * l.odds, 1);
      const payout = Math.min(ECONOMY.maxPayout, Math.floor(bet.stake * odds));
      db.prepare("UPDATE bets SET status = 'won', payout = ?, settled_at = ? WHERE id = ?").run(payout, sqlNow(now), bet.id);
      move(db, bet.user_id, payout, 'bet_payout', `bet:${bet.id}`);
    }
    settled++;
  }
  return settled;
}

// Cancels a tournament (e.g. postponed): every market is voided and stakes come back.
export function voidTournament(db, tournamentId, now = new Date()) {
  return tx(db, () => {
    db.prepare(`UPDATE selections SET result = 'void' WHERE market_id IN (SELECT id FROM markets WHERE tournament_id = ?)`).run(tournamentId);
    db.prepare("UPDATE markets SET status = 'void' WHERE tournament_id = ?").run(tournamentId);
    return settleOpenBets(db, now);
  });
}

const sqlNow = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
