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

test('matches exact first+last name with highest score path', () => {
  const score = scoreComparableNameMatch('Bryant Wesco', 'Bryant Wesco Jr');
  assert.equal(score, 95);
});

test('supports reverse alias map direction (Nathan -> Nate)', () => {
  const score = scoreComparableNameMatch('Nathan Frazier', 'Nate Fraizer');
  assert.ok(score >= 70);
});

test('returns zero when tokenized names are incomplete', () => {
  const score = scoreComparableNameMatch('Madonna', 'Nate Fraizer');
  assert.equal(score, 0);
});

test('returns zero when first names are not equivalent', () => {
  const score = scoreComparableNameMatch('Air Noland', 'Bryant Noland');
  assert.equal(score, 0);
});

test('returns zero when last names are too different', () => {
  const score = scoreComparableNameMatch('Bryant Wesco', 'Bryant Random');
  assert.equal(score, 0);
});
