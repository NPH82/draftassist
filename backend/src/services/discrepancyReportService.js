let nodemailer = null;
const dns = require('node:dns');
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

function sanitizeHeaderValue(value, maxLen = 240) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function parseTimeoutMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveDiscrepancyEmailTimeoutMs() {
  return parseTimeoutMs(process.env.DISCREPANCY_EMAIL_TIMEOUT_MS, 25000);
}

function resolveSmtpIpFamily() {
  const raw = String(process.env.SMTP_IP_FAMILY || '4').trim();
  if (raw === '6') return 6;
  return 4;
}

function resolveResendTimeoutMs() {
  return parseTimeoutMs(process.env.RESEND_HTTP_TIMEOUT_MS, 12000);
}

function getResendConfig() {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  const from = sanitizeHeaderValue(process.env.RESEND_FROM_EMAIL || process.env.SMTP_FROM || process.env.EMAIL_FROM || '', 320);
  const to = sanitizeHeaderValue(process.env.RESEND_TO_EMAIL || process.env.DISCREPANCY_REPORT_TO_EMAIL || process.env.ALERT_TO_EMAIL || '', 320);
  return {
    enabled: !!apiKey && !!from && !!to,
    apiKey,
    from,
    to,
    timeoutMs: resolveResendTimeoutMs(),
  };
}

async function sendDiscrepancyEmailViaResend({ report, leagueName, subject, text }) {
  const cfg = getResendConfig();
  const resendCtx = safeEmailContext({
    report,
    leagueName,
    to: cfg.to,
    from: cfg.from,
    timeoutMs: cfg.timeoutMs,
  });

  if (!cfg.enabled) {
    console.warn('[Devy Discrepancy Email] Resend fallback unavailable (not configured)', resendCtx);
    return { sent: false, error: 'resend_not_configured' };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), cfg.timeoutMs);

  console.info('[Devy Discrepancy Email] Resend fallback attempt started', resendCtx);
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: cfg.from,
        to: [cfg.to],
        subject,
        text,
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const message = payload?.message || `resend_http_${response.status}`;
      throw Object.assign(new Error(message), {
        code: 'ERESEND',
        responseCode: response.status,
        command: 'HTTP',
      });
    }

    console.info('[Devy Discrepancy Email] Resend fallback attempt completed', {
      ...resendCtx,
      responseCode: response.status,
      messageId: payload?.id || null,
    });
    return { sent: true, provider: 'resend' };
  } catch (err) {
    const isAbort = err?.name === 'AbortError';
    const safeErr = isAbort
      ? {
          name: 'AbortError',
          message: `resend_timeout_${cfg.timeoutMs}ms`,
          code: 'ETIMEDOUT',
          responseCode: null,
          command: 'HTTP',
          errno: null,
          syscall: null,
        }
      : safeEmailError(err);
    console.error('[Devy Discrepancy Email] Resend fallback attempt failed', {
      ...resendCtx,
      error: safeErr,
    });
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function resolveSmtpConnectHost(host, family) {
  if (!String(host || '').trim()) {
    return {
      connectHost: host,
      resolvedAddress: null,
      resolvedFamily: null,
    };
  }

  try {
    const resolved = await dns.promises.lookup(host, {
      family,
      all: false,
      verbatim: false,
    });
    if (resolved?.address) {
      return {
        connectHost: resolved.address,
        resolvedAddress: resolved.address,
        resolvedFamily: resolved.family || null,
      };
    }
  } catch {
    // Fall back to original hostname if resolution fails.
  }
  return {
    connectHost: host,
    resolvedAddress: null,
    resolvedFamily: null,
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
  const to = sanitizeHeaderValue(process.env.DISCREPANCY_REPORT_TO_EMAIL || process.env.ALERT_TO_EMAIL || '', 320);
  const from = sanitizeHeaderValue(process.env.SMTP_FROM || process.env.EMAIL_FROM || '', 320);
  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const connectionTimeoutMs = parseTimeoutMs(process.env.SMTP_CONNECTION_TIMEOUT_MS, 8000);
  const greetingTimeoutMs = parseTimeoutMs(process.env.SMTP_GREETING_TIMEOUT_MS, 8000);
  const socketTimeoutMs = parseTimeoutMs(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000);
  const smtpIpFamily = resolveSmtpIpFamily();
  const {
    connectHost,
    resolvedAddress,
    resolvedFamily,
  } = await resolveSmtpConnectHost(host, smtpIpFamily);

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
    host: connectHost,
    port,
    secure,
    family: smtpIpFamily,
    // Force IPv4 by default on hosts where IPv6 egress is unavailable (e.g. some free-tier runtimes).
    lookup: (hostname, options, callback) => {
      dns.lookup(hostname, { ...(options || {}), family: smtpIpFamily, all: false }, callback);
    },
    connectionTimeout: connectionTimeoutMs,
    greetingTimeout: greetingTimeoutMs,
    socketTimeout: socketTimeoutMs,
    auth: { user, pass },
    tls: {
      // Keep TLS SNI and cert validation bound to the canonical SMTP host.
      servername: host,
    },
  });

  const safePlayerName = sanitizeHeaderValue(report?.playerName || 'unknown player', 120);
  const safeLeagueId = sanitizeHeaderValue(report?.leagueId || 'unknown-league', 80);
  const subject = `[DraftAssistant] Devy discrepancy: ${safePlayerName} (${safeLeagueId})`;
  const text = buildEmailBody({ report, leagueName });

  console.info('[Devy Discrepancy Email] Send attempt started', {
    ...emailCtx,
    smtpIpFamily,
    connectHost,
    resolvedAddress,
    resolvedFamily,
    connectionTimeoutMs,
    greetingTimeoutMs,
    socketTimeoutMs,
  });
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
    return { sent: true, provider: 'smtp' };
  } catch (err) {
    console.error('[Devy Discrepancy Email] Send attempt failed', {
      ...emailCtx,
      error: safeEmailError(err),
    });

    // Fallback to HTTPS provider to avoid SMTP transport/network issues on some hosts.
    try {
      const resendResult = await sendDiscrepancyEmailViaResend({
        report,
        leagueName,
        subject,
        text,
      });
      if (resendResult?.sent) return resendResult;
    } catch (fallbackErr) {
      console.error('[Devy Discrepancy Email] All delivery providers failed', {
        ...emailCtx,
        smtpError: safeEmailError(err),
        resendError: safeEmailError(fallbackErr),
      });
    }

    throw err;
  }
}

async function sendDiscrepancyEmailWithTimeout({
  report,
  leagueName,
  timeoutMs = resolveDiscrepancyEmailTimeoutMs(),
  sendFn = sendDiscrepancyEmail,
}) {
  const ms = Number(timeoutMs);
  const safeTimeout = Number.isFinite(ms) && ms > 0 ? ms : resolveDiscrepancyEmailTimeoutMs();
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
  resolveDiscrepancyEmailTimeoutMs,
};
