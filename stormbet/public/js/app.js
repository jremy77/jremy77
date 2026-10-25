import { state, api, html, raw, esc, fmt, flag, avatar, rarityForRank, rarityForRating, RARITY_LABEL, toast, coin, modal } from './core.js';
import { renderAdmin } from './admin.js';

const app = document.getElementById('app');
let cleanup = [];
const onLeave = (fn) => cleanup.push(fn);

// ============================================================ Session & top bar
async function refreshMe() {
  const prev = state.me?.balance;
  const r = await api('/me');
  state.me = r.user;
  state.daily = r.daily;
  renderUserbox(prev != null && state.me && state.me.balance !== prev);
}

function renderUserbox(bump) {
  const box = document.getElementById('userbox');
  if (!state.me) {
    box.innerHTML = html`<button class="btn ghost sm" data-auth="login">Connexion</button><button class="btn sm" data-auth="register">Jouer gratuitement</button>`;
    return;
  }
  const u = state.me;
  box.innerHTML = html`
    ${state.daily?.available ? raw(`<a class="btn purple sm" href="#/portefeuille" title="Ravitaillement quotidien disponible">🎁 Drop</a>`) : ''}
    <a class="flux-pill ${bump ? 'bump' : ''}" href="#/portefeuille" title="Ton portefeuille FLUX">${coin(26)}<span id="balance">${fmt.flux(u.balance)}</span></a>
    <a class="chip hide-sm" href="#/mes-paris" title="Mes paris">NIV. ${u.level} · ${u.username}</a>
    ${u.role === 'admin' ? raw('<a class="chip warn" href="#/admin">Admin</a>') : ''}
    <button class="btn ghost sm" data-logout>⏻</button>`;
}

document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-auth]');
  if (a) return authModal(a.dataset.auth);
  if (e.target.closest('[data-logout]')) {
    await api('/auth/logout', { method: 'POST', body: {} });
    await refreshMe();
    route();
  }
});

function authModal(mode = 'login') {
  const reg = mode === 'register';
  modal(html`
    <h2 class="skew">${reg ? 'Rejoins la tempête' : 'Connexion'}</h2>
    ${reg ? raw(`<p class="muted">Inscription gratuite : <b style="color:var(--gold)">1 000 FLUX</b> offerts pour ton premier saut.</p>`) : ''}
    <form id="authform">
      <label>Pseudo</label><input name="username" autocomplete="username" required minlength="3" maxlength="20">
      <label>Mot de passe</label><input name="password" type="password" autocomplete="${reg ? 'new-password' : 'current-password'}" required minlength="8">
      ${reg ? raw(`<label class="check"><input type="checkbox" name="adult" required> J'ai 18 ans ou plus et j'ai compris que les FLUX sont une monnaie virtuelle sans valeur réelle.</label>`) : ''}
      <div class="row" style="margin-top:16px"><button class="btn" type="submit">${reg ? 'Sauter du bus' : 'Entrer'}</button>
      <button class="btn ghost sm" type="button" data-switch>${reg ? 'J’ai déjà un compte' : 'Créer un compte'}</button></div>
    </form>`,
  (el, close) => {
    el.querySelector('[data-switch]').onclick = () => { close(); authModal(reg ? 'login' : 'register'); };
    el.querySelector('form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api(`/auth/${reg ? 'register' : 'login'}`, { method: 'POST', body: { username: f.get('username'), password: f.get('password'), adult: f.get('adult') === 'on' } });
        close();
        await refreshMe();
        toast(reg ? 'Bienvenue ! 1 000 FLUX crédités ⚡' : `Content de te revoir, ${state.me.username} !`, reg ? 'win' : '');
        route();
      } catch (err) { toast(err.message, 'bad'); }
    };
  });
}
const requireLogin = () => { if (!state.me) { authModal('register'); return false; } return true; };

// ============================================================ Bet slip
const slipEl = document.getElementById('slip');
let slipOpen = false;
let slipMode = 'combo';
function saveSlip() { try { localStorage.setItem('stormbet.slip', JSON.stringify(state.slip)); } catch {} }
try { state.slip = JSON.parse(localStorage.getItem('stormbet.slip') || '[]'); } catch { state.slip = []; }

export function toggleSelection(sel) {
  const i = state.slip.findIndex((s) => s.selectionId === sel.selectionId);
  if (i >= 0) state.slip.splice(i, 1);
  else {
    state.slip = state.slip.filter((s) => s.marketId !== sel.marketId);
    state.slip.push(sel);
    slipOpen = true;
  }
  saveSlip();
  renderSlip();
  document.querySelectorAll('[data-sel]').forEach((b) => b.classList.toggle('selected', state.slip.some((s) => s.selectionId === Number(b.dataset.sel))));
}

