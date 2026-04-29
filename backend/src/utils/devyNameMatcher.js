const NAME_SUFFIX_TOKENS = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);

const FIRST_NAME_ALIASES = new Map([
  ['nate', new Set(['nathan'])],
  ['nathan', new Set(['nate'])],
]);

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeComparableName(value) {
  return normalizeName(value)
    .split(' ')
    .filter(Boolean)
    .filter((token) => !NAME_SUFFIX_TOKENS.has(token));
}

function normalizeComparableName(value) {
  return tokenizeComparableName(value).join(' ');
}

function areFirstNamesEquivalent(a, b) {
  const aNorm = normalizeName(a);
  const bNorm = normalizeName(b);
  if (!aNorm || !bNorm) return false;
  if (aNorm === bNorm) return true;
  return !!(FIRST_NAME_ALIASES.get(aNorm)?.has(bNorm) || FIRST_NAME_ALIASES.get(bNorm)?.has(aNorm));
}

function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  const m = s.length;
  const n = t.length;

  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i += 1) dp[i][0] = i;
  for (let j = 0; j <= n; j += 1) dp[0][j] = j;

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function areNameTokensSimilar(a, b) {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (!left || !right) return false;
  if (left === right) return true;

  const distance = editDistance(left, right);
  const maxLen = Math.max(left.length, right.length);
  const threshold = maxLen >= 7 ? 2 : 1;
  return distance <= threshold;
}

function scoreComparableNameMatch(candidateName, dbName) {
  const candidateTokens = tokenizeComparableName(candidateName);
  const dbTokens = tokenizeComparableName(dbName);
  if (candidateTokens.length < 2 || dbTokens.length < 2) return 0;

  const candidateFirst = candidateTokens[0];
  const candidateLast = candidateTokens[1];
  const dbFirst = dbTokens[0];
  const dbLast = dbTokens[1];

  if (!areFirstNamesEquivalent(candidateFirst, dbFirst)) return 0;
  if (!areNameTokensSimilar(candidateLast, dbLast)) return 0;

  let score = 70;
  if (candidateFirst === dbFirst) score += 10;
  if (candidateLast === dbLast) score += 15;

  return score;
}

module.exports = {
  normalizeComparableName,
  scoreComparableNameMatch,
};
