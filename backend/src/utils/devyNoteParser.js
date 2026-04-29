const NOTE_POSITION_TOKENS = new Set(['QB', 'RB', 'WR', 'TE', 'LB', 'DL', 'DE', 'DT', 'CB', 'S', 'DB', 'EDGE', 'ED']);

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDevyCandidateFragment(fragment) {
  const raw = String(fragment || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-:;,\s]+|[-:;,\s]+$/g, '');
  if (!raw) return null;

  // Handle structured note formats such as:
  // - Air Noland, QB, South Carolina
  // - Devin Brown-QB-OSu
  const normalizedStructured = raw.replace(/\s*-\s*/g, ', ');
  const structuredParts = normalizedStructured
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (structuredParts.length >= 2) {
    const posIdx = structuredParts.findIndex((part) => NOTE_POSITION_TOKENS.has(part.toUpperCase()));
    if (posIdx >= 0) {
      const positionHint = structuredParts[posIdx].toUpperCase();
      const before = posIdx > 0 ? structuredParts[posIdx - 1] : null;
      const after = posIdx < structuredParts.length - 1 ? structuredParts[posIdx + 1] : null;
      const nameCandidate = [before, after]
        .find((part) => part && !NOTE_POSITION_TOKENS.has(part.toUpperCase()));

      if (nameCandidate) {
        return { name: nameCandidate, positionHint };
      }
    }
  }

  const tokens = raw.split(' ').filter(Boolean);
  if (!tokens.length) return null;

  let positionHint = null;
  let nameTokens = tokens;
  const posIdx = tokens.findIndex((token) => NOTE_POSITION_TOKENS.has(token.toUpperCase()));
  if (posIdx >= 0) {
    positionHint = tokens[posIdx].toUpperCase();
    if (posIdx === 0 && tokens.length >= 2) {
      nameTokens = tokens.slice(1);
    } else if (posIdx >= 2) {
      nameTokens = tokens.slice(0, posIdx);
    }
  }

  const name = nameTokens.join(' ').replace(/^['\"]|['\"]$/g, '').trim();
  if (!name) return null;
  return { name, positionHint };
}

function extractDevyCandidatesFromAlias(rawAlias) {
  const text = String(rawAlias || '').trim();
  if (!text) return [];

  const parenMatches = [...text.matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const sources = parenMatches.length > 0 ? parenMatches : [text];
  const out = [];
  const seen = new Set();

  for (const source of sources) {
    const parts = source
      .split(/;|\+|\/|\band\b/gi)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const part of parts) {
      const parsed = parseDevyCandidateFragment(part);
      if (!parsed) continue;
      const key = normalizeName(parsed.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(parsed);
    }
  }

  return out;
}

module.exports = {
  parseDevyCandidateFragment,
  extractDevyCandidatesFromAlias,
};
