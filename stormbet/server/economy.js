// FLUX economy: a play-money currency with no cash value.
// It can only be earned (sign-up, daily supply drop, missions, levels, winning bets)
// and spent (bets, cosmetic shop). It can never be bought nor withdrawn.
import { tx } from './db.js';

export const ECONOMY = {
  currency: 'FLUX',
  signupBonus: 1000,
  dailyBase: 100,
  dailyStreakStep: 25,
  dailyStreakCap: 7,
  rescueAmount: 250,          // "Second souffle": refill when broke, once per 24h
  rescueThreshold: 50,
  xpPerFlux: 0.1,             // XP earned per FLUX staked
  xpPerLevel: 1000,
  levelUpReward: 75,
  minStake: 10,
  maxStake: 50000,
  maxPayout: 1000000,
};

export class EconomyError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Credits (amount > 0) or debits (amount < 0) a user's wallet and writes the ledger
// row. Must run inside a transaction when combined with other writes.
export function move(db, userId, amount, kind, ref = null) {
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(userId);
  if (!user) throw new EconomyError('no_user', 'Utilisateur introuvable');
  const after = user.balance + amount;
  if (after < 0) throw new EconomyError('insufficient_funds', 'Solde FLUX insuffisant');
  db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(after, userId);
  db.prepare('INSERT INTO transactions (user_id, amount, kind, ref, balance_after) VALUES (?, ?, ?, ?, ?)').run(
    userId, amount, kind, ref, after
  );
  return after;
}

export function levelFromXp(xp) {
  return 1 + Math.floor(xp / ECONOMY.xpPerLevel);
}

export function addXp(db, userId, xp) {
  const u = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  const before = levelFromXp(u.xp);
  const after = levelFromXp(u.xp + xp);
  db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?').run(xp, userId);
  for (let lvl = before + 1; lvl <= after; lvl++) move(db, userId, ECONOMY.levelUpReward, 'level_up', `level:${lvl}`);
  return after - before;
}

const DAY = 86400000;
const dayKey = (d) => d.toISOString().slice(0, 10);

export function dailyStatus(user, now = new Date()) {
  const last = user.last_daily_at ? new Date(user.last_daily_at) : null;
  const claimedToday = last && dayKey(last) === dayKey(now);
  const continues = last && dayKey(new Date(now - DAY)) === dayKey(last);
  const streak = claimedToday ? user.daily_streak : continues ? user.daily_streak + 1 : 1;
  const reward = ECONOMY.dailyBase + ECONOMY.dailyStreakStep * (Math.min(streak, ECONOMY.dailyStreakCap) - 1);
  return { available: !claimedToday, streak, reward };
}

export function claimDaily(db, userId, now = new Date()) {
  return tx(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const st = dailyStatus(user, now);
    if (!st.available) throw new EconomyError('already_claimed', 'Ravitaillement déjà récupéré aujourd’hui');
    db.prepare('UPDATE users SET daily_streak = ?, last_daily_at = ? WHERE id = ?').run(st.streak, now.toISOString(), userId);
    const balance = move(db, userId, st.reward, 'daily_drop', `day:${dayKey(now)}`);
    return { ...st, balance };
  });
}

export function claimRescue(db, userId, now = new Date()) {
  return tx(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const open = db.prepare("SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND status = 'open'").get(userId).n;
    if (user.balance >= ECONOMY.rescueThreshold || open > 0)
      throw new EconomyError('not_eligible', `Disponible seulement sous ${ECONOMY.rescueThreshold} FLUX et sans pari en cours`);
    if (user.last_rescue_at && now - new Date(user.last_rescue_at) < DAY)
      throw new EconomyError('cooldown', 'Second souffle déjà utilisé ces dernières 24h');
    db.prepare('UPDATE users SET last_rescue_at = ? WHERE id = ?').run(now.toISOString(), userId);
    return { balance: move(db, userId, ECONOMY.rescueAmount, 'rescue') };
  });
}

// ---- Missions ---------------------------------------------------------------
export const MISSIONS = [
  { id: 'daily_3_bets', period: 'day', title: 'Placer 3 paris', goal: 3, reward: 150,
    sql: "SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND created_at >= ?" },
  { id: 'daily_win', period: 'day', title: 'Gagner un pari', goal: 1, reward: 200,
    sql: "SELECT COUNT(*) AS n FROM bets WHERE user_id = ? AND status = 'won' AND settled_at >= ?" },
  { id: 'weekly_h2h', period: 'week', title: 'Jouer 5 duels (H2H)', goal: 5, reward: 500,
    sql: `SELECT COUNT(DISTINCT b.id) AS n FROM bets b JOIN bet_legs l ON l.bet_id = b.id
          JOIN selections s ON s.id = l.selection_id JOIN markets m ON m.id = s.market_id
          WHERE b.user_id = ? AND m.kind = 'h2h' AND b.created_at >= ?` },
  { id: 'weekly_combo', period: 'week', title: 'Placer un combiné de 3 sélections', goal: 1, reward: 400,
    sql: `SELECT COUNT(*) AS n FROM bets b WHERE b.user_id = ? AND b.created_at >= ?
          AND (SELECT COUNT(*) FROM bet_legs l WHERE l.bet_id = b.id) >= 3` },
];

function periodStart(period, now) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}
const sqliteTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