function renderSlip() {
  const n = state.slip.length;
  slipEl.classList.toggle('open', slipOpen && n > 0);
  slipEl.style.display = n ? '' : 'none';
  const comboAllowed = n > 1 && new Set(state.slip.map((s) => s.tournamentId)).size === n;
  const combo = comboAllowed && slipMode === 'combo';
  const total = combo ? state.slip.reduce((p, s) => p * s.odds, 1) : null;
  slipEl.innerHTML = html`
    <header data-toggle><span>🎯 Ticket ${n > 1 ? (combo ? 'combiné' : 'paris simples') : ''}</span><span class="count">${n}</span></header>
    <div class="body">
      ${n > 1 ? raw(html`<div class="tabs" style="margin:0 0 6px">
        <button data-mode="combo" class="${combo ? 'active' : ''}" ${comboAllowed ? '' : 'disabled title="Un combiné doit porter sur des tournois différents"'}>Combiné</button>
        <button data-mode="singles" class="${combo ? '' : 'active'}">Simples</button></div>`) : ''}
      ${state.slip.map((s) => raw(html`<div class="leg"><div><b>${s.name}</b><br><small class="muted">${s.market} · ${s.tournament}</small></div>
        <div class="row" style="flex-wrap:nowrap"><span class="num" style="color:var(--gold)">${fmt.odds(s.odds)}</span><button data-remove="${s.selectionId}" aria-label="Retirer">✕</button></div></div>`))}
      <label>Mise${n > 1 && !combo ? ' par pari' : ''} (FLUX)</label>
      <input id="stake" type="number" min="10" step="10" value="${localStorage.getItem('stormbet.stake') || 100}">
      <div class="row" style="margin:8px 0">${[50, 100, 250, 500, 1000].map((v) => raw(`<button class="btn ghost sm" data-stake="${v}">${v}</button>`))}</div>
      ${combo || n === 1 ? raw(html`<p class="row spread"><span>Cote totale</span><b class="num" style="color:var(--gold)">${fmt.odds(total ?? state.slip[0]?.odds)}</b></p>`) : ''}
      <p class="row spread"><span>${n > 1 && !combo ? 'Gain potentiel max.' : 'Gain potentiel'}</span><b class="num" id="potential"></b></p>
      <button class="btn" style="width:100%" data-place>Valider le pari</button>
      <button class="btn ghost sm" style="width:100%;margin-top:8px" data-clear>Vider le ticket</button>
    </div>`;
  const stake = slipEl.querySelector('#stake');
  const upd = () => {
    const v = Number(stake.value) || 0;
    const pot = combo ? Math.floor(v * total) : state.slip.reduce((sum, s) => sum + Math.floor(v * s.odds), 0);
    slipEl.querySelector('#potential').textContent = `${fmt.flux(pot)} ⚡`;
  };
  stake.oninput = upd;
  upd();
}

slipEl.addEventListener('click', async (e) => {
  if (e.target.closest('[data-toggle]')) { slipOpen = !slipOpen; return renderSlip(); }
  const mode = e.target.closest('[data-mode]');
  if (mode) { slipMode = mode.dataset.mode; return renderSlip(); }
  const rm = e.target.closest('[data-remove]');
  if (rm) return toggleSelection(state.slip.find((s) => s.selectionId === Number(rm.dataset.remove)));
  const st = e.target.closest('[data-stake]');
  if (st) { slipEl.querySelector('#stake').value = st.dataset.stake; slipEl.querySelector('#stake').dispatchEvent(new Event('input')); return; }
  if (e.target.closest('[data-clear]')) { state.slip = []; saveSlip(); renderSlip(); route(); return; }
  if (e.target.closest('[data-place]')) {
    if (!requireLogin()) return;
    const stake = Number(slipEl.querySelector('#stake').value);
    try { localStorage.setItem('stormbet.stake', stake); } catch {}
    const combo = state.slip.length > 1 && slipMode === 'combo' && new Set(state.slip.map((s) => s.tournamentId)).size === state.slip.length;
    const tickets = combo ? [state.slip] : state.slip.map((s) => [s]);
    try {
      let potential = 0;
      while (tickets.length) {
        const legs = tickets[0];
        const r = await api('/bets', { method: 'POST', body: { stake, legs: legs.map((s) => ({ selectionId: s.selectionId, odds: s.odds })) } });
        potential += r.bet.potential_payout;
        tickets.shift();
        state.slip = state.slip.filter((s) => !legs.includes(s));
      }
      toast(`${combo ? 'Combiné validé' : 'Pari(s) validé(s)'} ! Gain potentiel : ${fmt.flux(potential)} FLUX`, 'win');
      state.slip = []; saveSlip(); slipOpen = false; renderSlip();
      await refreshMe();
      route();
    } catch (err) {
      if (err.error === 'odds_changed') {
        const s = state.slip.find((x) => x.selectionId === err.selectionId);
        if (s) s.odds = err.odds;
        saveSlip(); renderSlip();
        toast(`La cote a bougé : nouvelle cote ${fmt.odds(err.odds)}. Vérifie et valide à nouveau.`, 'bad');
      } else toast(err.message, 'bad');
      saveSlip(); renderSlip(); refreshMe();
    }
  }
});

