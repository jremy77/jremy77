// Liquipedia (the esports wiki that took over the Gamepedia/Fandom Fortnite
// esports pages) through its official database API, LPDB v3.
// Needs an API key: https://liquipedia.net/api  -> env LIQUIPEDIA_API_KEY.
// Data is CC-BY-SA 3.0: keep the source links (stored in `sources`).
import { getJson } from './http.js';
import { slugify } from '../db.js';

const API = 'https://api.liquipedia.net/api/v3';
const WIKI = 'https://liquipedia.net/fortnite/';

export function mapTier(t) {
  const name = `${t.name} ${t.tickername || ''}`;
  const tier = Number(t.liquipediatier);
  if (tier === 1 && /global championship|world cup|lan|summit/i.test(name)) return /summit/i.test(name) ? 'summit' : 'world';
  if (tier === 1) return 'major';
  if (tier === 2) return 'qualifier';
  return 'cup';
}

export function mapMode(opponentType) {
  return { solo: 'solo', duo: 'duo', trio: 'trio', squad: 'squad', team: 'squad' }[opponentType] || 'solo';
}

// "1", "3-4", "11-20" -> best placement number. Non-numeric (DQ, "-") -> null.
export function parsePlacement(p) {
  const n = parseInt(String(p || '').split('-')[0], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function playersFromOpponent(op = {}) {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const name = op[`p${i}dn`] || op[`p${i}`];
    if (!name) continue;
    out.push({ handle: name.replace(/_/g, ' '), country: op[`p${i}flag`] || null, team: op[`p${i}team`] || undefined });
  }
  return out;
}

export function normalizeTournament(t, placements, now = new Date()) {
  const end = t.enddate && !t.enddate.startsWith('0000') ? `${t.enddate}T23:00:00Z` : null;
  const start = `${t.startdate}T15:00:00Z`;
  const opponentType = placements[0]?.opponenttype;
  const results = [];
  const entries = [];
  for (const pl of placements) {
    const players = playersFromOpponent(pl.opponentplayers);
    if (!players.length) continue;
    const handles = players.map((p) => p.handle);
    const placement = parsePlacement(pl.placement);
    if (placement) results.push({ placement, players: handles, prize_usd: Number(pl.prizemoney) || null, points: Number(pl.extradata?.points) || null });
    else entries.push(handles);
  }
  const status = end && new Date(end) < now ? 'completed' : new Date(start) > now ? 'upcoming' : 'live';
  return {
    slug: slugify(t.pagename),
    name: t.name,
    series: t.series || null,
    tier: mapTier(t),
    mode: mapMode(opponentType),
    region: t.locations?.region1 || t.region || null,
    location: t.type === 'Offline' ? t.location || null : 'Online',
    start_at: start,
    end_at: end,
    prize_pool_usd: Number(t.prizepool) || null,
    field_size: Number(t.participantsnumber) || null,
    status: status === 'live' ? 'upcoming' : status,
    field_status: entries.length || results.length ? 'confirmed' : 'provisional',
    source_url: WIKI + t.pagename,
    sources: [WIKI + t.pagename],
    results,
    entries,
  };
}

export async function fetchLiquipedia({ apiKey = process.env.LIQUIPEDIA_API_KEY, sinceDays = 400, now = new Date() } = {}) {
  if (!apiKey) throw new Error('LIQUIPEDIA_API_KEY manquante');
  const headers = { Authorization: `Apikey ${apiKey}` };
  const since = new Date(now - sinceDays * 86400000).toISOString().slice(0, 10);
  const q = (endpoint, params) => getJson(`${API}/${endpoint}?${new URLSearchParams({ wiki: 'fortnite', ...params })}`, { headers });

  const { result: tournaments = [] } = await q('tournament', {
    conditions: `[[startdate::>${since}]] AND ([[liquipediatier::1]] OR [[liquipediatier::2]])`,
    limit: '500',
    order: 'startdate DESC',
  });

  const players = new Map();
  const out = [];
  for (const t of tournaments) {
    const { result: placements = [] } = await q('placement', { conditions: `[[parent::${t.pagename}]]`, limit: '500' });
    const n = normalizeTournament(t, placements, now);
    out.push(n);
    for (const pl of placements)
      for (const p of playersFromOpponent(pl.opponentplayers))
        players.set(p.handle, { ...players.get(p.handle), ...p, sources: [WIKI + p.handle.replace(/ /g, '_')] });
  }
  return { players: [...players.values()], tournaments: out };
}
