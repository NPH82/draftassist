const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseAdminSleeperIds,
  requireAdminAllowlist,
} = require('../src/middleware/auth');

function createResRecorder() {
  const result = { statusCode: null, payload: null };
  return {
    result,
    status(code) {
      result.statusCode = code;
      return this;
    },
    json(payload) {
      result.payload = payload;
      return this;
    },
  };
}

test('parseAdminSleeperIds trims whitespace and ignores empty entries', () => {
  const parsed = parseAdminSleeperIds(' 111 , ,222,   333   ');
  assert.deepEqual(parsed, ['111', '222', '333']);
});

test('requireAdminAllowlist denies when ADMIN_SLEEPER_IDS is empty/unset', () => {
  const saved = process.env.ADMIN_SLEEPER_IDS;
  delete process.env.ADMIN_SLEEPER_IDS;

  let nextCalled = false;
  const req = { user: { sleeperId: '111' } };
  const res = createResRecorder();

  requireAdminAllowlist(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.result.statusCode, 403);
  assert.equal(res.result.payload?.error, 'Admin endpoint only');

  if (saved == null) delete process.env.ADMIN_SLEEPER_IDS;
  else process.env.ADMIN_SLEEPER_IDS = saved;
});

test('requireAdminAllowlist denies non-allowlisted users', () => {
  const saved = process.env.ADMIN_SLEEPER_IDS;
  process.env.ADMIN_SLEEPER_IDS = '111,222';

  let nextCalled = false;
  const req = { user: { sleeperId: '999' } };
  const res = createResRecorder();

  requireAdminAllowlist(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.result.statusCode, 403);
  assert.equal(res.result.payload?.error, 'Admin endpoint only');

  if (saved == null) delete process.env.ADMIN_SLEEPER_IDS;
  else process.env.ADMIN_SLEEPER_IDS = saved;
});

test('requireAdminAllowlist allows users on allowlist', () => {
  const saved = process.env.ADMIN_SLEEPER_IDS;
  process.env.ADMIN_SLEEPER_IDS = '111,222';

  let nextCalled = false;
  const req = { user: { sleeperId: '222' } };
  const res = createResRecorder();

  requireAdminAllowlist(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.result.statusCode, null);

  if (saved == null) delete process.env.ADMIN_SLEEPER_IDS;
  else process.env.ADMIN_SLEEPER_IDS = saved;
});
