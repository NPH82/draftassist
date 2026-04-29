const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeComparableName,
  scoreComparableNameMatch,
} = require('../src/utils/devyNameMatcher');

test('normalizes suffix names for comparable lookup', () => {
  assert.equal(normalizeComparableName('Bryant Wesco Jr.'), 'bryant wesco');
});

test('matches nickname + typo (Nate Fraizer ~ Nathan Frazier)', () => {
  const score = scoreComparableNameMatch('Nate Fraizer', 'Nathan Frazier');
  assert.ok(score > 0);
});

test('matches missing suffix with trailing college token', () => {
  const score = scoreComparableNameMatch('Bryant Wesco Clemson', 'Bryant Wesco Jr');
  assert.ok(score > 0);
});

test('rejects clearly different names', () => {
  const score = scoreComparableNameMatch('Air Noland', 'Bryant Wesco Jr');
  assert.equal(score, 0);
});
