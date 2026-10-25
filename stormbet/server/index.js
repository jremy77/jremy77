import { openDb } from './db.js';
import { createApp } from './app.js';
import { runIngest, refreshStatuses } from './ingest/index.js';

const db = openDb();
const port = Number(process.env.PORT) || 3000;

if (!db.prepare('SELECT COUNT(*) n FROM players').get().n) await runIngest(db, { sources: ['seed'] });

createApp(db).listen(port, () => console.log(`StormBet sur http://localhost:${port}`));

// Periodic refresh: full ingestion every INGEST_INTERVAL_MIN minutes (default 60),
// and every minute close markets that started / settle finished events.
const every = Number(process.env.INGEST_INTERVAL_MIN ?? 60);
if (every > 0) setInterval(() => runIngest(db).catch((e) => console.error('[ingest]', e)), every * 60000);
setInterval(() => { try { refreshStatuses(db); } catch (e) { console.error('[refresh]', e); } }, 60000);
