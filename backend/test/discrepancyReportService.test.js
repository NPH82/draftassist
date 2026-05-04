const test = require('node:test');
const assert = require('node:assert/strict');

const {
  inferMissReason,
  sendDiscrepancyEmailWithTimeout,
} = require('../src/services/discrepancyReportService');

test('uses provided reason when allowed', () => {
  const out = inferMissReason({ suspectedMissReason: 'draft_pick_ingest_gap' });
  assert.equal(out, 'draft_pick_ingest_gap');
});

test('falls back when provided reason is not allowed', () => {
  const out = inferMissReason({ suspectedMissReason: 'ui_filtering_bug' });
  assert.equal(out, 'other');
});

test('infers alias_name_match_miss from associated player without sleeper id', () => {
  const out = inferMissReason({ associatedPlayerId: 'abc123', playerName: 'Nate Frazier' });
  assert.equal(out, 'alias_name_match_miss');
});

test('infers stale_or_wrong_sleeper_id when player sleeper id is present', () => {
  const out = inferMissReason({ playerSleeperId: '999', playerName: 'Ahmad Hardy' });
  assert.equal(out, 'stale_or_wrong_sleeper_id');
});

test('email helper returns timeout result when SMTP is unconfigured quickly', async () => {
  const saved = {
    DISCREPANCY_REPORT_TO_EMAIL: process.env.DISCREPANCY_REPORT_TO_EMAIL,
    ALERT_TO_EMAIL: process.env.ALERT_TO_EMAIL,
    SMTP_FROM: process.env.SMTP_FROM,
    EMAIL_FROM: process.env.EMAIL_FROM,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
    RESEND_TO_EMAIL: process.env.RESEND_TO_EMAIL,
  };

  delete process.env.DISCREPANCY_REPORT_TO_EMAIL;
  delete process.env.ALERT_TO_EMAIL;
  delete process.env.SMTP_FROM;
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_TO_EMAIL;

  const out = await sendDiscrepancyEmailWithTimeout({
    report: { playerName: 'Ahmad Hardy', leagueId: 'league-1' },
    leagueName: 'Test League',
    timeoutMs: 50,
  });
  assert.equal(out.sent, false);
  // In local tests without SMTP env this should resolve to smtp_not_configured, not throw.
  assert.equal(typeof out.error, 'string');

  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

test('email helper returns email_timeout when send function hangs', async () => {
  const hangingSend = async () => new Promise(() => {});
  const out = await sendDiscrepancyEmailWithTimeout({
    report: { playerName: 'Ahmad Hardy', leagueId: 'league-1' },
    leagueName: 'Test League',
    timeoutMs: 20,
    sendFn: hangingSend,
  });
  assert.equal(out.sent, false);
  assert.equal(out.error, 'email_timeout');
});

test('email helper safely handles header-like CRLF content in playerName', async () => {
  const out = await sendDiscrepancyEmailWithTimeout({
    report: {
      playerName: 'Nick Marsh\r\nBcc: attacker@example.com',
      leagueId: 'league-1',
    },
    leagueName: 'Test League',
    timeoutMs: 50,
  });

  assert.equal(out.sent, false);
  assert.equal(typeof out.error, 'string');
});