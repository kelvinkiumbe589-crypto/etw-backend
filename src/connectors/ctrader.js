// cTrader connector (Spotware Open API, OAuth2).
// App-level Client ID/Secret come from https://openapi.ctrader.com (env vars).
// Each user authorises via OAuth; we store their tokens + linked accounts under
// users/{uid}.ctrader.
//
// STATUS: OAuth + account linking are implemented. Pulling actual deal history
// requires the cTrader Open API (Protobuf over TLS, demo/live.ctraderapi.com:5035),
// which needs the `@reiryoku/ctrader-layer` lib + a test account to verify — that
// step is marked TODO(openapi) below.
const crypto = require('crypto');
const store = require('../store');

const STATUS_KEY = 'ctrader';
const AUTH_BASE = 'https://openapi.ctrader.com';
const ACCOUNTS_URL = 'https://api.spotware.com/connect/tradingaccounts';
const pendingStates = new Map(); // state -> { uid, ts }

let CLIENT_ID = '', CLIENT_SECRET = '', REDIRECT_URI = '';

function init() {
  CLIENT_ID = process.env.CTRADER_CLIENT_ID || '';
  CLIENT_SECRET = process.env.CTRADER_CLIENT_SECRET || '';
  REDIRECT_URI = process.env.CTRADER_REDIRECT_URI || '';
}
function configured() { return !!(CLIENT_ID && CLIENT_SECRET && REDIRECT_URI); }
const setStatus = (uid, patch) => store.setStatus(uid, STATUS_KEY, patch);

// Step 1 — build the authorize URL the user is sent to.
function createAuthUrl(uid) {
  if (!configured()) throw new Error('cTrader is not configured (set CTRADER_CLIENT_ID / SECRET / REDIRECT_URI).');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { uid, ts: Date.now() });
  // prune old states (>10 min)
  for (const [k, v] of pendingStates) if (Date.now() - v.ts > 600000) pendingStates.delete(k);
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'accounts trading',
    response_type: 'code',
    state,
  });
  return AUTH_BASE + '/apps/auth?' + p.toString();
}

async function exchangeToken(code) {
  const p = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  const r = await fetch(AUTH_BASE + '/apps/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: p.toString(),
  });
  const b = await r.json();
  if (!b.access_token) throw new Error(b.errorCode || b.error || 'cTrader token exchange failed');
  return b; // { access_token, refresh_token, expires_in, ... }
}

async function fetchAccounts(accessToken) {
  const r = await fetch(ACCOUNTS_URL + '?access_token=' + encodeURIComponent(accessToken));
  const b = await r.json();
  return (b && b.data) || [];
}

// Step 2 — Spotware redirects here with ?code=&state=
async function handleCallback(code, state) {
  const rec = state && pendingStates.get(state);
  if (!rec) throw new Error('Invalid or expired OAuth state.');
  pendingStates.delete(state);
  const uid = rec.uid;
  await setStatus(uid, { status: 'connecting' });
  try {
    const tok = await exchangeToken(code);
    const accounts = await fetchAccounts(tok.access_token);
    await setStatus(uid, {
      status: 'connected',
      accounts: accounts.map(a => ({ accountId: a.accountId, number: a.accountNumber, live: !!a.live, broker: a.brokerName })),
      historyImported: 0,
      lastSyncAt: Date.now(),
      note: 'Account linked. Deal-history import via cTrader Open API is pending (TODO).',
      error: null,
    });
    // Tokens are sensitive — store them in a private subcollection, not the public user doc.
    await store.db.collection('users').doc(uid).collection('private').doc('ctrader')
      .set({ accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: Date.now() + (tok.expires_in || 0) * 1000, updatedAt: Date.now() }, { merge: true });

    // TODO(openapi): open a Protobuf connection to {demo|live}.ctraderapi.com:5035,
    //   authenticate app + account with the access token, request ProtoOADealListReq
    //   for each ctidTraderAccountId, group deals by positionId (same logic as
    //   tradeMapper.buildTradesFromDeals), then store.writeTrades(...). Needs the
    //   @reiryoku/ctrader-layer dependency and a demo account to verify.
    return uid;
  } catch (e) {
    await setStatus(uid, { status: 'error', error: friendlyError(e) });
    throw e;
  }
}

async function disconnect(uid) {
  await setStatus(uid, { status: 'disconnected' });
  try { await store.db.collection('users').doc(uid).collection('private').doc('ctrader').delete(); } catch (e) {}
}

function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/not configured/i.test(m)) return m;
  if (/state/i.test(m)) return 'cTrader authorization expired — please try connecting again.';
  return 'cTrader connect failed: ' + m;
}

module.exports = { init, configured, createAuthUrl, handleCallback, disconnect, friendlyError };
