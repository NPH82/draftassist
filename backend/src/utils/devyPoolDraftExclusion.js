const { scoreComparableNameMatch } = require('./devyNameMatcher');

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstLastTokens(value) {
  const tokens = normalizeName(value)
    .split(' ')
    .filter(Boolean);
  if (tokens.length < 2) return null;
  return { first: tokens[0], last: tokens[1] };
}

function isReversedNameMatch(nameA, nameB) {
  const a = firstLastTokens(nameA);
  const b = firstLastTokens(nameB);
  if (!a || !b) return false;
  return a.first === b.last && a.last === b.first;
}

function shouldExcludeAvailableByDrafted({
  playerName,
  playerSleeperId,
  draftedPlayerIds,
  draftedPlayerNames,
  fuzzyThreshold = 70,
} = {}) {
  const ids = draftedPlayerIds || new Set();
  const names = draftedPlayerNames || new Set();

  if (playerSleeperId && ids.has(String(playerSleeperId))) return true;

  const normalizedPlayerName = normalizeName(playerName);
  if (!normalizedPlayerName) return false;

  if (names.has(normalizedPlayerName)) return true;

  for (const draftedName of names) {
    if (!draftedName || draftedName === normalizedPlayerName) continue;
    if (isReversedNameMatch(draftedName, normalizedPlayerName)) return true;
    const score = scoreComparableNameMatch(draftedName, playerName);
    if (score >= fuzzyThreshold) return true;
  }

  return false;
}

module.exports = {
  normalizeName,
  shouldExcludeAvailableByDrafted,
};
