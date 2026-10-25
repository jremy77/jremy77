import { state, api, html, raw, fmt, toast, modal } from './core.js';

export async function renderAdmin(app) {
  if (state.me?.role !== 'admin') {
    app.innerHTML = '<div class="panel empty">Réservé aux administrateurs (variable ADMIN_USERNAMES).</div>';
    return;
  }
  const [o, tournaments, players] = await Promise.all([api('/admin/overview'), api('/tournaments'), api('/players')]);
  const playerOptions = players.map((p) => html`<option value="${p.slug}">${p.handle}</option>`).join('');
  app.innerHTML = html`<h1 class="skew">Administration</h1>
    <div class="grid cols-3">
      <div class="panel"><div class="muted">Comptes</div><div class="num" style="font-size:30px">${o.users.n}</div><div class="small muted">FLUX en circulation : ${fmt.flux(o.users.supply)}</div></div>
      <div class="panel"><div class="muted">Paris ouverts</div><div class="num" style="font-size:30px">${o.openBets.n}</div><div class="small muted">Mises en jeu : ${fmt.flux(o.openBets.staked)}</div></div>
      <div class="panel"><div class="muted">Données</div><button class="btn blue" id="ingest">Lancer l'import</button><div class="small muted">Liquipedia · Fortnite Tracker · Esports Earnings · Twitch</div></div>
    </div>

    <section class="section"><h2>Journal d'import</h2><div class="panel table-wrap"><table><thead><tr><th>Date</th><th>Source</th><th>Statut</th><th>Détail</th></tr></thead><tbody>
      ${o.runs.map((r) => raw(html`<tr><td>${fmt.datetime(r.started_at + 'Z')}</td><td>${r.source}</td><td>${r.status}</td><td class="small">${r.detail}</td></tr>`))}</tbody></table></div></section>

    <section class="section"><h2>Partenariats de diffusion</h2>
      <div class="panel"><p class="small muted">Pour Twitch / YouTube / Kick : renseigne seulement le <b>nom public de la chaîne</b> (ID de chaîne pour YouTube). Ne demande jamais la clé de stream d'un joueur : elle permet de diffuser à sa place. Pour le serveur RTMP StormBet, c'est nous qui générons la clé.</p>
      <form id="partner" class="grid cols-3">
        <div><label>Joueur</label><select name="playerSlug">${raw(playerOptions)}</select></div>
        <div><label>Plateforme</label><select name="platform"><option>twitch</option><option>youtube</option><option>kick</option><option value="rtmp">rtmp (serveur StormBet)</option></select></div>
        <div><label>Chaîne</label><input name="channel" placeholder="nom de la chaîne"></div>
        <div><label>Statut de l'accord</label><select name="consentStatus"><option value="pending">En attente</option><option value="accepted">Signé</option><option value="revoked">Révoqué</option></select></div>
        <div><label>Signé le</label><input name="consentSignedAt" type="date"></div>
        <div><label>Référence du contrat</label><input name="consentReference" placeholder="ex. CTR-2026-014"></div>
        <div><button class="btn" type="submit">Enregistrer</button></div>
      </form></div>
      <div class="panel table-wrap" style="margin-top:12px"><table><thead><tr><th>Joueur</th><th>Plateforme</th><th>Chaîne</th><th>Accord</th><th>Live</th><th></th></tr></thead><tbody>
        ${o.partners.map((p) => raw(html`<tr><td>${p.handle}</td><td>${p.platform}</td><td>${p.channel || '—'}</td><td>${p.consent_status} ${p.consent_reference ? `(${p.consent_reference})` : ''}</td><td>${p.is_live ? '●' : ''}</td>
          <td>${p.platform === 'rtmp' && p.consent_status === 'accepted' ? raw(html`<button class="btn sm purple" data-key="${p.slug}">${p.hasKey ? `Régénérer la clé (…${p.ingest_key_hint})` : 'Générer la clé'}</button>`) : ''}</td></tr>`))}
      </tbody></table></div></section>

    <section class="section"><h2>Photo d'un joueur</h2><form id="avatar" class="panel grid cols-3">
      <div><label>Joueur</label><select name="slug">${raw(playerOptions)}</select></div>
      <div><label>URL de la photo publiée</label><input name="avatarUrl" placeholder="https://…"></div>
      <div><label>Crédit / source</label><input name="avatarCredit" placeholder="ex. Twitch — Bugha"></div>
      <div><label>Login Twitch (photo auto à l'import)</label><input name="twitch"></div>
      <div><button class="btn" type="submit">Enregistrer</button></div></form></section>

    <section class="section"><h2>Saisir des résultats / annuler</h2><div class="panel">
      <select id="tsel">${tournaments.filter((t) => t.status !== 'completed').map((t) => raw(html`<option value="${t.slug}">${t.name}</option>`))}</select>
      <button class="btn sm" id="tload">Charger</button><div id="tres"></div></div></section>`;

  document.getElementById('ingest').onclick = async (e) => {
    e.target.disabled = true;
    try { await api('/admin/ingest', { method: 'POST', body: {} }); toast('Import terminé'); renderAdmin(app); } catch (err) { toast(err.message, 'bad'); e.target.disabled = false; }
  };
  document.getElementById('partner').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/admin/streams', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Partenariat enregistré'); renderAdmin(app); } catch (err) { toast(err.message, 'bad'); }
  };
  document.getElementById('avatar').onsubmit = async (e) => {
    e.preventDefault();
    const { slug, ...body } = Object.fromEntries(new FormData(e.target));
    Object.keys(body).forEach((k) => body[k] === '' && delete body[k]);
    try { await api(`/admin/players/${slug}`, { method: 'PATCH', body }); toast('Joueur mis à jour'); } catch (err) { toast(err.message, 'bad'); }
  };
  app.querySelectorAll('[data-key]').forEach((b) => (b.onclick = async () => {
    try {
      const r = await api(`/admin/streams/${b.dataset.key}/key`, { method: 'POST', body: {} });
      modal(html`<h2>Clé de diffusion</h2><p>Dans OBS → Paramètres → Stream → <b>Personnalisé</b> :</p>
        <label>Serveur</label><input readonly value="${r.server}" style="width:100%"><label>Clé de stream</label><input readonly value="${r.streamPath}" style="width:100%">
        <p class="small muted">${r.note}</p><button class="btn" data-close>J'ai copié la clé</button>`);
    } catch (err) { toast(err.message, 'bad'); }
  }));
  document.getElementById('tload').onclick = async () => {
    const slug = document.getElementById('tsel').value;
    if (!slug) return;
    const t = await api(`/tournaments/${slug}`);
    const box = document.getElementById('tres');
    box.innerHTML = html`<form id="resform"><div class="table-wrap"><table><thead><tr><th>Participant</th><th>Place</th><th>Points</th></tr></thead><tbody>
      ${t.entries.map((e) => raw(html`<tr><td>${e.name}</td><td><input type="number" min="1" name="p${e.id}" value="${e.placement ?? ''}" style="width:90px"></td><td><input type="number" name="s${e.id}" value="${e.points ?? ''}" style="width:90px"></td></tr>`))}
      </tbody></table></div><div class="row" style="margin-top:10px"><button class="btn" type="submit">Valider & régler les paris</button><button class="btn ghost" type="button" id="tvoid">Annuler le tournoi (rembourser)</button></div></form>`;
    box.querySelector('#resform').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const results = t.entries.map((en) => ({ entryId: en.id, placement: Number(f.get(`p${en.id}`)) || null, points: Number(f.get(`s${en.id}`)) || null })).filter((r) => r.placement);
      try { const r = await api(`/admin/tournaments/${t.id}/results`, { method: 'POST', body: { results } }); toast(`${r.settled} pari(s) réglé(s)`); renderAdmin(app); } catch (err) { toast(err.message, 'bad'); }
    };
    box.querySelector('#tvoid').onclick = async () => {
      if (!confirm('Annuler ce tournoi et rembourser tous les paris ?')) return;
      try { const r = await api(`/admin/tournaments/${t.id}/void`, { method: 'POST', body: {} }); toast(`${r.settled} pari(s) remboursé(s)`); renderAdmin(app); } catch (err) { toast(err.message, 'bad'); }
    };
  };
}
