// Shared helpers: API client, state, formatting, avatars, toasts.
export const state = { me: null, daily: null, config: null, slip: [], players: [] };

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.message || `Erreur ${res.status}`);
    Object.assign(err, data, { status: res.status });
    throw err;
  }
  return data;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// Tagged template that escapes interpolations unless wrapped with raw().
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const str = Array.isArray(v) ? v.map((x) => (x?.__raw ? x.value : esc(x))).join('') : v?.__raw ? v.value : esc(v);
    return out + str + s;
  }, '');
}
export const raw = (value) => ({ __raw: true, value });

export const fmt = {
  flux: (n) => `${Math.round(n ?? 0).toLocaleString('fr-FR')}`,
  usd: (n) => (n ? `${Math.round(n).toLocaleString('fr-FR')} $` : '—'),
  odds: (o) => Number(o).toFixed(2),
  pct: (p) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)} %`,
  date: (d) => new Date(d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }),
  datetime: (d) => new Date(d).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  place: (p) => (p == null ? '—' : p === 1 ? '1er' : `${p}e`),
};

export const flag = (cc) =>
  cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';

export function rarityForRank(rank) {
  if (rank <= 3) return 'legendary';
  if (rank <= 10) return 'epic';
  if (rank <= 25) return 'rare';
  if (rank <= 40) return 'uncommon';
  return 'common';
}
export function rarityForRating(rating) {
  if (rating >= 1550) return 'legendary';
  if (rating >= 1450) return 'epic';
  if (rating >= 1380) return 'rare';
  if (rating >= 1320) return 'uncommon';
  return 'common';
}
export const RARITY_LABEL = { common: 'Commun', uncommon: 'Inhabituel', rare: 'Rare', epic: 'Épique', legendary: 'Légendaire' };
const RARITY_COLORS = { common: ['#b4bcc7', '#5b6672'], uncommon: ['#7fe05c', '#2c7a1c'], rare: ['#6cc4ff', '#1260b8'], epic: ['#d38bff', '#5d1a9e'], legendary: ['#ffd36b', '#c26a00'] };

// Fallback avatar (no published photo yet): initials on a rarity gradient, as an SVG data URI.
export function avatarFallback(handle, rarity = 'rare') {
  const [c1, c2] = RARITY_COLORS[rarity] || RARITY_COLORS.rare;
  const initials = String(handle || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g" cx=".5" cy=".35" r=".8"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></radialGradient></defs><rect width="100" height="100" fill="url(#g)"/><circle cx="50" cy="40" r="20" fill="rgba(0,0,0,.25)"/><path d="M14 100 Q50 52 86 100Z" fill="rgba(0,0,0,.25)"/><text x="50" y="62" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="34" fill="#fff" text-anchor="middle" stroke="rgba(0,0,0,.35)" stroke-width="2" transform="skewX(-8)" transform-origin="50 50">${initials}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
export const avatar = (p, rarity) => p.avatarUrl || avatarFallback(p.handle, rarity || rarityForRating(p.rating));

export function toast(message, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), 4200);
}

export const coin = (size = 22) => raw(`<img class="coin" src="/img/flux.svg" alt="FLUX" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`);

export function modal(content, onMount) {
  const bg = document.createElement('div');
  bg.className = 'modal-bg';
  bg.innerHTML = `<div class="modal panel holo">${content}</div>`;
  bg.addEventListener('click', (e) => { if (e.target === bg || e.target.closest('[data-close]')) bg.remove(); });
  document.body.append(bg);
  onMount?.(bg.querySelector('.modal'), () => bg.remove());
  return bg;
}
