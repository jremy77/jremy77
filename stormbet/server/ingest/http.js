// Polite HTTP client shared by the adapters: identifies itself, respects a
// per-host minimum interval and retries transient errors.
const lastCall = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const USER_AGENT =
  process.env.INGEST_USER_AGENT || 'StormBetIngest/1.0 (+https://github.com/jremy77/jremy77; contact: set INGEST_USER_AGENT)';

export async function getJson(url, { headers = {}, minIntervalMs = 2000, retries = 3 } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    const wait = (lastCall.get(host) || 0) + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip', Accept: 'application/json', ...headers } });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt);
      continue;
    }
    throw new Error(`${res.status} ${res.statusText} on ${url}`);
  }
}

export async function postForm(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on ${url}`);
  return res.json();
}
