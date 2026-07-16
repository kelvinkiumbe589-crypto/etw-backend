// Firebase Admin init.
// Accepts the service-account JSON either raw (starts with "{") or base64-encoded,
// via the FIREBASE_SERVICE_ACCOUNT env var.
const admin = require('firebase-admin');

function initFirebase() {
  if (admin.apps.length) return admin;

  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT env var is required (service-account JSON, raw or base64).');

  // If it doesn't look like JSON, assume base64.
  if (!raw.trim().startsWith('{')) {
    try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { /* fall through */ }
  }

  const cred = JSON.parse(raw);
  // Render / env vars often escape newlines in the private key.
  if (cred.private_key && cred.private_key.includes('\\n')) {
    cred.private_key = cred.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({ credential: admin.credential.cert(cred) });
  return admin;
}

module.exports = { admin, initFirebase };
