const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldExcludeAvailableByDrafted,
  normalizeName,
} = require('../src/utils/devyPoolDraftExclusion');

test('excludes by drafted sleeper id', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Ahmad Hardy',
    playerSleeperId: '1234',
    draftedPlayerIds: new Set(['1234']),
    draftedPlayerNames: new Set(),
  });
  assert.equal(out, true);
});

test('excludes by exact drafted name when id is missing/stale', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Ahmad Hardy',
    playerSleeperId: null,
    draftedPlayerIds: new Set(),
    draftedPlayerNames: new Set([normalizeName('Ahmad Hardy')]),
  });
  assert.equal(out, true);
});

test('excludes by fuzzy drafted name for Nate/Nathan typo case', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Nate Frazier',
    playerSleeperId: null,
    draftedPlayerIds: new Set(),
    draftedPlayerNames: new Set([normalizeName('Nathan Fraizer')]),
  });
  assert.equal(out, true);
});

test('excludes by fuzzy drafted name for Wesco suffix/school-token case', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Bryant Wesco Jr',
    playerSleeperId: null,
    draftedPlayerIds: new Set(),
    draftedPlayerNames: new Set([normalizeName('Bryant Wesco Clemson')]),
  });
  assert.equal(out, true);
});

test('does not exclude unrelated names', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Air Noland',
    playerSleeperId: null,
    draftedPlayerIds: new Set(),
    draftedPlayerNames: new Set([normalizeName('Bryant Wesco Clemson')]),
  });
  assert.equal(out, false);
});

test('excludes reversed drafted name order for Ahmad Hardy', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Ahmad Hardy',
    playerSleeperId: null,
    draftedPlayerIds: new Set(),
    draftedPlayerNames: new Set([normalizeName('Hardy Ahmad')]),
  });
  assert.equal(out, true);
});

test('does not exclude when player name is empty', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: '   ',
    playerSleeperId: null,
    draftedPlayerIds: new Set(['12']),
    draftedPlayerNames: new Set([normalizeName('Ahmad Hardy')]),
  });
  assert.equal(out, false);
});

test('does not exclude when fuzzy threshold is stricter than match score', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Nate Frazier',
    playerSleeperId: null,
    draftedPlayerIds: new Set(),
    draftedPlayerNames: new Set([normalizeName('Nathan Fraizer')]),
    fuzzyThreshold: 96,
  });
  assert.equal(out, false);
});

test('handles missing drafted sets via defaults', () => {
  const out = shouldExcludeAvailableByDrafted({
    playerName: 'Air Noland',
    playerSleeperId: null,
  });
  assert.equal(out, false);
});
