// Captures the screens used by the promo videos from a running StormBet
// (default http://localhost:3000, started with ADMIN_USERNAMES=admin).
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = new URL('./build/shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const go = async (hash) => { await page.goto(`${BASE}/#${hash}`); await page.waitForTimeout(1200); };
const hideToasts = () => page.evaluate(() => document.getElementById('toasts').replaceChildren());

await go('/');
await page.evaluate(() => document.querySelectorAll('.hero .bus').forEach((b) => (b.style.animationDelay = '-8s')));
await shot('home');
await page.evaluate(() => window.scrollTo(0, 620)); await page.waitForTimeout(400); await shot('home-cards');

await page.click('[data-auth=register]');
await page.fill('input[name=username]', `Nova${Date.now() % 10000}`);
await page.fill('input[name=password]', 'stormbet-demo-2026');
await page.check('input[name=adult]');
await shot('register');
await page.click('button[type=submit]');
await page.waitForTimeout(900);

await go('/portefeuille'); await hideToasts(); await shot('wallet');
await go('/tournois'); await shot('tournaments');
await go('/tournoi/fncs-2026-solo-major-eu'); await page.evaluate(() => window.scrollTo(0, 470)); await page.waitForTimeout(300); await shot('odds');
await page.click('.tabs button[data-tab=h2h]'); await page.waitForTimeout(300); await shot('h2h');
await page.click('.odd >> nth=0');
await page.click('.tabs button[data-tab=winner]');
await page.waitForTimeout(300);
await page.goto(`${BASE}/#/tournoi/fncs-2026-solo-major-nac`); await page.waitForTimeout(1000);
await page.evaluate(() => window.scrollTo(0, 470));
await page.click('.odd >> nth=0'); await page.waitForTimeout(300);
await page.fill('#stake', '250'); await page.dispatchEvent('#stake', 'input');
await shot('slip');
await page.click('[data-place]'); await page.waitForTimeout(1000); await shot('placed');
await go('/mes-paris'); await hideToasts(); await shot('bets');
await go('/joueur/swizzy'); await shot('player');
await go('/portefeuille'); await page.click('#daily'); await page.waitForTimeout(400); await shot('drop');
await page.waitForTimeout(1200); await hideToasts();
await page.evaluate(() => window.scrollTo(0, 380)); await page.waitForTimeout(300); await shot('missions');
await go('/boutique'); await shot('shop');
await go('/classement'); await shot('leaderboard');
await go('/joueurs'); await shot('players');
await browser.close();
console.log('shots in', OUT);
