/**
 * KeepTradeCut Dynasty Values scraper
 * KTC exposes dynasty values via their API endpoint.
 * Devy values must be scraped from HTML (API endpoint was removed).
 */

const axios = require('axios');
const cheerio = require('cheerio');

const KTC_API = 'https://keeptradecut.com/api/players?format=2&type=dynasty&position[]=QB&position[]=RB&position[]=WR&position[]=TE';
const KTC_DEVY_PAGE = 'https://keeptradecut.com/devy-rankings';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Referer': 'https://keeptradecut.com/',
};

async function fetchDynastyValues() {
  const { data } = await axios.get(KTC_API, { headers: HEADERS, timeout: 15000 });
  // KTC returns array of { playerName, position, value, rank, ... }
  const players = Array.isArray(data) ? data : data.players || [];

  return players.map((p, i) => ({
    name: p.playerName || p.name,
    position: p.position,
    value: p.value ?? p.overallValue,
    rank: p.rank ?? i + 1,
    ktcId: p.playerID || p.id,
  })).filter(p => p.name);
}

/**
 * Fetch KTC devy (college prospect) rankings by scraping the HTML rankings page.
 * The JSON API endpoint for devy was removed; the HTML page shows all 94 devy players.
 *
 * Page structure: each player row has an anchor with href matching
 * /devy-rankings/players/<slug>-<id>. Sibling text holds position tier, college
 * abbreviation, draft year (eligible), and KTC value.
 */
async function fetchDevyValues() {
  const { data: html } = await axios.get(KTC_DEVY_PAGE, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);

  const results = [];
  let rank = 0;

  // Each player is linked via /devy-rankings/players/
  $('a[href*="/devy-rankings/players/"]').each((_, playerEl) => {
    const name = $(playerEl).text().trim();
    if (!name) return;

    rank++;

    // Walk up to find the row container
    let container = $(playerEl);
    for (let d = 0; d < 6; d++) {
      container = container.parent();
      const txt = container.text();
      // A valid row contains both a numeric value (KTC score) and an ELIGIBLE year
      if (/\b(202[6-9]|203\d)\b/.test(txt) && /\b\d{4,5}\b/.test(txt)) break;
    }

    const rowText = container.text();

    // Draft year (ELIGIBLE column): 2026-2035
    const yearMatch = rowText.match(/\b(202[6-9]|203\d)\b/);
    const devyClass = yearMatch ? parseInt(yearMatch[1], 10) : null;

    // Position: WR1, QB2 etc. → normalise to just QB/RB/WR/TE
    const posMatch = rowText.match(/\b(QB|RB|WR|TE)\d*/);
    const position = posMatch ? posMatch[1] : null;

    // College abbreviation: appears right after the player name link as text
    // It's the short tag like "OSU", "TEX", "ALA" — grab it from the parent text
    // by removing the player name and other numeric/keyword tokens
    let college = null;
    const afterName = rowText.replace(name, '').trim();
    const collegeMatch = afterName.match(/^([A-Z&]{2,6})\b/);
    if (collegeMatch) college = collegeMatch[1];

    // KTC Value: largest standalone integer in the row (typically 4-5 digits)
    const allNums = [...rowText.matchAll(/\b(\d{3,5})\b/g)].map(m => parseInt(m[1], 10));
    // Filter out the year (4-digit year number) and rank number
    const value = allNums.filter(n => n > 100 && n < 12000 && n !== devyClass && n !== rank)
      .sort((a, b) => b - a)[0] || 0;

    if (!name || !position) return;

    results.push({
      name,
      position,
      value,
      rank,
      college: college || null,
      devyClass,
    });
  });

  if (results.length === 0) {
    throw new Error('KTC devy HTML parse returned 0 results — page layout may have changed');
  }

  return results;
}

module.exports = { fetchDynastyValues, fetchDevyValues };
