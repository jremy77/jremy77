// Live streams of the players, only with their signed agreement.
//
// Two ways to show a player's live:
//  1. twitch / youtube / kick: we embed the PUBLIC channel with the platform's
//     official player. No secret is needed — never ask a player for their
//     platform stream key: it would let anyone broadcast on their channel.
//  2. rtmp: the player streams (OBS "Custom" service) to OUR media server
//     (MediaMTX, see mediamtx.yml) with a key that WE issue here. The key is shown
//     once, only its sha256 is stored, and it can be revoked at any time.
import crypto from 'node:crypto';
import { EconomyError } from './economy.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const PLATFORMS = ['twitch', 'youtube', 'kick', 'rtmp'];

export function upsertPartner(db, { playerId, platform, channel, consentStatus, consentSignedAt, consentReference }) {
  if (!PLATFORMS.includes(platform)) throw new EconomyError('bad_platform', 'Plateforme inconnue');
  if (platform !== 'rtmp' && !/^[A-Za-z0-9_@.-]{2,60}$/.test(channel || ''))
    throw new EconomyError('bad_channel', 'Nom de chaîne invalide');
  if (!['pending', 'accepted', 'revoked'].includes(consentStatus)) throw new EconomyError('bad_status', 'Statut invalide');
  if (consentStatus === 'accepted' && !consentReference)
    throw new EconomyError('no_consent_ref', 'Référence de l’accord signé obligatoire pour activer le live');
  db.prepare(`
    INSERT INTO stream_partners (player_id, platform, channel, consent_status, consent_signed_at, consent_reference, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (player_id) DO UPDATE SET platform = excluded.platform, channel = excluded.channel,
      consent_status = excluded.consent_status, consent_signed_at = excluded.consent_signed_at,
      consent_reference = excluded.consent_reference, updated_at = excluded.updated_at`).run(
    playerId, platform, channel || null, consentStatus, consentSignedAt || null, consentReference || null
  );
}

// Issues (or rotates) the RTMP key of a player. Returned once; only the hash is kept.
export function issueIngestKey(db, playerId) {
  const partner = db.prepare('SELECT * FROM stream_partners WHERE player_id = ?').get(playerId);
  if (!partner || partner.platform !== 'rtmp') throw new EconomyError('not_rtmp', 'Ce partenaire n’utilise pas le serveur RTMP StormBet');
  if (partner.consent_status !== 'accepted') throw new EconomyError('no_consent', 'Accord non signé');
  const key = `sb_live_${crypto.randomBytes(24).toString('base64url')}`;
  db.prepare('UPDATE stream_partners SET ingest_key_hash = ?, ingest_key_hint = ?, updated_at = datetime(\'now\') WHERE player_id = ?').run(
    sha256(key), key.slice(-4), playerId
  );
  return key;
}

// MediaMTX "authMethod: http" hook. Publishing requires a valid issued key
// (passed as ?key=... in the stream path query); reading is public.
export function authorizeMediaRequest(db, { action, path: streamPath, query }) {
  if (action === 'read' || action === 'playback') return true;
  if (action !== 'publish') return false;
  const slug = String(streamPath || '').replace(/^live\//, '');
  const key = new URLSearchParams(query || '').get('key') || '';
  const row = db
    .prepare(`SELECT sp.* FROM stream_partners sp JOIN players p ON p.id = sp.player_id
              WHERE p.slug = ? AND sp.platform = 'rtmp' AND sp.consent_status = 'accepted'`)
    .get(slug);
  if (!row?.ingest_key_hash || !key) return false;
  const ok = crypto.timingSafeEqual(Buffer.from(row.ingest_key_hash), Buffer.from(sha256(key)));
  if (ok) db.prepare('UPDATE stream_partners SET is_live = 1 WHERE id = ?').run(row.id);
  return ok;
}

// Public description of a player's stream, or null when there is no active agreement.
export function publicStream(db, playerId, { hlsBase = process.env.HLS_BASE_URL } = {}) {
  const sp = db
    .prepare(`SELECT sp.*, p.slug FROM stream_partners sp JOIN players p ON p.id = sp.player_id
              WHERE sp.player_id = ? AND sp.consent_status = 'accepted'`)
    .get(playerId);
  if (!sp) return null;
  const out = { platform: sp.platform, channel: sp.channel, isLive: !!sp.is_live };
  if (sp.platform === 'rtmp') {
    if (!hlsBase) return null;
    out.hlsUrl = `${hlsBase.replace(/\/$/, '')}/live/${sp.slug}/index.m3u8`;
  }
  return out;
}
