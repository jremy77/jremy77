import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb } from '../server/db.js';
import { importDataset } from '../server/ingest/import.js';
import { rebuild } from '../server/ingest/index.js';
import { performanceScore, ratePlayer } from '../server/odds/rating.js';
import { simulate, toOdds } from '../server/odds/markets.js';
import { register } from '../server/auth.js';
import { placeBet, settleTournament, voidTournament } from '../server/betting.js';
import { claimDaily, dailyStatus, buyItem, seedShop, claimRescue } from '../server/economy.js';
import { upsertPartner, issueIngestKey, authorizeMediaRequest } from '../server/streams.js';
import { normalizeTournament, parsePlacement } from '../server/ingest/liquipedia.js';

const NOW = new Date('2026-10-18T12:00:00Z');
const seed = JSON.parse(fs.readFileSync(new URL('../data/seed.json', import.meta.url)));

function fresh() {
  const db = openDb(':memory:');
  seedShop(db);
  importDataset(db, seed);
  rebuild(db, NOW);
  return db;
}
const balance = (db, id) => db.prepare('SELECT balance FROM users WHERE id = ?').get(id).balance;
const ledgerSum = (db, id) => db.prepare('SELECT SUM(amount) s FROM transactions WHERE user_id = ?').get(id).s;

test('performance score: winning beats placing, bounded 0..1', () => {
  assert.equal(performanceScore(1, 50), 1);
  assert.ok(performanceScore(2, 50) < 1 && performanceScore(10, 50) > performanceScore(20, 50));
  assert.ok(performanceScore(50, 50) >= 0);
});

test('rating: recent wins rate higher than old ones', () => {
  const recent = ratePlayer([{ placement: 1, field_size: 50, tier: 'world', date: '2026-09-27' }], 0.3, NOW);
  const old = ratePlayer([{ placement: 1, field_size: 50, tier: 'world', date: '2022-09-27' }], 0.3, NOW);
  assert.ok(recent.rating > old.rating);
});

test('simulation: probabilities are consistent and favour the stronger entry', () => {
  const sim = simulate([1600, 1500, 1400, 1300], { simulations: 4000 });
  const sum = sim.win.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.ok(sim.win[0] > sim.win[1] && sim.win[1] > sim.win[3]);
  assert.ok(Math.abs(sim.ahead[0][1] + sim.ahead[1][0] - 1) < 1e-9);
  assert.ok(toOdds(0.5, 0.05) < 2 && toOdds(0.5, 0.05) >= 1.01);
});

test('outright market has a bookmaker margin (overround > 1)', () => {
  const db = fresh();
  const m = db.prepare("SELECT id FROM markets WHERE kind = 'winner' LIMIT 1").get();
  const book = db.prepare('SELECT SUM(1.0 / odds) s FROM selections WHERE market_id = ?').get(m.id).s;
  assert.ok(book > 1 && book < 1.4, `overround ${book}`);
});

test('economy: signup bonus, bet, settlement and ledger stay consistent', () => {
  const db = fresh();
  const uid = register(db, 'tester', 'password123');
  assert.equal(balance(db, uid), 1000);
  const t = db.prepare("SELECT id FROM tournaments WHERE slug = 'fncs-2026-solo-major-eu'").get();
  const win = db.prepare("SELECT s.id, s.odds, s.entry_id FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.tournament_id = ? AND m.kind = 'winner' ORDER BY s.odds LIMIT 2").all(t.id);
  placeBet(db, uid, { stake: 100, legs: [{ selectionId: win[0].id, odds: win[0].odds }] }, NOW);
  placeBet(db, uid, { stake: 100, legs: [{ selectionId: win[1].id, odds: win[1].odds }] }, NOW);
  assert.equal(balance(db, uid), 800);
  assert.throws(() => placeBet(db, uid, { stake: 5000, legs: [{ selectionId: win[0].id }] }, NOW), /insuffisant/);
  assert.throws(() => placeBet(db, uid, { stake: 100, legs: [{ selectionId: win[0].id, odds: win[0].odds * 2 }] }, NOW), /cotes/);

  db.prepare('UPDATE entries SET placement = 1 WHERE id = ?').run(win[0].entry_id);
  db.prepare('UPDATE entries SET placement = 2 WHERE id = ?').run(win[1].entry_id);
  settleTournament(db, t.id, NOW);
  const bets = db.prepare('SELECT status, payout FROM bets WHERE user_id = ? ORDER BY id').all(uid);
  assert.deepEqual(bets.map((b) => b.status), ['won', 'lost']);
  assert.equal(bets[0].payout, Math.floor(100 * win[0].odds));
  assert.equal(balance(db, uid), 800 + bets[0].payout);
  assert.equal(balance(db, uid), ledgerSum(db, uid));
});

