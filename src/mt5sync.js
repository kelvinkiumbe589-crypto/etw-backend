// MT5 / MT4 sync engine (via MetaApi.cloud).
// Deploys the account, then imports closed trades using an RPC connection
// (getDealsByTimeRange) — more reliable than the streaming historyStorage — and
// re-polls periodically for new trades. Status is written to
// users/{uid}.mt5Direct so the frontend can watch it live.
//
// SDK: targets metaapi.cloud-sdk v27. Version-sensitive calls are flagged "SDK:".

const MetaApi = require('metaapi.cloud-sdk').default;
const { buildTradesFromDeals } = require('./tradeMapper');
const store = require('./store');

const STATUS_KEY = 'mt5Direct';
let api = null;
const active = new Map(); // uid -> { account, rpc, timer, written, ... }

function init() {
  const token = process.env.METAAPI_TOKEN;
  if (!token) throw new Error('METAAPI_TOKEN env var is required.');
  api = new MetaApi(token, process.env.METAAPI_REGION ? { region: process.env.METAAPI_REGION } : {});
}

const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);

async function findOrCreateAccount({ uid, login, password, server, platform }) {
  try {
    const acApi = api.metatraderAccountApi;
    // SDK name varies by version: v27 uses getAccountsWithInfiniteScrollPagination / -ClassicPagination.
    const lister = acApi.getAccountsWithInfiniteScrollPagination || acApi.getAccountsWithClassicPagination || acApi.getAccounts;
    if (lister) {
      const res = await lister.call(acApi, {});
      const list = Array.isArray(res) ? res : (res && (res.items || res.accounts)) || [];
      const found = list.find(a => String(a.login) === String(login) && a.server === server);
      if (found) return found;
    }
  } catch (e) { console.warn('account lookup skipped:', e.message); }
  return api.metatraderAccountApi.createAccount({ // SDK:
    name: `etw-${uid}-${login}`.slice(0, 64),
    // cloud-g1 supports the cheaper "regular" reliability; cloud-g2 is high-reliability only.
    type: process.env.METAAPI_ACCOUNT_TYPE || 'cloud-g1',
    login: String(login),
    password,
    server,
    platform: platform === 'mt4' ? 'mt4' : 'mt5',
    magic: 0,
    application: 'MetaApi',
    reliability: process.env.METAAPI_RELIABILITY || 'regular',
  });
}

async function fetchDeals(rpc) {
  const start = new Date(Date.UTC(2015, 0, 1));
  const end = new Date(Date.now() + 24 * 3600 * 1000);
  const res = await rpc.getDealsByTimeRange(start, end); // SDK:
  return (res && res.deals) || (Array.isArray(res) ? res : []);
}

async function syncOnce(sync) {
  const deals = await fetchDeals(sync.rpc);
  const trades = buildTradesFromDeals(deals, { uid: sync.uid, accountId: sync.accountId })
    .map(t => ({ ...t, source: sync.source }));
  const fresh = trades.filter(t => !sync.written.has(String(t.ticket)));
  if (fresh.length) { await store.writeTrades(fresh); fresh.forEach(t => sync.written.add(String(t.ticket))); }
  await setStatus(sync.uid, {
    status: 'connected', platform: sync.platform, login: String(sync.login || ''), server: sync.server || '',
    metaApiAccountId: sync.account.id, historyImported: sync.written.size, lastSyncAt: Date.now(), error: null,
  });
  console.log(`mt5 sync (uid ${sync.uid}): ${deals.length} deals, +${fresh.length} new trades, ${sync.written.size} total`);
  return fresh.length;
}

async function _connectAndSync(sync) {
  console.log(`mt5: deploying account ${sync.account.id}`);
  await sync.account.deploy();
  await sync.account.waitConnected();
  console.log('mt5: broker connected, opening RPC connection');
  sync.rpc = sync.account.getRPCConnection();
  await sync.rpc.connect();
  await sync.rpc.waitSynchronized();
  console.log('mt5: RPC synchronized, importing deals');
  await syncOnce(sync);
  sync.timer = setInterval(() => { syncOnce(sync).catch(e => console.error('mt5 poll error:', e.message)); }, 60000);
  active.set(sync.uid, sync);
}

async function startSync({ uid, login, password, server, accountId, platform }) {
  await stopSync(uid, { forget: false }).catch(() => {});
  console.log(`mt5 startSync: uid ${uid}, login ${login}, server ${server}`);
  const account = await findOrCreateAccount({ uid, login, password, server, platform });
  const source = (platform === 'mt4' ? 'mt4' : 'mt5') + '-direct';
  const sync = {
    uid, login, server, accountId: accountId || '', platform: platform === 'mt4' ? 'mt4' : 'mt5',
    source, account, written: await store.existingTickets(uid, source),
  };
  await _connectAndSync(sync);
  return true;
}

async function stopSync(uid, { forget } = {}) {
  const sync = active.get(uid);
  if (!sync) return;
  if (sync.timer) clearInterval(sync.timer);
  try { if (sync.rpc) await sync.rpc.close(); } catch (e) {}
  if (forget) {
    try { await sync.account.undeploy(); } catch (e) {}
    try { await sync.account.remove(); } catch (e) {}
    await store.setStatus(uid, STATUS_KEY, { metaApiAccountId: null });
  }
  active.delete(uid);
}

// After a process restart, re-attach to every previously-connected user (no password needed).
async function resumeAll() {
  try {
    const snap = await store.db.collection('users').where('mt5Direct.status', '==', 'connected').get();
    for (const doc of snap.docs) {
      const d = doc.data().mt5Direct || {};
      if (!d.metaApiAccountId) continue;
      const uid = doc.id;
      try {
        const account = await api.metatraderAccountApi.getAccount(d.metaApiAccountId); // SDK:
        const platform = d.platform === 'mt4' ? 'mt4' : 'mt5';
        const source = platform + '-direct';
        const sync = { uid, login: d.login, server: d.server, accountId: '', platform, source, account, written: await store.existingTickets(uid, source) };
        await _connectAndSync(sync);
        console.log('resumed MT sync for', uid);
      } catch (e) { console.error('resume failed for', uid, '-', e.message); }
    }
  } catch (e) { console.error('resumeAll failed:', e.message); }
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/METAAPI_TOKEN/i.test(m)) return m;
  if (/top up|balance/i.test(m)) return 'MetaApi balance too low to deploy this account — top up at app.metaapi.cloud.';
  if (/token/i.test(m) && /metaapi|auth/i.test(m)) return 'MetaApi token invalid or expired — check METAAPI_TOKEN.';
  if (/server/i.test(m) && /not found|unknown|invalid/i.test(m)) return 'Server name not found. Copy it exactly from your terminal / prop dashboard.';
  if (/password|invalid account|authorization failed|login/i.test(m)) return 'Login or password was rejected by the broker.';
  return 'Could not connect: ' + m;
}

module.exports = { init, startSync, stopSync, resumeAll, setStatus, friendlyError };