// ============================================================ Shared components
function playerCard(p, rank) {
  const rarity = rank ? rarityForRank(rank) : rarityForRating(p.rating);
  return html`<a class="pcard r-${rarity}" href="#/joueur/${p.slug}" title="${p.handle} — ${RARITY_LABEL[rarity]}">
    ${rank ? raw(`<span class="rank">#${rank}</span>`) : ''}
    ${p.live ? raw('<span class="chip live live-dot">● Live</span>') : ''}
    <img class="avatar" src="${avatar(p, rarity)}" alt="${p.handle}" loading="lazy">
    <div class="info"><div class="name">${p.handle}</div>
    <div class="meta"><span>${flag(p.country)} ${p.team || p.region || ''}</span><span class="num">${p.rating}</span></div></div></a>`;
}

const STATUS_LABEL = { upcoming: 'À venir', completed: 'Terminé', live: 'En cours' };
const MODE_LABEL = { solo: 'Solo', duo: 'Duo', trio: 'Trio', squad: 'Squad' };

function oddButton(sel, entry, market, t) {
  const picked = state.slip.some((s) => s.selectionId === sel.id);
  const p = entry.players[0] || { handle: entry.name };
  const disabled = market.status !== 'open';
  const payload = esc(JSON.stringify({ selectionId: sel.id, marketId: market.id, tournamentId: t.id, odds: sel.odds, name: entry.name, market: market.label, tournament: t.name }));
  return html`<button class="odd ${picked ? 'selected' : ''} ${sel.result || ''}" data-sel="${sel.id}" data-payload="${raw(payload)}" ${disabled ? 'disabled' : ''}>
    <img src="${avatar(p)}" alt="">
    <span class="who"><b>${entry.name}</b><small>${flag(p.country)} Proba ${fmt.pct(sel.probability)}</small><span class="prob-bar"><i style="width:${Math.min(100, sel.probability * 100 * 2)}%"></i></span></span>
    <span class="price">${sel.result === 'won' ? '✔' : fmt.odds(sel.odds)}</span></button>`;
}

app.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sel]');
  if (b && !b.disabled) toggleSelection(JSON.parse(b.dataset.payload));
});

function countdown(el, target) {
  const tick = () => {
    const ms = Math.max(0, new Date(target) - Date.now());
    const d = Math.floor(ms / 86400000), h = Math.floor(ms / 3600000) % 24, m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    el.innerHTML = [[d, 'jours'], [h, 'heures'], [m, 'min'], [s, 'sec']].map(([v, l]) => `<div><b>${String(v).padStart(2, '0')}</b><span>${l}</span></div>`).join('');
  };
  tick();
  const id = setInterval(tick, 1000);
  onLeave(() => clearInterval(id));
}

// ============================================================ Pages
async function pageHome() {
  const [tournaments, players, live] = await Promise.all([api('/tournaments'), api('/players'), api('/live')]);
  const next = tournaments.find((t) => t.status === 'upcoming');
  const detail = next ? await api(`/tournaments/${next.slug}`) : null;
  const winner = detail?.markets.find((m) => m.kind === 'winner');
  const entries = new Map(detail?.entries.map((e) => [e.id, e]) || []);
  app.innerHTML = html`
    <section class="hero">
      <div class="clouds">${[[8, 90, 26, 60], [22, 140, 32, 85], [55, 70, 20, 45], [70, 120, 28, 70]].map(([top, w, h, dur], i) =>
        raw(`<div class="cloud" style="top:${top}%;width:${w}px;height:${h}px;animation-duration:${dur}s;animation-delay:-${i * 17}s"></div>`))}</div>
      <div class="storm"></div><img class="bus" src="/img/bus.svg" alt=""><div class="island"></div>
      <div class="hero-content">
        <span class="chip upcoming">Saison compétitive ${new Date().getFullYear()}</span>
        <h1 class="skew">Saute du bus.<br><em>Parie sur les pros.</em></h1>
        <p>Les compétitions Fortnite officielles, des cotes calculées sur le niveau réel des joueurs, et une monnaie 100 % virtuelle : les <b>FLUX</b>.</p>
        ${next ? raw(html`<p class="small" style="margin:0"><b>Prochain événement :</b> ${next.name}</p><div class="countdown" id="cd"></div>`) : ''}
        <div class="row">
          ${next ? raw(html`<a class="btn" href="#/tournoi/${next.slug}">Voir les cotes</a>`) : ''}
          ${state.me ? '' : raw('<button class="btn blue" data-auth="register">1 000 FLUX offerts</button>')}
        </div>
      </div>
    </section>

    ${winner ? raw(html`<section class="section">
      <div class="section-title"><h2 class="skew">Favoris — ${next.name}</h2><a href="#/tournoi/${next.slug}">Tous les marchés →</a></div>
      ${next.fieldStatus === 'provisional' ? raw('<p class="chip warn">Champ provisoire — mis à jour après les qualifications</p>') : ''}
      <div class="odds-list" style="margin-top:10px">${winner.selections.slice(0, 8).map((s) => raw(oddButton(s, entries.get(s.entryId), winner, next)))}</div>
    </section>`) : ''}

    <section class="section">
      <div class="section-title"><h2 class="skew">Top joueurs — Storm Rating</h2><a href="#/joueurs">Classement complet →</a></div>
      <div class="grid cards">${players.slice(0, 10).map((p) => raw(playerCard(p, p.rank)))}</div>
    </section>

    ${live.some((l) => l.isLive) ? raw(html`<section class="section"><div class="section-title"><h2 class="skew">En live maintenant</h2><a href="#/live">Tous les lives →</a></div>
      <div class="row">${live.filter((l) => l.isLive).map((l) => raw(html`<a class="chip live" href="#/joueur/${l.slug}">● ${l.handle}</a>`))}</div></section>`) : ''}

    <section class="section">
      <h2 class="skew">Comment ça marche</h2>
      <div class="steps">
        <div class="panel step"><h3>Crée ton compte</h3><p class="muted">Gratuit, 18+. Tu reçois 1 000 FLUX pour commencer.</p></div>
        <div class="panel step"><h3>Choisis un tournoi</h3><p class="muted">FNCS, Global Championship, Majors : uniquement des compétitions officielles.</p></div>
        <div class="panel step"><h3>Pose ton pari</h3><p class="muted">Vainqueur, podium, top 10 ou duel. Combine plusieurs tournois pour multiplier les cotes.</p></div>
        <div class="panel step"><h3>Regarde le live</h3><p class="muted">Suis en direct le joueur sur qui tu as parié (joueurs partenaires).</p></div>
      </div>
    </section>`;
  if (next) countdown(document.getElementById('cd'), next.startAt);
}

async function pageTournaments() {
  const list = await api('/tournaments');
  const card = (t) => html`<a class="panel tcard ${t.tier}" href="#/tournoi/${t.slug}">
    <div class="banner"></div>
    <div class="row spread"><span class="chip ${t.status}">${STATUS_LABEL[t.status] || t.status}</span><span class="chip">${MODE_LABEL[t.mode] || t.mode}</span></div>
    <h3 style="margin-top:10px">${t.name}</h3>
    <p class="muted small">${fmt.datetime(t.startAt)} · ${t.location || t.region || ''}</p>
    <p class="row spread small"><span>${t.entries} participants</span><span>${t.prizePoolUsd ? `Cashprize ${fmt.usd(t.prizePoolUsd)}` : ''}</span><span>${t.markets ? `${t.markets} marchés ouverts` : ''}</span></p></a>`;
  const up = list.filter((t) => t.status !== 'completed');
  const done = list.filter((t) => t.status === 'completed');
  app.innerHTML = html`<h1 class="skew">Tournois</h1>
    <h2>À venir</h2><div class="grid cols-3">${up.length ? up.map((t) => raw(card(t))) : raw('<p class="empty">Aucun tournoi à venir pour le moment.</p>')}</div>
    <h2 style="margin-top:36px">Résultats</h2><div class="grid cols-3">${done.map((t) => raw(card(t)))}</div>`;
}

async function pageTournament(slug) {
  const t = await api(`/tournaments/${slug}`);
  const entries = new Map(t.entries.map((e) => [e.id, e]));
  const kinds = [...new Set(t.markets.map((m) => m.kind))];
  const KIND_LABEL = { winner: 'Vainqueur', top3: 'Podium', top10: 'Top 10', h2h: 'Duels' };
  let tab = kinds[0] || 'field';
  const draw = () => {
    const body = tab === 'field'
      ? html`<div class="table-wrap"><table><thead><tr><th>Place</th><th>${t.mode === 'solo' ? 'Joueur' : 'Équipe'}</th><th>Points</th><th>Gains</th><th>Storm Rating</th></tr></thead><tbody>
        ${t.entries.map((e) => raw(html`<tr><td class="num">${fmt.place(e.placement)}</td>
          <td>${e.players.map((p) => raw(html`<a href="#/joueur/${p.slug}">${flag(p.country)} ${p.handle}</a> ${p.live ? raw('<span class="chip live">live</span>') : ''} `))}</td>
          <td class="num">${e.points ?? '—'}</td><td>${fmt.usd(e.prizeUsd)}</td><td class="num">${Math.round(e.players.reduce((s, p) => s + p.rating, 0) / e.players.length)}</td></tr>`))}
        </tbody></table></div>`
      : t.markets.filter((m) => m.kind === tab).map((m) => m.kind === 'h2h'
        ? html`<div class="panel market"><div class="row spread"><b>${m.label}</b><span class="chip ${m.status === 'open' ? 'upcoming' : 'completed'}">${m.status === 'open' ? 'Ouvert' : m.status === 'settled' ? 'Réglé' : 'Fermé'}</span></div>
            <div class="h2h" style="margin-top:10px">${raw(oddButton(m.selections[0], entries.get(m.selections[0].entryId), m, t))}<span class="vs">VS</span>${raw(oddButton(m.selections[1], entries.get(m.selections[1].entryId), m, t))}</div></div>`
        : html`<div class="market"><div class="row spread"><h3>${m.label}</h3><span class="muted small">Fermeture ${fmt.datetime(m.closesAt)}</span></div>
            <div class="odds-list">${m.selections.map((s) => raw(oddButton(s, entries.get(s.entryId), m, t)))}</div></div>`).join('');
    document.getElementById('tbody').innerHTML = body;
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  };
  app.innerHTML = html`
    <section class="panel holo" style="background:linear-gradient(120deg,rgba(13,79,214,.6),rgba(123,47,247,.5))">
      <div class="row"><span class="chip ${t.status}">${STATUS_LABEL[t.status]}</span><span class="chip">${MODE_LABEL[t.mode]}</span>${t.region ? raw(html`<span class="chip">${t.region}</span>`) : ''}</div>
      <h1 class="skew" style="margin-top:10px">${t.name}</h1>
      <p>${fmt.datetime(t.startAt)} · ${t.location || ''} ${t.prizePoolUsd ? `· Cashprize ${fmt.usd(t.prizePoolUsd)}` : ''}</p>
      ${t.status === 'upcoming' ? raw('<div class="countdown" id="cd"></div>') : ''}
      ${t.notes ? raw(html`<p class="chip warn" style="white-space:normal;line-height:1.4;text-transform:none;letter-spacing:0">${t.notes}</p>`) : ''}
      <p class="small muted">Sources : ${t.sources.map((s) => raw(html`<a href="${s}" target="_blank" rel="noopener">${new URL(s).hostname}</a> `))}</p>
    </section>
    <div class="tabs" style="margin-top:20px">${kinds.map((k) => raw(html`<button data-tab="${k}">${KIND_LABEL[k]}</button>`))}<button data-tab="field">${t.status === 'completed' ? 'Classement' : 'Participants'}</button></div>
    <div id="tbody"></div>`;
  app.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) { tab = b.dataset.tab; draw(); } };
  draw();
  if (t.status === 'upcoming') countdown(document.getElementById('cd'), t.startAt);
}

async function pagePlayers() {
  const players = await api('/players');
  state.players = players;
  app.innerHTML = html`<h1 class="skew">Joueurs</h1>
    <p class="muted">Classement par <b>Storm Rating</b> : performances en compétition officielle pondérées par le prestige de l'événement et la récence, plus les gains en carrière et les points Power Ranking.</p>
    <div class="row" style="margin:16px 0"><input id="q" placeholder="Rechercher un joueur…" style="flex:1;min-width:200px">
      <select id="region"><option value="">Toutes les régions</option>${[...new Set(players.map((p) => p.region).filter(Boolean))].map((r) => raw(html`<option>${r}</option>`))}</select></div>
    <div class="grid cards" id="pgrid"></div>`;
  const draw = () => {
    const q = document.getElementById('q').value.toLowerCase();
    const r = document.getElementById('region').value;
    document.getElementById('pgrid').innerHTML = players.filter((p) => p.handle.toLowerCase().includes(q) && (!r || p.region === r)).map((p) => playerCard(p, p.rank)).join('') || '<p class="empty">Aucun joueur.</p>';
  };
  document.getElementById('q').oninput = draw;
  document.getElementById('region').onchange = draw;
  draw();
}

function streamEmbed(stream) {
  if (!stream) return '';
  const parent = state.config?.twitchParent || location.hostname;
  if (stream.platform === 'twitch') return `<iframe src="https://player.twitch.tv/?channel=${encodeURIComponent(stream.channel)}&parent=${encodeURIComponent(parent)}&muted=true" allowfullscreen title="Live Twitch"></iframe>`;
  if (stream.platform === 'youtube') return `<iframe src="https://www.youtube.com/embed/live_stream?channel=${encodeURIComponent(stream.channel)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="Live YouTube"></iframe>`;
  if (stream.platform === 'kick') return `<iframe src="https://player.kick.com/${encodeURIComponent(stream.channel)}" allowfullscreen title="Live Kick"></iframe>`;
  if (stream.platform === 'rtmp' && stream.hlsUrl) return `<video id="hlsvideo" controls muted autoplay playsinline data-src="${esc(stream.hlsUrl)}"></video>`;
  return '';
}