test('combos: same-tournament legs refused, closed markets refused, void refunds', () => {
  const db = fresh();
  const uid = register(db, 'combo', 'password123');
  const sels = db.prepare("SELECT s.id, m.tournament_id t FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.kind = 'winner' GROUP BY m.id").all();
  const sameT = db.prepare("SELECT s.id FROM selections s JOIN markets m ON m.id = s.market_id WHERE m.tournament_id = ? AND m.kind IN ('winner','top3') GROUP BY m.id").all(sels[0].t);
  assert.throws(() => placeBet(db, uid, { stake: 50, legs: sameT.map((s) => ({ selectionId: s.id })) }, NOW), /tournois différents/);
  const { bet } = placeBet(db, uid, { stake: 50, legs: sels.map((s) => ({ selectionId: s.id })) }, NOW);
  assert.ok(bet.total_odds > 1);
  assert.throws(() => placeBet(db, uid, { stake: 50, legs: [{ selectionId: sels[0].id }] }, new Date('2026-12-01')), /fermé/);
  for (const s of sels) voidTournament(db, s.t, NOW);
  assert.equal(db.prepare('SELECT status FROM bets WHERE id = ?').get(bet.id).status, 'void');
  assert.equal(balance(db, uid), 1000);
});

test('daily drop: once per day, streak grows on consecutive days', () => {
  const db = fresh();
  const uid = register(db, 'daily', 'password123');
  const r1 = claimDaily(db, uid, new Date('2026-10-18T10:00:00Z'));
  assert.equal(r1.streak, 1);
  assert.throws(() => claimDaily(db, uid, new Date('2026-10-18T20:00:00Z')), /déjà/);
  const r2 = claimDaily(db, uid, new Date('2026-10-19T08:00:00Z'));
  assert.equal(r2.streak, 2);
  assert.ok(r2.reward > r1.reward);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  assert.equal(dailyStatus(user, new Date('2026-10-22T08:00:00Z')).streak, 1);
});

test('shop and rescue', () => {
  const db = fresh();
  const uid = register(db, 'shopper', 'password123');
  buyItem(db, uid, 'frame_slurp');
  assert.throws(() => buyItem(db, uid, 'frame_slurp'), /déjà/);
  assert.throws(() => buyItem(db, uid, 'frame_crown'), /insuffisant/);
  assert.throws(() => claimRescue(db, uid), /Disponible/);
  db.prepare('UPDATE users SET balance = 10 WHERE id = ?').run(uid);
  assert.equal(claimRescue(db, uid).balance, 260);
});

test('streams: live only with signed agreement, RTMP key checked by hash', () => {
  const db = fresh();
  const p = db.prepare("SELECT id, slug FROM players WHERE slug = 'bugha'").get();
  assert.throws(() => upsertPartner(db, { playerId: p.id, platform: 'rtmp', consentStatus: 'accepted' }), /Référence/);
  upsertPartner(db, { playerId: p.id, platform: 'rtmp', consentStatus: 'accepted', consentReference: 'CTR-1' });
  const key = issueIngestKey(db, p.id);
  const row = db.prepare('SELECT ingest_key_hash FROM stream_partners WHERE player_id = ?').get(p.id);
  assert.ok(!row.ingest_key_hash.includes(key));
  assert.equal(authorizeMediaRequest(db, { action: 'publish', path: `live/${p.slug}`, query: `key=${key}` }), true);
  assert.equal(authorizeMediaRequest(db, { action: 'publish', path: `live/${p.slug}`, query: 'key=wrong' }), false);
  assert.equal(authorizeMediaRequest(db, { action: 'read', path: `live/${p.slug}` }), true);
});

test('liquipedia normalisation', () => {
  assert.equal(parsePlacement('3-4'), 3);
  assert.equal(parsePlacement('DQ'), null);
  const t = normalizeTournament(
    { pagename: 'Fortnite_Champion_Series/2026/Major_3/Europe', name: 'FNCS 2026 Major 3 Europe', liquipediatier: 1, startdate: '2026-06-20', enddate: '2026-06-21', prizepool: '500000', type: 'Online' },
    [{ placement: '1', opponenttype: 'duo', opponentplayers: { p1: 'Queasy', p1flag: 'Serbia', p2: 'Merstach' }, prizemoney: '100000' }],
    NOW
  );
  assert.equal(t.status, 'completed');
  assert.equal(t.mode, 'duo');
  assert.deepEqual(t.results[0].players, ['Queasy', 'Merstach']);
});
