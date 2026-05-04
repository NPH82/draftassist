let nodemailer = null;
try {
  // Optional dependency; reports are still stored even when email is unavailable.
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

function maskEmail(value) {
  const v = String(value || '').trim();
  if (!v || !v.includes('@')) return v || null;
  const [local, domain] = v.split('@');
  const safeLocal = local.length <= 2 ? `${local[0] || '*'}*` : `${local.slice(0, 2)}***`;
  return `${safeLocal}@${domain}`;
}

function safeEmailContext({ report, leagueName, host, port, secure, to, from, timeoutMs, elapsedMs }) {
  return {
    reportId: report?._id ? String(report._id) : null,
    leagueId: report?.leagueId || null,
    leagueName: leagueName || null,
    playerName: report?.playerName || null,
    smtpHost: host || null,
    smtpPort: Number.isFinite(Number(port)) ? Number(port) : null,
    smtpSecure: !!secure,
    to: maskEmail(to),
    from: maskEmail(from),
    timeoutMs: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null,
    elapsedMs: Number.isFinite(Number(elapsedMs)) ? Number(elapsedMs) : null,
  };
}

function safeEmailError(err) {
  if (!err) return { message: 'unknown_error' };
  return {
    name: err.name || null,
    message: err.message || 'email_send_failed',
    code: err.code || null,
    responseCode: err.responseCode || null,
    command: err.command || null,
    errno: err.errno || null,
    syscall: err.syscall || null,
  };
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

  const emailCtx = safeEmailContext({
    report,
    leagueName,
    host,
    port,
    secure,
    to,
    from,
  });

  if (!to || !from || !host || !user || !pass) {
    const missing = [];
    if (!to) missing.push('DISCREPANCY_REPORT_TO_EMAIL/ALERT_TO_EMAIL');
    if (!from) missing.push('SMTP_FROM/EMAIL_FROM');
    if (!host) missing.push('SMTP_HOST');
    if (!user) missing.push('SMTP_USER');
    if (!pass) missing.push('SMTP_PASS');
    console.warn('[Devy Discrepancy Email] SMTP not configured', { ...emailCtx, missing });
    return { sent: false, error: 'smtp_not_configured' };
  }
  if (!nodemailer) {
    console.error('[Devy Discrepancy Email] Nodemailer dependency missing', emailCtx);
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

  console.info('[Devy Discrepancy Email] Send attempt started', emailCtx);
  try {
    const info = await transporter.sendMail({ from, to, subject, text });
    console.info('[Devy Discrepancy Email] Send attempt completed', {
      ...emailCtx,
      messageId: info?.messageId || null,
      accepted: Array.isArray(info?.accepted) ? info.accepted.length : 0,
      rejected: Array.isArray(info?.rejected) ? info.rejected.length : 0,
      pending: Array.isArray(info?.pending) ? info.pending.length : 0,
      response: info?.response || null,
    });
    return { sent: true };
  } catch (err) {
    console.error('[Devy Discrepancy Email] Send attempt failed', {
      ...emailCtx,
      error: safeEmailError(err),
    });
    throw err;
  }
}

async function sendDiscrepancyEmailWithTimeout({
  report,
  leagueName,
  timeoutMs = 4000,
  sendFn = sendDiscrepancyEmail,
}) {
  const ms = Number(timeoutMs);
  const safeTimeout = Number.isFinite(ms) && ms > 0 ? ms : 4000;
  const startedAt = Date.now();

  console.info('[Devy Discrepancy Email] Timeout wrapper started', safeEmailContext({
    report,
    leagueName,
    timeoutMs: safeTimeout,
  }));

  let timeoutHandle = null;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => {
      const elapsedMs = Date.now() - startedAt;
      console.warn('[Devy Discrepancy Email] Timeout reached before send completed', safeEmailContext({
        report,
        leagueName,
        timeoutMs: safeTimeout,
        elapsedMs,
      }));
      resolve({ sent: false, error: 'email_timeout', durationMs: elapsedMs });
    }, safeTimeout);
  });

  try {
    const result = await Promise.race([
      sendFn({ report, leagueName }),
      timeoutPromise,
    ]);
    const elapsedMs = Date.now() - startedAt;
    console.info('[Devy Discrepancy Email] Timeout wrapper completed', safeEmailContext({
      report,
      leagueName,
      timeoutMs: safeTimeout,
      elapsedMs,
    }));
    if (result && typeof result === 'object' && !('durationMs' in result)) {
      return { ...result, durationMs: elapsedMs };
    }
    return result;
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    console.error('[Devy Discrepancy Email] Timeout wrapper caught error', {
      ...safeEmailContext({
        report,
        leagueName,
        timeoutMs: safeTimeout,
        elapsedMs,
      }),
      error: safeEmailError(err),
    });
    return { sent: false, error: err?.message || 'email_send_failed', durationMs: elapsedMs };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

module.exports = {
  inferMissReason,
  sendDiscrepancyEmail,
  sendDiscrepancyEmailWithTimeout,
};
