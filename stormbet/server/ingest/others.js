// Secondary sources used to enrich player profiles.
import { getJson, postForm } from './http.js';

// --- Fortnite Tracker (Tracker Network) ---------------------------------------
// Power Ranking points per player. Key: https://fortnitetracker.com/site-api -> TRN_API_KEY.
export async function fetchFortniteTracker(handles, { apiKey = process.env.TRN_API_KEY, platform = 'pc', regions = ['EU', 'NAC'] } = {}) {
  if (!apiKey) throw new Error('TRN_API_KEY manquante');
  const players = [];
  for (const handle of handles) {
    for (const region of regions) {
      try {
        const r = await getJson(
          `https://api.fortnitetracker.com/v1/powerrankings/${platform}/${region}/${encodeURIComponent(handle)}`,
          { headers: { 'TRN-Api-Key': apiKey }, minIntervalMs: 2100, retries: 1 }
        );
        if (r?.points != null) {
          players.push({
            handle,
            pr_points: Number(r.points) || null,
            earnings_usd: Number(String(r.cashPrize || '').replace(/[^0-9.]/g, '')) || null,
            sources: [`https://fortnitetracker.com/profile/all/${encodeURIComponent(handle)}`],
          });
          break;
        }
      } catch {
        // player unknown in this region: try the next one
      }
    }
  }
  return { players, tournaments: [] };
}

// --- Esports Earnings -----------------------------------------------------------
// Career prize money and country. Key: https://www.esportsearnings.com/dev -> ESPORTS_EARNINGS_API_KEY.
export async function fetchEsportsEarnings({ apiKey = process.env.ESPORTS_EARNINGS_API_KEY, pages = 2 } = {}) {
  if (!apiKey) throw new Error('ESPORTS_EARNINGS_API_KEY manquante');
  const players = [];
  for (let page = 0; page < pages; page++) {
    const rows = await getJson(
      `https://api.esportsearnings.com/v0/LookupHighestEarningPlayersByGame?${new URLSearchParams({ apikey: apiKey, gameid: '534', offset: String(page * 100) })}`,
      { minIntervalMs: 1100 }
    );
    for (const r of rows || [])
      players.push({
        handle: r.CurrentHandle,
        country: r.CountryCode ? r.CountryCode.toUpperCase() : null,
        earnings_usd: Number(r.TotalUSDPrize) || null,
        sources: [`https://www.esportsearnings.com/players/${r.PlayerId}`],
      });
  }
  return { players, tournaments: [] };
}

// --- Twitch -------------------------------------------------------------------
// Profile pictures published by the players themselves + live status of partners.
// App credentials: https://dev.twitch.tv/console -> TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET.
async function twitchToken() {
  const { TWITCH_CLIENT_ID: id, TWITCH_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) throw new Error('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET manquants');
  const t = await postForm('https://id.twitch.tv/oauth2/token', { client_id: id, client_secret: secret, grant_type: 'client_credentials' });
  return { 'Client-Id': id, Authorization: `Bearer ${t.access_token}` };
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

export async function fetchTwitchProfiles(logins) {
  const headers = await twitchToken();
  const players = [];
  for (const group of chunks(logins.filter(Boolean), 100)) {
    const qs = group.map((l) => `login=${encodeURIComponent(l.login)}`).join('&');
    const { data = [] } = await getJson(`https://api.twitch.tv/helix/users?${qs}`, { headers, minIntervalMs: 200 });
    for (const u of data) {
      const owner = group.find((l) => l.login.toLowerCase() === u.login.toLowerCase());
      if (owner) players.push({ handle: owner.handle, avatar_url: u.profile_image_url, avatar_credit: `Twitch — ${u.display_name}` });
    }
  }
  return { players, tournaments: [] };
}

export async function fetchTwitchLive(logins) {
  const headers = await twitchToken();
  const live = new Set();
  for (const group of chunks(logins, 100)) {
    const qs = group.map((l) => `user_login=${encodeURIComponent(l)}`).join('&');
    const { data = [] } = await getJson(`https://api.twitch.tv/helix/streams?${qs}`, { headers, minIntervalMs: 200 });
    for (const s of data) live.add(s.user_login.toLowerCase());
  }
  return live;
}
