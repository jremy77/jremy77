import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json as j, tx } from './db.js';
import * as auth from './auth.js';
import * as eco from './economy.js';
import { placeBet, settleTournament, voidTournament } from './betting.js';
import { upsertPartner, issueIngestKey, authorizeMediaRequest, publicStream } from './streams.js';
import { runIngest, rebuild } from './ingest/index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp(db) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' data: https:",
        "media-src 'self' blob: https:",
        "connect-src 'self' https:",
        "frame-src https://player.twitch.tv https://www.youtube.com https://player.kick.com",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self'",
      ].join('; '),
    });
    req.user = auth.userFromToken(db, auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
    next();
  });

  // Mutating API calls must be JSON: a cross-site <form> can't send that (CSRF guard,
  // on top of the SameSite=Lax session cookie).
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && !req.path.startsWith('/media/') && !req.is('application/json'))
      return res.status(415).json({ error: 'json_required' });
    next();
  });

  const route = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof eco.EconomyError) {
        const { code, message, ...extra } = err;
        return res.status(400).json({ error: code, message, ...extra });
      }
      console.error(err);
      res.status(500).json({ error: 'server_error', message: 'Erreur serveur' });
    }
  };
  const needUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'auth_required', message: 'Connecte-toi pour continuer' }));
  const needAdmin = (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden' }));

  // ---- Config & auth -----------------------------------------------------
  app.get('/api/config', route(() => ({
    currency: eco.ECONOMY.currency,
    economy: eco.ECONOMY,
    twitchParent: process.env.PUBLIC_HOSTNAME || null,
  })));

  const attempts = new Map();
  const throttle = (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60000);
    if (list.length >= 20) return res.status(429).json({ error: 'too_many', message: 'Trop de tentatives, réessaie plus tard' });
    attempts.set(key, [...list, now]);
    next();
  };
  const startSession = (res, userId) => {
    const { token, maxAge } = auth.createSession(db, userId);
    res.cookie(auth.COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: maxAge * 1000, path: '/' });
  };
  app.post('/api/auth/register', throttle, route((req, res) => {
    if (!req.body.adult) throw new eco.EconomyError('age', 'StormBet est réservé aux 18 ans et plus');
    startSession(res, auth.register(db, req.body.username, req.body.password));
  }));
  app.post('/api/auth/login', throttle, route((req, res) => startSession(res, auth.login(db, req.body.username, req.body.password))));
  app.post('/api/auth/logout', route((req, res) => {
    auth.destroySession(db, auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
    res.clearCookie(auth.COOKIE, { path: '/' });
  }));

  const itemById = (id) => {
    const i = id && db.prepare('SELECT * FROM shop_items WHERE id = ?').get(id);
    return i ? { ...i, data: j.parse(i.data, {}) } : null;
  };
  const publicUser = (u) => {
    const equipped = j.parse(u.equipped, {});
    return {
      id: u.id, username: u.username, role: u.role, balance: u.balance, xp: u.xp,
      level: eco.levelFromXp(u.xp), levelProgress: (u.xp % eco.ECONOMY.xpPerLevel) / eco.ECONOMY.xpPerLevel,
      equipped: { frame: itemById(equipped.frame), banner: itemById(equipped.banner), title: itemById(equipped.title) },
    };
  };
  app.get('/api/me', route((req) => {
    if (!req.user) return { user: null };
    return {
      user: publicUser(req.user),
      daily: eco.dailyStatus(req.user),
      openBets: db.prepare("SELECT COUNT(*) n FROM bets WHERE user_id = ? AND status = 'open'").get(req.user.id).n,
    };
  }));

  // ---- Esports data --------------------------------------------------------
  const playerRow = (p) => ({
    id: p.id, slug: p.slug, handle: p.handle, country: p.country, region: p.region, team: p.team_name || null,
    avatarUrl: p.avatar_url, avatarCredit: p.avatar_credit, earningsUsd: p.earnings_usd, prPoints: p.pr_points,
    rating: p.rating, confidence: p.rating_confidence, form: j.parse(p.form, []), sources: j.parse(p.sources, []),
    live: !!p.is_live,
  });
  const PLAYER_SQL = `SELECT p.*, t.name AS team_name,
      (SELECT sp.is_live FROM stream_partners sp WHERE sp.player_id = p.id AND sp.consent_status = 'accepted') AS is_live
    FROM players p LEFT JOIN teams t ON t.id = p.team_id`;

  app.get('/api/players', route((req) => {
    const q = `%${String(req.query.q || '').toLowerCase()}%`;
    const rows = db.prepare(`${PLAYER_SQL} WHERE lower(p.handle) LIKE ? AND (? = '' OR p.region = ?) ORDER BY p.rating DESC`)
      .all(q, req.query.region || '', req.query.region || '');
    return rows.map((p, i) => ({ ...playerRow(p), rank: i + 1 }));
  }));

  app.get('/api/players/:slug', route((req, res) => {
    const p = db.prepare(`${PLAYER_SQL} WHERE p.slug = ?`).get(req.params.slug);
    if (!p) return res.status(404).json({ error: 'not_found' });
    const results = db.prepare(`SELECT t.slug, t.name, t.tier, t.mode, t.status, COALESCE(t.end_at, t.start_at) date, e.name entry, e.placement, e.points, e.prize_usd
        FROM entry_players ep JOIN entries e ON e.id = ep.entry_id JOIN tournaments t ON t.id = e.tournament_id
        WHERE ep.player_id = ? ORDER BY date DESC`).all(p.id);
    const rank = db.prepare('SELECT COUNT(*) + 1 n FROM players WHERE rating > ?').get(p.rating).n;
    return { ...playerRow(p), rank, results, stream: publicStream(db, p.id) };
  }));

  app.get('/api/teams', route(() => db.prepare(`
    SELECT t.slug, t.name, t.logo_url logoUrl, COUNT(p.id) players, ROUND(AVG(p.rating)) rating
    FROM teams t LEFT JOIN players p ON p.team_id = t.id GROUP BY t.id ORDER BY rating DESC`).all()));

  const tournamentRow = (t) => ({
    id: t.id, slug: t.slug, name: t.name, series: t.series, tier: t.tier, mode: t.mode, region: t.region, location: t.location,
    startAt: t.start_at, endAt: t.end_at, prizePoolUsd: t.prize_pool_usd, status: t.status, fieldStatus: t.field_status,
    notes: t.notes, sourceUrl: t.source_url, sources: j.parse(t.sources, []), entries: t.entries, markets: t.markets,
  });
  app.get('/api/tournaments', route((req) => {
    const status = req.query.status;
    return db.prepare(`SELECT t.*, (SELECT COUNT(*) FROM entries e WHERE e.tournament_id = t.id) entries,
        (SELECT COUNT(*) FROM markets m WHERE m.tournament_id = t.id AND m.status = 'open') markets
      FROM tournaments t WHERE (? IS NULL OR t.status = ?)
      ORDER BY CASE t.status WHEN 'upcoming' THEN 0 ELSE 1 END, CASE t.status WHEN 'upcoming' THEN t.start_at END ASC, t.start_at DESC`)
      .all(status ?? null, status ?? null).map(tournamentRow);
  }));

  app.get('/api/tournaments/:slug', route((req, res) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE slug = ?').get(req.params.slug);
    if (!t) return res.status(404).json({ error: 'not_found' });
    const entryPlayers = db.prepare(`SELECT p.slug, p.handle, p.avatar_url avatarUrl, p.rating, p.country,
        (SELECT sp.is_live FROM stream_partners sp WHERE sp.player_id = p.id AND sp.consent_status = 'accepted') live
      FROM entry_players ep JOIN players p ON p.id = ep.player_id WHERE ep.entry_id = ?`);
    const entries = db.prepare('SELECT * FROM entries WHERE tournament_id = ? ORDER BY placement IS NULL, placement, id').all(t.id)
      .map((e) => ({ id: e.id, name: e.name, placement: e.placement, points: e.points, prizeUsd: e.prize_usd, players: entryPlayers.all(e.id).map((p) => ({ ...p, live: !!p.live })) }));
    const markets = db.prepare("SELECT * FROM markets WHERE tournament_id = ? ORDER BY CASE kind WHEN 'winner' THEN 0 WHEN 'top3' THEN 1 WHEN 'top10' THEN 2 ELSE 3 END, id").all(t.id)
      .map((m) => ({
        id: m.id, kind: m.kind, label: m.label, status: m.status, closesAt: m.closes_at,
        selections: db.prepare('SELECT id, entry_id entryId, odds, probability, result FROM selections WHERE market_id = ? ORDER BY odds').all(m.id),
      }));
    return { ...tournamentRow(t), entries, markets };
  }));

  app.get('/api/live', route(() => db.prepare(`
    SELECT p.slug, p.handle, p.avatar_url avatarUrl, sp.platform, sp.channel, sp.is_live isLive
    FROM stream_partners sp JOIN players p ON p.id = sp.player_id
    WHERE sp.consent_status = 'accepted' ORDER BY sp.is_live DESC, p.rating DESC`).all()));

  // ---- Betting & wallet --------------------------------------------------------
  app.post('/api/bets', needUser, route((req) => placeBet(db, req.user.id, req.body)));
  app.get('/api/bets', needUser, route((req) => {
    const bets = db.prepare('SELECT * FROM bets WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id);
    const legs = db.prepare(`SELECT l.odds, l.result, e.name selection, m.label market, m.kind, t.name tournament, t.slug tournamentSlug,
        (SELECT p.slug FROM entry_players ep JOIN players p ON p.id = ep.player_id WHERE ep.entry_id = e.id LIMIT 1) playerSlug
      FROM bet_legs l JOIN selections s ON s.id = l.selection_id JOIN entries e ON e.id = s.entry_id
      JOIN markets m ON m.id = s.market_id JOIN tournaments t ON t.id = m.tournament_id WHERE l.bet_id = ?`);
    return bets.map((b) => ({ id: b.id, stake: b.stake, totalOdds: b.total_odds, potentialPayout: b.potential_payout, status: b.status, payout: b.payout, createdAt: b.created_at, legs: legs.all(b.id) }));
  }));

  app.get('/api/wallet', needUser, route((req) => ({
    balance: req.user.balance,
    daily: eco.dailyStatus(req.user),
    transactions: db.prepare('SELECT id, amount, kind, ref, balance_after balanceAfter, created_at createdAt FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.user.id),
  })));
  app.post('/api/wallet/daily', needUser, route((req) => eco.claimDaily(db, req.user.id)));
  app.post('/api/wallet/rescue', needUser, route((req) => eco.claimRescue(db, req.user.id)));
  app.get('/api/missions', needUser, route((req) => eco.missionStatus(db, req.user.id)));
  app.post('/api/missions/:id/claim', needUser, route((req) => eco.claimMission(db, req.user.id, req.params.id)));

  app.get('/api/shop', route((req) => {
    const owned = new Set(req.user ? db.prepare('SELECT item_id FROM inventory WHERE user_id = ?').all(req.user.id).map((r) => r.item_id) : []);
    return db.prepare("SELECT * FROM shop_items ORDER BY CASE rarity WHEN 'legendary' THEN 0 WHEN 'epic' THEN 1 WHEN 'rare' THEN 2 WHEN 'uncommon' THEN 3 ELSE 4 END, price DESC")
      .all().map((i) => ({ ...i, data: j.parse(i.data, {}), owned: owned.has(i.id) }));
  }));
  app.post('/api/shop/:id/buy', needUser, route((req) => eco.buyItem(db, req.user.id, req.params.id)));
  app.post('/api/shop/:id/equip', needUser, route((req) => ({ equipped: eco.equipItem(db, req.user.id, req.params.id) })));

  app.get('/api/leaderboard', route(() => db.prepare(`
    SELECT u.username, u.balance, u.xp, u.equipped,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id AND b.status = 'won') wins,
      (SELECT COALESCE(SUM(COALESCE(b.payout, 0) - b.stake), 0) FROM bets b WHERE b.user_id = u.id AND b.status != 'open') profit
    FROM users u ORDER BY u.balance DESC LIMIT 50`).all()
    .map((u) => ({ username: u.username, balance: u.balance, level: eco.levelFromXp(u.xp), wins: u.wins, profit: u.profit,
      frame: itemById(j.parse(u.equipped, {}).frame), title: itemById(j.parse(u.equipped, {}).title) }))));

  // ---- Admin ---------------------------------------------------------------------
  app.get('/api/admin/overview', needAdmin, route(() => ({
    runs: db.prepare('SELECT * FROM ingest_runs ORDER BY id DESC LIMIT 30').all(),
    partners: db.prepare(`SELECT sp.*, p.handle, p.slug FROM stream_partners sp JOIN players p ON p.id = sp.player_id ORDER BY p.handle`).all()
      .map(({ ingest_key_hash, ...sp }) => ({ ...sp, hasKey: !!ingest_key_hash })),
    users: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(balance), 0) supply FROM users').get(),
    openBets: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(stake), 0) staked FROM bets WHERE status = 'open'").get(),
  })));
  let ingesting = false;
  app.post('/api/admin/ingest', needAdmin, route(async () => {
    if (ingesting) throw new eco.EconomyError('busy', 'Import déjà en cours');
    ingesting = true;
    try { await runIngest(db); } finally { ingesting = false; }
  }));
  // body: { results: [{ entryId, placement, points? }] }
  app.post('/api/admin/tournaments/:id/results', needAdmin, route((req) => {
    const st = db.prepare('UPDATE entries SET placement = ?, points = ? WHERE id = ? AND tournament_id = ?');
    tx(db, () => { for (const r of req.body.results || []) st.run(r.placement ?? null, r.points ?? null, r.entryId, req.params.id); });
    db.prepare("UPDATE tournaments SET status = 'completed' WHERE id = ?").run(req.params.id);
    const settled = settleTournament(db, Number(req.params.id));
    rebuild(db);
    return { settled };
  }));
  app.post('/api/admin/tournaments/:id/void', needAdmin, route((req) => ({ settled: voidTournament(db, Number(req.params.id)) })));
  app.patch('/api/admin/players/:slug', needAdmin, route((req) => {
    const allowed = { avatarUrl: 'avatar_url', avatarCredit: 'avatar_credit', twitch: 'twitch', region: 'region', country: 'country' };
    for (const [k, col] of Object.entries(allowed))
      if (k in req.body) db.prepare(`UPDATE players SET ${col} = ? WHERE slug = ?`).run(req.body[k] || null, req.params.slug);
  }));
  app.post('/api/admin/streams', needAdmin, route((req) => {
    const p = db.prepare('SELECT id FROM players WHERE slug = ?').get(req.body.playerSlug);
    if (!p) throw new eco.EconomyError('unknown_player', 'Joueur introuvable');
    upsertPartner(db, { ...req.body, playerId: p.id });
  }));
  app.post('/api/admin/streams/:slug/key', needAdmin, route((req) => {
    const p = db.prepare('SELECT id FROM players WHERE slug = ?').get(req.params.slug);
    if (!p) throw new eco.EconomyError('unknown_player', 'Joueur introuvable');
    const key = issueIngestKey(db, p.id);
    return {
      key,
      server: process.env.RTMP_PUBLIC_URL || 'rtmp://<ton-serveur>:1935/live',
      streamPath: `${req.params.slug}?key=${key}`,
      note: 'Clé affichée une seule fois. À transmettre au joueur par un canal privé.',
    };
  }));

  // ---- MediaMTX auth hook (authHTTPAddress) -------------------------------------
  app.post('/api/media/auth', route((req, res) => {
    if (!process.env.MEDIA_AUTH_SECRET || req.query.secret !== process.env.MEDIA_AUTH_SECRET) return res.status(401).end();
    if (!authorizeMediaRequest(db, req.body || {})) return res.status(401).end();
    res.status(200).end();
  }));
  app.post('/api/media/unpublish', route((req, res) => {
    if (!process.env.MEDIA_AUTH_SECRET || req.query.secret !== process.env.MEDIA_AUTH_SECRET) return res.status(401).end();
    const slug = String(req.query.path || '').replace(/^live\//, '');
    db.prepare("UPDATE stream_partners SET is_live = 0 WHERE player_id = (SELECT id FROM players WHERE slug = ?)").run(slug);
    res.status(200).end();
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  // ---- Static front-end ------------------------------------------------------------
  app.use('/vendor/hls.min.js', express.static(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
  for (const f of ['luckiest-guy', 'rajdhani', 'orbitron'])
    app.use(`/fonts/${f}`, express.static(path.join(ROOT, `node_modules/@fontsource/${f}/files`), { maxAge: '30d' }));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
  app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'public/index.html')));
  return app;
}