export function missionStatus(db, userId, now = new Date()) {
  return MISSIONS.map((m) => {
    const start = periodStart(m.period, now);
    const progress = db.prepare(m.sql).get(userId, sqliteTime(start)).n;
    const claimed = !!db
      .prepare('SELECT 1 FROM mission_claims WHERE user_id = ? AND mission_id = ? AND period = ?')
      .get(userId, m.id, dayKey(start));
    return { id: m.id, title: m.title, period: m.period, goal: m.goal, reward: m.reward, progress: Math.min(progress, m.goal), claimed };
  });
}

export function claimMission(db, userId, missionId, now = new Date()) {
  return tx(db, () => {
    const st = missionStatus(db, userId, now).find((m) => m.id === missionId);
    if (!st) throw new EconomyError('unknown_mission', 'Mission inconnue');
    if (st.claimed) throw new EconomyError('already_claimed', 'Récompense déjà récupérée');
    if (st.progress < st.goal) throw new EconomyError('not_done', 'Mission pas encore terminée');
    const m = MISSIONS.find((x) => x.id === missionId);
    db.prepare('INSERT INTO mission_claims (user_id, mission_id, period) VALUES (?, ?, ?)').run(
      userId, missionId, dayKey(periodStart(m.period, now))
    );
    return { balance: move(db, userId, st.reward, 'mission', missionId) };
  });
}

// ---- Cosmetic shop ------------------------------------------------------------
export const SHOP_ITEMS = [
  { id: 'frame_bus', name: 'Cadre Bus Volant', kind: 'frame', rarity: 'common', price: 300, data: { color: '#b4bcc7' } },
  { id: 'frame_slurp', name: 'Cadre Slurp Néon', kind: 'frame', rarity: 'uncommon', price: 800, data: { color: '#5dd65d' } },
  { id: 'frame_storm', name: 'Cadre Œil du Cyclone', kind: 'frame', rarity: 'rare', price: 2000, data: { color: '#3fa9ff' } },
  { id: 'frame_rift', name: 'Cadre Faille Temporelle', kind: 'frame', rarity: 'epic', price: 5000, data: { color: '#b45cff' } },
  { id: 'frame_crown', name: 'Cadre Couronne Royale', kind: 'frame', rarity: 'legendary', price: 12000, data: { color: '#ffb52e' } },
  { id: 'banner_tilted', name: 'Bannière Ville Penchée', kind: 'banner', rarity: 'uncommon', price: 600, data: { gradient: 'linear-gradient(135deg,#3a7bd5,#00d2ff)' } },
  { id: 'banner_storm', name: 'Bannière Tempête Violette', kind: 'banner', rarity: 'rare', price: 1500, data: { gradient: 'linear-gradient(135deg,#4b1d8f,#c03bff)' } },
  { id: 'banner_cube', name: 'Bannière Cube Kevin', kind: 'banner', rarity: 'epic', price: 4000, data: { gradient: 'linear-gradient(135deg,#1a0033,#9b00ff,#ff00e6)' } },
  { id: 'banner_gold', name: 'Bannière Victoire Royale', kind: 'banner', rarity: 'legendary', price: 9000, data: { gradient: 'linear-gradient(135deg,#ff8a00,#ffd700,#fff3a0)' } },
  { id: 'title_rookie', name: 'Titre « Sauteur de Bus »', kind: 'title', rarity: 'common', price: 200, data: { text: 'Sauteur de Bus' } },
  { id: 'title_sniper', name: 'Titre « Sniper de Cotes »', kind: 'title', rarity: 'rare', price: 1800, data: { text: 'Sniper de Cotes' } },
  { id: 'title_oracle', name: 'Titre « Oracle de la Tempête »', kind: 'title', rarity: 'legendary', price: 10000, data: { text: 'Oracle de la Tempête' } },
];

export function seedShop(db) {
  const st = db.prepare(`INSERT INTO shop_items (id, name, kind, rarity, price, data) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, kind = excluded.kind, rarity = excluded.rarity, price = excluded.price, data = excluded.data`);
  for (const i of SHOP_ITEMS) st.run(i.id, i.name, i.kind, i.rarity, i.price, JSON.stringify(i.data));
}

export function buyItem(db, userId, itemId) {
  return tx(db, () => {
    const item = db.prepare('SELECT * FROM shop_items WHERE id = ?').get(itemId);
    if (!item) throw new EconomyError('unknown_item', 'Objet introuvable');
    if (db.prepare('SELECT 1 FROM inventory WHERE user_id = ? AND item_id = ?').get(userId, itemId))
      throw new EconomyError('owned', 'Objet déjà possédé');
    const balance = move(db, userId, -item.price, 'shop', itemId);
    db.prepare('INSERT INTO inventory (user_id, item_id) VALUES (?, ?)').run(userId, itemId);
    return { balance };
  });
}

export function equipItem(db, userId, itemId) {
  const item = db
    .prepare('SELECT s.* FROM inventory i JOIN shop_items s ON s.id = i.item_id WHERE i.user_id = ? AND i.item_id = ?')
    .get(userId, itemId);
  if (!item) throw new EconomyError('not_owned', 'Objet non possédé');
  const user = db.prepare('SELECT equipped FROM users WHERE id = ?').get(userId);
  const equipped = { ...JSON.parse(user.equipped), [item.kind]: item.id };
  db.prepare('UPDATE users SET equipped = ? WHERE id = ?').run(JSON.stringify(equipped), userId);
  return equipped;
}
