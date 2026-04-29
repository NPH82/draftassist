const test = require('node:test');
const assert = require('node:assert/strict');

const { extractDevyCandidatesFromAlias } = require('../src/utils/devyNoteParser');

test('parses comma-delimited note into a single devy candidate', () => {
  const out = extractDevyCandidatesFromAlias('Air Noland, QB, South Carolina');
  assert.deepEqual(out, [{ name: 'Air Noland', positionHint: 'QB' }]);
});

test('parses hyphen-delimited note into a single devy candidate', () => {
  const out = extractDevyCandidatesFromAlias('Devin Brown-QB-OSu');
  assert.deepEqual(out, [{ name: 'Devin Brown', positionHint: 'QB' }]);
});

test('supports leading-position notes', () => {
  const out = extractDevyCandidatesFromAlias('QB Air Noland');
  assert.deepEqual(out, [{ name: 'Air Noland', positionHint: 'QB' }]);
});
