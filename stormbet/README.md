# ⚡ StormBet — paris esport Fortnite en monnaie virtuelle

Site de pronostics sur les **compétitions Fortnite officielles** (FNCS, Majors, Global Championship) :
on parie des **FLUX**, une monnaie 100 % virtuelle, sur des joueurs ou des équipes. Univers
« Chapitre 1 » (ciel bleu, bus, tempête violette, raretés d'objets) avec une couche futuriste
(néons, grille holographique).

```
npm install
cp .env.example .env        # optionnel : clés API, admin…
ADMIN_USERNAMES=jremy77 npm start   # http://localhost:3000
npm test                    # 10 tests (cotes, économie, paris, lives, import)
```

Node 22+ (utilise `node:sqlite`, aucune dépendance native). Les vidéos sont dans `video/out/`.

---

## 1. Collecte des données

`npm run ingest` (et automatiquement toutes les `INGEST_INTERVAL_MIN` minutes) enchaîne :

| Source | Ce qu'on récupère | Accès |
|---|---|---|
| `data/seed.json` | Résultats 2019-2026 déjà vérifiés (Global Championship 2024/2025/2026, Majors 2026, Solo Major d'octobre 2026) avec leurs URLs sources | inclus |
| **Liquipedia** (LPDB v3) — le wiki qui a repris les pages esport Gamepedia/Fandom | Tous les tournois tier 1-2 depuis 400 jours, classements, joueurs, pays, équipes | `LIQUIPEDIA_API_KEY` (gratuit sur demande) |
| **Fortnite Tracker** (TRN) | Points Power Ranking de chaque joueur | `TRN_API_KEY` |
| **Esports Earnings** | Gains en carrière, pays | `ESPORTS_EARNINGS_API_KEY` |
| **Twitch** | Photos de profil publiées par les joueurs + statut live des partenaires | `TWITCH_CLIENT_ID/SECRET` |

Chaque source est optionnelle : sans clé, l'étape est sautée et notée dans le journal (page Admin).
Les données sont fusionnées par pseudo (alias gérés), donc relancer l'import est sans risque.
Epic Games ne publie pas d'API publique pour la compétition : les résultats officiels passent
par Liquipedia, qui les reprend (licence CC-BY-SA : les liens sources sont affichés sur le site).

> Le scraping direct des pages HTML (fortnitetracker.com, fortnite.com…) n'est pas utilisé :
> leurs conditions d'utilisation l'interdisent et les API officielles ci-dessus donnent les mêmes données.

## 2. Niveau des joueurs et cotes automatiques

`server/odds/rating.js` — **Storm Rating** de chaque joueur :
- chaque résultat officiel → score de performance `1 − ln(place)/ln(taille du champ)` ;
- pondéré par le prestige (Global Championship/World Cup ×1,6, Major ×1, qualifs ×0,45, cash cups ×0,3)
  et la récence (demi-vie 180 jours) ;
- rapproché d'un a priori construit avec les gains en carrière et les points Power Ranking
  (évite qu'un joueur avec un seul résultat soit sur-coté) ;
- un indice de **fiabilité** indique la quantité de données derrière la note.

`server/odds/markets.js` — pour chaque tournoi à venir, **20 000 simulations** (modèle
Plackett-Luce) donnent pour chaque joueur/équipe la probabilité de gagner, de finir dans le top 3,
le top 10, et de finir devant chaque adversaire. Cotes = `1 / (probabilité × (1 + marge))`
(marges : vainqueur 12 %, podium 10 %, top 10 8 %, duels 5 %), arrondies sur une échelle de
bookmaker. Marchés : **Vainqueur, Podium, Top 10, Duels**. Les paris placés gardent leur cote ;
le ticket détecte si une cote a bougé.

Duo/trio : moyenne des notes des joueurs + bonus d'alchimie s'ils ont déjà joué ensemble.

## 3. Le site

Pages : accueil (héros + compte à rebours + favoris), tournois, détail d'un tournoi (marchés,
participants, sources), joueurs (cartes de rareté façon boutique d'objets), fiche joueur
(historique, forme, live), équipes, lives, portefeuille, défis, boutique, classement, mes paris,
règles/FAQ, administration. Responsive mobile.

## 4. Monnaie FLUX (`server/economy.js`)

- **Grand livre** : chaque mouvement est une ligne de `transactions` avec le solde après opération.
- Gains : 1 000 FLUX à l'inscription, **ravitaillement quotidien** (100 + 25/jour de série, 7 jours max),
  **défis** quotidiens/hebdomadaires, **niveaux** (1 XP / 10 FLUX misés, +75 FLUX par niveau),
  « second souffle » (+250 si le solde tombe sous 50, 1×/24 h), paris gagnants.
- Dépenses : paris (10 à 50 000 FLUX, simples ou combinés), **boutique de cosmétiques**
  (cadres, bannières, titres, 5 raretés) affichés au classement.
- **Pas d'achat, pas de retrait.** C'est ce qui garde le site hors du cadre des jeux d'argent :
  dès que des FLUX pourraient s'acheter ou s'échanger contre de l'argent, il faudrait un
  agrément ANJ (France). Réservé aux 18+ quand même (case obligatoire à l'inscription).

## 5. Photos des joueurs

Ordre de priorité : photo de profil **publiée par le joueur sur Twitch** (récupérée à l'import
avec son login Twitch), sinon URL saisie dans l'admin avec son crédit, sinon un avatar généré
(initiales sur la couleur de sa rareté). Le crédit de la photo est affiché sur la fiche.
Les photos ne sont pas copiées dans le dépôt : utiliser l'image de quelqu'un pour une
activité commerciale demande son accord (droit à l'image) — à inclure dans le contrat partenaire.

## 6. Lives des joueurs (avec leur accord)

Important : **une clé de stream sert à diffuser, pas à regarder.** Un joueur ne doit jamais
donner sa clé Twitch/YouTube : quiconque l'a peut streamer sur sa chaîne. Deux options, gérées
dans Admin → Partenariats :

1. **Chaîne publique** (Twitch, YouTube, Kick) : on enregistre juste le nom de la chaîne et la
   référence du contrat signé ; le site intègre le lecteur officiel. Rien de secret à stocker.
2. **Serveur StormBet** (`mediamtx.yml`) : c'est **nous** qui générons une clé par joueur
   (affichée une seule fois, seule son empreinte SHA-256 est stockée, révocable). Le joueur
   l'ajoute dans OBS (service « Personnalisé ») ; MediaMTX vérifie la clé auprès de
   `/api/media/auth` et le site lit le flux HLS.

Sans accord marqué « signé » avec une référence de contrat, aucun live n'est affiché.
Sur « Mes paris », un lien **Regarder** mène au live du joueur parié.

## 7. Vidéos

`video/out/stormbet-pub-60s.mp4` (présentation A→Z) et `video/out/stormbet-teaser-15s.mp4`.
Présentatrice animée « Nova » (synchronisation des lèvres sur la voix), voix off française
douce générée localement (Piper TTS, voix *siwis*, ralentie, réchauffée, légère réverbération),
musique d'ambiance originale synthétisée, sous-titres incrustés. Pour les régénérer :

```
npm start &                                   # site lancé avec ADMIN_USERNAMES=admin
node video/capture.mjs                        # captures d'écran du vrai site
PIPER_BIN=…/piper PIPER_VOICES=…/voices node video/voice.mjs
node video/render.mjs promo && node video/render.mjs teaser
```

Le texte est dans `video/script.json`. Pour une version avec une **vraie personne** à l'écran,
voir `docs/script-video.md` (script de tournage plan par plan).

## Mise en production

`NODE_ENV=production` (cookies `Secure`), HTTPS devant (Caddy/Nginx), `PUBLIC_HOSTNAME` défini
(exigé par l'embed Twitch), sauvegarde régulière de `data/stormbet.sqlite`.

---
Site indépendant, non affilié à Epic Games. Fortnite est une marque d'Epic Games, Inc.
