// Brevo (Sendinblue) transactional email sender.
// Configure via env: BREVO_API_KEY, BREVO_SENDER (verified sender address),
// optional BREVO_SENDER_NAME. Until those are set, sendEmail() is a safe no-op
// so the rest of the app keeps working.
const API_URL = 'https://api.brevo.com/v3/smtp/email';

function configured() {
  return !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER);
}

async function sendEmail({ to, toName, subject, html }) {
  if (!configured()) {
    console.log('[email] BREVO not configured — skipping send:', subject);
    return false;
  }
  if (!to) return false;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { email: process.env.BREVO_SENDER, name: process.env.BREVO_SENDER_NAME || 'ETW Journal' },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[email] Brevo error', r.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[email] send failed:', e.message);
    return false;
  }
}

module.exports = { sendEmail, configured };
