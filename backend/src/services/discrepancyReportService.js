let nodemailer = null;
try {
  // Optional dependency; reports are still stored even when email is unavailable.
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

function inferMissReason(payload = {}) {
  const allowedReasons = new Set([
    'live_roster_sync_gap',
    'draft_pick_ingest_gap',
    'alias_name_match_miss',
    'stale_or_wrong_sleeper_id',
    'duplicate_source_merge',
    'other',
  ]);

  const provided = String(payload.suspectedMissReason || '').trim();
  if (provided && allowedReasons.has(provided)) return provided;

  if (payload.associatedPlayerId && !payload.playerSleeperId) return 'alias_name_match_miss';
  if (payload.playerSleeperId && payload.playerName) return 'stale_or_wrong_sleeper_id';
  return 'other';
}

function buildEmailBody({ report, leagueName }) {
  return [
    'Devy discrepancy report submitted',
    '',
    `League: ${leagueName || report.leagueId}`,
    `League ID: ${report.leagueId}`,
    `Reporter: ${report.reporterUsername || report.reporterSleeperId}`,
    `Reporter Sleeper ID: ${report.reporterSleeperId}`,
    `Reported At: ${new Date().toISOString()}`,
    '',
    `Player: ${report.playerName}`,
    `Player Sleeper ID: ${report.playerSleeperId || 'n/a'}`,
    `Associated Placeholder ID: ${report.associatedPlayerId || 'n/a'}`,
    `Associated Placeholder Name: ${report.associatedPlayerName || 'n/a'}`,
    `Source Tab: ${report.sourceTab || 'n/a'}`,
    `Suspected Miss Reason: ${report.suspectedMissReason || 'other'}`,
    '',
    'Reporter Note:',
    report.note || '(none provided)',
  ].join('\n');
}

async function sendDiscrepancyEmail({ report, leagueName }) {
  const to = process.env.DISCREPANCY_REPORT_TO_EMAIL || process.env.ALERT_TO_EMAIL || '';
  const from = process.env.SMTP_FROM || process.env.EMAIL_FROM || '';
  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

  if (!to || !from || !host || !user || !pass) {
    return { sent: false, error: 'smtp_not_configured' };
  }
  if (!nodemailer) {
    return { sent: false, error: 'nodemailer_not_installed' };
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject = `[DraftAssistant] Devy discrepancy: ${report.playerName} (${report.leagueId})`;
  const text = buildEmailBody({ report, leagueName });

  await transporter.sendMail({ from, to, subject, text });
  return { sent: true };
}

module.exports = {
  inferMissReason,
  sendDiscrepancyEmail,
};