async function mountHls() {
  const v = document.getElementById('hlsvideo');
  if (!v) return;
  if (v.canPlayType('application/vnd.apple.mpegurl')) { v.src = v.dataset.src; return; }
  if (!window.Hls) await new Promise((ok, ko) => { const s = document.createElement('script'); s.src = '/vendor/hls.min.js'; s.onload = ok; s.onerror = ko; document.head.append(s); });
  const hls = new window.Hls();
  hls.loadSource(v.dataset.src);
  hls.attachMedia(v);
  onLeave(() => hls.destroy());
}

async function pagePlayer(slug) {
  const p = await api(`/players/${slug}`);
  const rarity = rarityForRank(p.rank);
  app.innerHTML = html`
    <div class="grid" style="grid-template-columns:minmax(220px,300px) 1fr;align-items:start" id="pl">
      <div>${raw(playerCard(p, p.rank))}<p class="small muted" style="margin-top:6px">${p.avatarCredit ? `Photo : ${p.avatarCredit}` : 'Photo officielle à venir'}</p></div>
      <div class="panel holo">
        <span class="chip" style="border-color:var(--${rarity});color:var(--${rarity})">${RARITY_LABEL[rarity]}</span>
        <h1 class="skew" style="margin-top:8px">${flag(p.country)} ${p.handle}</h1>
        <div class="grid cols-3" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
          <div><div class="muted small">Storm Rating</div><div class="num" style="font-size:30px">${p.rating}</div></div>
          <div><div class="muted small">Rang mondial</div><div class="num" style="font-size:30px">#${p.rank}</div></div>
          <div><div class="muted small">Fiabilité du modèle</div><div class="num" style="font-size:30px">${Math.round(p.confidence * 100)}%</div></div>
          <div><div class="muted small">Gains carrière</div><div class="num" style="font-size:22px">${fmt.usd(p.earningsUsd)}</div></div>
          <div><div class="muted small">Équipe</div><div style="font-size:22px">${p.team || '—'}</div></div>
          <div><div class="muted small">Région</div><div style="font-size:22px">${p.region || '—'}</div></div>
        </div>
        <p class="muted small">Forme : ${p.form.length ? p.form.map((f) => raw(html`<span class="chip" title="${f.event}">${fmt.place(f.placement)}</span> `)) : 'pas encore de résultat'}</p>
      </div>
    </div>
    ${p.stream ? raw(html`<section class="section"><div class="section-title"><h2 class="skew">Live de ${p.handle}</h2>${p.stream.isLive ? raw('<span class="chip live">● En direct</span>') : raw('<span class="chip">Hors ligne</span>')}</div>
      <div class="player-embed">${raw(streamEmbed(p.stream))}</div><p class="small muted">Diffusion avec l'accord du joueur (partenariat StormBet).</p></section>`) : ''}
    <section class="section"><h2 class="skew">Historique en compétition</h2>
      <div class="panel table-wrap"><table><thead><tr><th>Date</th><th>Tournoi</th><th>Format</th><th>Avec</th><th>Place</th><th>Gains</th></tr></thead><tbody>
      ${p.results.map((r) => raw(html`<tr><td>${fmt.date(r.date)}</td><td><a href="#/tournoi/${r.slug}">${r.name}</a></td><td>${MODE_LABEL[r.mode]}</td><td>${r.entry}</td><td class="num">${r.status === 'upcoming' ? raw('<span class="chip upcoming">À venir</span>') : fmt.place(r.placement)}</td><td>${fmt.usd(r.prize_usd)}</td></tr>`))}
      </tbody></table></div>
      ${p.sources.length ? raw(html`<p class="small muted">Sources : ${p.sources.map((s) => raw(html`<a href="${s}" target="_blank" rel="noopener">${new URL(s).hostname}</a> `))}</p>`) : ''}</section>`;
  if (window.innerWidth < 700) document.getElementById('pl').style.gridTemplateColumns = '1fr';
  mountHls();
}

async function pageTeams() {
  const teams = await api('/teams');
  app.innerHTML = html`<h1 class="skew">Équipes</h1><div class="grid cols-3">${teams.map((t) => raw(html`<div class="panel"><h3>${t.name}</h3><p class="muted">${t.players} joueur(s) suivi(s) · Rating moyen <span class="num">${t.rating ?? '—'}</span></p></div>`))}</div>`;
}

async function pageLive() {
  const live = await api('/live');
  app.innerHTML = html`<h1 class="skew">Lives des joueurs</h1>
    <p class="muted">Seuls les joueurs ayant signé un accord de diffusion avec StormBet apparaissent ici.</p>
    ${live.length ? raw(html`<div class="grid cols-3">${live.map((l) => raw(html`<a class="panel row" href="#/joueur/${l.slug}" style="color:#fff">
      <img src="${avatar({ ...l, rating: 1400 })}" width="56" height="56" style="border-radius:12px" alt=""><div><h3 style="margin:0">${l.handle}</h3><span class="chip ${l.isLive ? 'live' : ''}">${l.isLive ? '● En direct' : 'Hors ligne'}</span> <span class="chip">${l.platform}</span></div></a>`))}</div>`)
      : raw('<div class="panel empty">Aucun partenariat de diffusion actif pour le moment.</div>')}`;
}

async function pageWallet() {
  if (!requireLogin()) return pageHome();
  const [w, missions] = await Promise.all([api('/wallet'), api('/missions')]);
  const u = state.me;
  const KIND = { signup_bonus: 'Bonus de bienvenue', daily_drop: 'Ravitaillement', bet_stake: 'Mise', bet_payout: 'Gain', bet_refund: 'Remboursement', shop: 'Boutique', mission: 'Mission', level_up: 'Passage de niveau', rescue: 'Second souffle' };
  app.innerHTML = html`<h1 class="skew">Portefeuille FLUX</h1>
    <div class="grid cols-3">
      <div class="panel holo"><div class="muted">Solde</div><div class="row">${coin(48)}<span class="num" style="font-size:44px">${fmt.flux(w.balance)}</span></div>
        <p class="small muted">Monnaie virtuelle sans valeur monétaire. Non achetable, non retirable.</p>
        ${w.balance < 50 ? raw('<button class="btn purple sm" id="rescue">Second souffle (+250)</button>') : ''}</div>
      <div class="panel drop"><img class="crate" id="crate" src="/img/crate.svg" alt="">
        <div>Ravitaillement quotidien · série <b>${w.daily.streak}</b> jour(s)</div>
        <button class="btn" id="daily" ${w.daily.available ? '' : 'disabled'}>${w.daily.available ? `Ouvrir (+${w.daily.reward})` : 'Reviens demain'}</button></div>
      <div class="panel"><div class="row spread"><span class="level-badge">NIV. ${u.level}</span><span class="muted small">+75 FLUX par niveau</span></div>
        <div class="level-bar"><i style="width:${Math.round(u.levelProgress * 100)}%"></i></div><p class="small muted">1 XP pour 10 FLUX misés</p></div>
    </div>
    <section class="section"><h2 class="skew">Défis</h2><div class="grid cols-2">
      ${missions.map((m) => raw(html`<div class="panel row spread"><div><b>${m.title}</b><div class="small muted">${m.period === 'day' ? 'Quotidien' : 'Hebdomadaire'} · ${m.progress}/${m.goal}</div>
        <div class="level-bar" style="width:220px;height:8px;margin-top:6px"><i style="width:${(m.progress / m.goal) * 100}%"></i></div></div>
        <button class="btn sm" data-mission="${m.id}" ${m.claimed || m.progress < m.goal ? 'disabled' : ''}>${m.claimed ? 'Récupéré' : `+${m.reward}`}</button></div>`))}
    </div></section>
    <section class="section"><h2 class="skew">Historique</h2><div class="panel table-wrap"><table><thead><tr><th>Date</th><th>Opération</th><th>Montant</th><th>Solde</th></tr></thead><tbody>
      ${w.transactions.map((t) => raw(html`<tr><td>${fmt.datetime(t.createdAt + 'Z')}</td><td>${KIND[t.kind] || t.kind}</td><td class="num ${t.amount > 0 ? 'pos' : 'neg'}">${t.amount > 0 ? '+' : ''}${fmt.flux(t.amount)}</td><td class="num">${fmt.flux(t.balanceAfter)}</td></tr>`))}
    </tbody></table></div></section>`;
  document.getElementById('daily').onclick = async () => {
    try {
      document.getElementById('crate').classList.add('open');
      const r = await api('/wallet/daily', { method: 'POST', body: {} });
      toast(`Ravitaillement : +${r.reward} FLUX !`, 'win');
      await refreshMe();
      setTimeout(route, 700);
    } catch (err) { toast(err.message, 'bad'); }
  };
  const rescue = document.getElementById('rescue');
  if (rescue) rescue.onclick = async () => { try { await api('/wallet/rescue', { method: 'POST', body: {} }); await refreshMe(); route(); } catch (err) { toast(err.message, 'bad'); } };
  app.querySelectorAll('[data-mission]').forEach((b) => (b.onclick = async () => {
    try { await api(`/missions/${b.dataset.mission}/claim`, { method: 'POST', body: {} }); toast('Défi accompli !', 'win'); await refreshMe(); route(); } catch (err) { toast(err.message, 'bad'); }
  }));
}

async function pageBets() {
  if (!requireLogin()) return pageHome();
  const bets = await api('/bets');
  const ST = { open: ['En cours', 'upcoming'], won: ['Gagné', 'win'], lost: ['Perdu', 'completed'], void: ['Remboursé', 'completed'] };
  app.innerHTML = html`<h1 class="skew">Mes paris</h1>
    ${bets.length ? raw(bets.map((b) => html`<div class="panel" style="margin-bottom:12px">
      <div class="row spread"><span class="chip ${ST[b.status][1]}" style="${b.status === 'won' ? 'background:var(--ok);color:#002' : ''}">${ST[b.status][0]}</span>
        <span class="small muted">${fmt.datetime(b.createdAt + 'Z')}</span></div>
      ${b.legs.map((l) => raw(html`<div class="row spread" style="margin-top:8px"><div><b>${l.selection}</b> <span class="muted">— ${l.market}</span><br><a class="small" href="#/tournoi/${l.tournamentSlug}">${l.tournament}</a>
        ${b.status === 'open' && l.playerSlug ? raw(html` · <a class="small" href="#/joueur/${l.playerSlug}">📺 Regarder</a>`) : ''}</div><span class="num" style="color:var(--gold)">${fmt.odds(l.odds)}</span></div>`))}
      <div class="row spread" style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><span>Mise <b class="num">${fmt.flux(b.stake)}</b> · Cote <b class="num">${fmt.odds(b.totalOdds)}</b></span>
        <span>${b.status === 'open' ? 'Gain potentiel' : 'Gain'} <b class="num" style="color:var(--gold)">${fmt.flux(b.status === 'open' ? b.potentialPayout : b.payout)}</b></span></div></div>`).join(''))
      : raw('<div class="panel empty">Aucun pari pour l’instant. <a href="#/tournois">Choisis un tournoi</a> !</div>')}`;
}

async function pageShop() {
  const items = await api('/shop');
  const preview = (i) => i.kind === 'frame' ? `<div class="frame-preview" style="color:${esc(i.data.color)};border-color:${esc(i.data.color)}"></div>`
    : i.kind === 'banner' ? `<div style="width:80%;height:70px;border-radius:10px;background:${esc(i.data.gradient)}"></div>`
    : `<div class="title-preview">${esc(i.data.text)}</div>`;
  const equipped = Object.values(state.me?.equipped || {}).filter(Boolean).map((i) => i.id);
  app.innerHTML = html`<h1 class="skew">Boutique d'objets</h1><p class="muted">Cosmétiques de profil, uniquement en FLUX. Ils s'affichent au classement.</p>
    <div class="grid cards">${items.map((i) => raw(html`<div class="item r-${i.rarity}"><div class="preview">${raw(preview(i))}</div>
      <div class="meta"><b>${i.name}</b><span class="small">${RARITY_LABEL[i.rarity]}</span>
      <div style="margin-top:8px">${i.owned
        ? raw(html`<button class="btn blue sm" data-equip="${i.id}" ${equipped.includes(i.id) ? 'disabled' : ''}>${equipped.includes(i.id) ? 'Équipé' : 'Équiper'}</button>`)
        : raw(html`<button class="btn sm" data-buy="${i.id}">${coin(18)} ${fmt.flux(i.price)}</button>`)}</div></div></div>`))}</div>`;
  app.querySelectorAll('[data-buy]').forEach((b) => (b.onclick = async () => {
    if (!requireLogin()) return;
    try { await api(`/shop/${b.dataset.buy}/buy`, { method: 'POST', body: {} }); toast('Objet débloqué !', 'win'); await refreshMe(); route(); } catch (err) { toast(err.message, 'bad'); }
  }));
  app.querySelectorAll('[data-equip]').forEach((b) => (b.onclick = async () => {
    try { await api(`/shop/${b.dataset.equip}/equip`, { method: 'POST', body: {} }); await refreshMe(); route(); } catch (err) { toast(err.message, 'bad'); }
  }));
}

async function pageLeaderboard() {
  const rows = await api('/leaderboard');
  app.innerHTML = html`<h1 class="skew">Classement des parieurs</h1><div class="panel table-wrap"><table><thead><tr><th>#</th><th>Joueur</th><th>Niveau</th><th>Paris gagnés</th><th>Bénéfice</th><th>Solde</th></tr></thead><tbody>
    ${rows.map((r, i) => raw(html`<tr><td class="num">${i + 1}</td><td><span style="display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;background:${r.frame?.data.color || 'transparent'}"></span><b>${r.username}</b> ${r.title ? raw(html`<span class="chip">${r.title.data.text}</span>`) : ''}</td>
      <td class="num">${r.level}</td><td class="num">${r.wins}</td><td class="num ${r.profit >= 0 ? 'pos' : 'neg'}">${fmt.flux(r.profit)}</td><td class="num">${fmt.flux(r.balance)}</td></tr>`))}
    </tbody></table></div>`;
}

function pageRules() {
  const e = state.config?.economy || {};
  app.innerHTML = html`<h1 class="skew">Règles & FAQ</h1><div class="grid cols-2">
    <div class="panel"><h3>Les FLUX</h3><p>Monnaie <b>100 % virtuelle</b>. Elle ne peut <b>ni être achetée, ni être convertie en argent, ni être retirée</b>. Elle se gagne : ${e.signupBonus} à l'inscription, ravitaillement quotidien (${e.dailyBase} + ${e.dailyStreakStep} par jour de série, jusqu'à 7 jours), défis, passages de niveau et paris gagnants.</p></div>
    <div class="panel"><h3>Les cotes</h3><p>Chaque joueur reçoit une <b>Storm Rating</b> calculée à partir de ses résultats officiels (pondérés par prestige et récence), de ses gains en carrière et de ses points Power Ranking. Nous simulons ensuite 20 000 fois le tournoi pour obtenir les probabilités, puis appliquons une petite marge.</p></div>
    <div class="panel"><h3>Types de paris</h3><p><b>Vainqueur</b>, <b>Podium</b>, <b>Top 10</b> et <b>Duels</b> (qui finit devant l'autre). Les <b>combinés</b> multiplient les cotes de sélections de tournois différents. Mise de ${e.minStake} à ${fmt.flux(e.maxStake)} FLUX.</p></div>
    <div class="panel"><h3>Règlement</h3><p>Les paris sont réglés sur le classement officiel. Un joueur absent des résultats publiés est considéré comme classé derrière. Duel à égalité ou tournoi annulé : mise remboursée.</p></div>
    <div class="panel"><h3>Jeu responsable</h3><p>Réservé aux 18 ans et plus. Même sans argent réel, si le jeu prend trop de place : <a href="https://www.joueurs-info-service.fr" target="_blank" rel="noopener">Joueurs Info Service</a> — 09 74 75 13 13.</p></div>
    <div class="panel"><h3>Indépendance</h3><p>StormBet n'est ni approuvé ni affilié à Epic Games. Les lives proviennent uniquement de joueurs ayant signé un accord de diffusion.</p></div></div>`;
}

