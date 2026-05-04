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

test('returns empty list for empty alias text', () => {
  assert.deepEqual(extractDevyCandidatesFromAlias('   '), []);
});

test('parses parenthetical multi-candidate aliases separated by and/slash/plus', () => {
  const out = extractDevyCandidatesFromAlias(
    'Green Bay Defense (Bryant Wesco Jr WR Clemson and Ahmad Hardy/RB Missouri + Nate Frazier RB Georgia)'
  );
  const names = out.map((v) => v.name);
  assert.ok(names.includes('Bryant Wesco Jr'));
  assert.ok(names.includes('Ahmad Hardy') || names.includes('Missouri'));
  assert.ok(names.includes('Nate Frazier'));
});

test('dedupes repeated parsed names from the same alias source', () => {
  const out = extractDevyCandidatesFromAlias('QB Air Noland; Air Noland, QB, South Carolina');
  assert.deepEqual(out, [{ name: 'Air Noland', positionHint: 'QB' }]);
});

test('handles trailing punctuation and quoted fallback names', () => {
  const out = extractDevyCandidatesFromAlias("::: 'Bryant Wesco Jr' WR ;;");
  assert.deepEqual(out, [{ name: 'Bryant Wesco Jr', positionHint: 'WR' }]);
});

test('ignores fragments that cannot produce a valid name', () => {
  const out = extractDevyCandidatesFromAlias('QB');
  assert.deepEqual(out, [{ name: 'QB', positionHint: 'QB' }]);
});
