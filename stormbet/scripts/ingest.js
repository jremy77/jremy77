// npm run ingest [-- seed liquipedia ...]
import { openDb } from '../server/db.js';
import { runIngest } from '../server/ingest/index.js';

const db = openDb();
const sources = process.argv.slice(2);
await runIngest(db, sources.length ? { sources } : undefined);
const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
console.log(`players=${count('players')} tournaments=${count('tournaments')} markets=${count('markets')}`);
