/**
 * NFL Mock Draft Database scraper
 * Fetches the consensus big board for a given draft class year.
 * Used to identify incoming devy prospects, their projected draft slot, school, and position.
 *
 * Free tier exposes top ~100 prospects. Players behind the Mock+ paywall are skipped.
 * Only skill positions (QB, RB, WR, TE) are returned.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.nflmockdraftdatabase.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://www.nflmockdraftdatabase.com/',
};

const SKILL_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE']);

// Normalise name for fuzzy matching — strip punctuation, lowercase, collapse spaces.
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch the consensus big board for `year` (e.g. 2027).
 * Returns an array of skill-position prospects with:
 *   name, position, college, bigBoardRank, projectedPick, projectedRound, devyClass
 */
async function fetchBigBoard(year = 2027) {
  const url = `${BASE}/big-boards/${year}/consensus-big-board-${year}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);

  const results = [];
  let overallRank = 0;

  // Each prospect has an anchor whose href matches /players/YEAR/player-slug.
  // The anchor text is the player's full name.
  // Surrounding elements (siblings / parent text) hold: position, college, projected pick.
  $(`a[href*="/players/${year}/"]`).each((_, playerEl) => {
    const name = $(playerEl).text().trim();
    if (!name) return;

    overallRank++;

    // Walk up the DOM (up to 5 levels) to find the smallest container that
    // includes position info alongside this player.
    let container = $(playerEl);
    let posText = null;

    for (let depth = 0; depth < 5; depth++) {
      container = container.parent();
      const txt = container.text();
      const m = txt.match(/\b(QB|RB|WR|TE|OT|IOL|DL|EDGE|LB|CB|S|K|P|LS)\b/);
      if (m) {
        posText = m[1];
        break;
      }
    }

    // Skip non-skill or unresolved positions
    if (!posText || !SKILL_POSITIONS.has(posText)) return;

    // College: find a college anchor in the container (href contains /colleges/)
    let college = null;
    container.find('a[href*="/colleges/"]').each((_, a) => {
      const text = $(a).text().trim();
      if (text) { college = text; return false; } // break on first match
    });

    // Projected pick: mock-draft link text is formatted "#N TEAM" (e.g. "#2 ARI")
    let projectedPick = null;
    container.find('a[href*="/mock-drafts/"]').each((_, a) => {
      const text = $(a).text().trim();
      const m = text.match(/^#(\d+)/);
      if (m) { projectedPick = parseInt(m[1], 10); return false; }
    });

    // Also check plain text for pick pattern (some layouts omit the link)
    if (!projectedPick) {
      const pickMatch = container.text().match(/#(\d+)\s+[A-Z]{2,3}/);
      if (pickMatch) projectedPick = parseInt(pickMatch[1], 10);
    }

    results.push({
      name,
      normalizedName: normalizeName(name),
      position: posText,
      college: college || null,
      bigBoardRank: overallRank,
      projectedPick: projectedPick || null,
      projectedRound: projectedPick ? Math.ceil(projectedPick / 32) : null,
      devyClass: year,
    });
  });

  if (results.length === 0) {
    throw new Error(
      `No skill-position prospects parsed from NFLMDB ${year} big board — possible layout change or paywall block`
    );
  }

  return results;
}

module.exports = { fetchBigBoard, normalizeName };
