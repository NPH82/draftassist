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
  const out = await sendDiscrepancyEmailWithTimeout({
    report: { playerName: 'Ahmad Hardy', leagueId: 'league-1' },
    leagueName: 'Test League',
    timeoutMs: 50,
  });
  assert.equal(out.sent, false);
  // In local tests without SMTP env this should resolve to smtp_not_configured, not throw.
  assert.equal(typeof out.error, 'string');
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