// ============================================================ Router
const routes = [
  [/^\/?$/, pageHome, 'home'],
  [/^\/tournois$/, pageTournaments, 'tournois'],
  [/^\/tournoi\/([\w-]+)$/, pageTournament, 'tournois'],
  [/^\/joueurs$/, pagePlayers, 'joueurs'],
  [/^\/joueur\/([\w-]+)$/, pagePlayer, 'joueurs'],
  [/^\/equipes$/, pageTeams, 'equipes'],
  [/^\/live$/, pageLive, 'live'],
  [/^\/portefeuille$/, pageWallet, ''],
  [/^\/mes-paris$/, pageBets, 'mes-paris'],
  [/^\/boutique$/, pageShop, 'boutique'],
  [/^\/classement$/, pageLeaderboard, 'classement'],
  [/^\/regles$/, pageRules, ''],
  [/^\/admin$/, () => renderAdmin(app), ''],
];

async function route() {
  cleanup.forEach((fn) => fn());
  cleanup = [];
  slipOpen = false;
  const path = location.hash.replace(/^#/, '') || '/';
  const [re, fn, nav] = routes.find(([r]) => r.test(path)) || routes[0];
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
  try {
    await fn(...(path.match(re) || []).slice(1));
  } catch (err) {
    app.innerHTML = html`<div class="panel empty">${err.status === 404 ? 'Page introuvable.' : err.message}</div>`;
  }
  renderSlip();
}

window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });
state.config = await api('/config');
await refreshMe();
route();
