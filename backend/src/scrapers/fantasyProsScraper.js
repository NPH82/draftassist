/**
 * FantasyPros Dynasty Rankings scraper
 * Targets the dynasty trade value chart page.
 * Falls back to cached DB data if blocked.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const FP_URL = 'https://www.fantasypros.com/nfl/rankings/dynasty-overall.php';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
};

async function fetchDynastyRankings() {
  const { data: html } = await axios.get(FP_URL, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const results = [];

  // FantasyPros renders rankings in a table with class "fp-table"
  $('table.fp-table tbody tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;
    const rank = parseInt($(cells[0]).text().trim(), 10);
    const name = $(cells[1]).find('.player-name').text().trim() || $(cells[1]).text().trim();
    const value = parseFloat($(cells[2]).text().replace(/,/g, '').trim()) || null;
    if (name) results.push({ rank, name, value });
  });

  if (results.length === 0) throw new Error('No rows parsed from FantasyPros -- possible block or layout change');
  return results;
}

// Trade value chart (separate endpoint)
const FP_TV_URL = 'https://www.fantasypros.com/nfl/trade-value/dynasty.php';

async function fetchTradeValues() {
  const { data: html } = await axios.get(FP_TV_URL, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const results = [];

  $('table tbody tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;
    const name = $(cells[0]).text().trim();
    const value = parseFloat($(cells[1]).text().replace(/,/g, '').trim()) || null;
    if (name && value) results.push({ name, value, rank: i + 1 });
  });

  return results;
}

/**
 * FantasyPros devy fantasy football rankings.
 * FP publishes a devy rankings page; the URL and HTML structure are subject to change.
 * Falls back gracefully — callers should treat an empty array as "unavailable".
 */
const FP_DEVY_URLS = [
  'https://www.fantasypros.com/nfl/rankings/devy-overall.php',
  'https://www.fantasypros.com/nfl/rankings/devy.php',
];

async function fetchDevyRankings() {
  let html = null;

  for (const url of FP_DEVY_URLS) {
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      html = resp.data;
      break;
    } catch {
      // try next URL
    }
  }

  if (!html) throw new Error('FantasyPros devy rankings page unavailable (all URLs failed)');

  const $ = cheerio.load(html);
  const results = [];

  // FP devy page likely uses the same fp-table pattern as dynasty
  $('table.fp-table tbody tr, table tbody tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 2) return;

    const rankText = $(cells[0]).text().trim();
    const rank = parseInt(rankText, 10) || (i + 1);

    // Player name: FP usually wraps it in .player-name or a link
    const nameEl = $(cells[1]).find('.player-name, a').first();
    const name = nameEl.length ? nameEl.text().trim() : $(cells[1]).text().trim();
    if (!name || name.length < 2) return;

    // Some pages embed JSON data in a script tag — we prefer the table parse.
    results.push({ rank, name });
  });

  // Fallback: try JSON embedded in the page (FP sometimes uses window.ecrData)
  if (results.length === 0) {
    const scriptMatch = html.match(/window\.ecrData\s*=\s*({[\s\S]*?});/);
    if (scriptMatch) {
      try {
        const ecrData = JSON.parse(scriptMatch[1]);
        const players = ecrData.players || ecrData.rankings || [];
        players.forEach((p, i) => {
          const name = p.player_name || p.name;
          if (name) results.push({ rank: p.rank || i + 1, name });
        });
      } catch { /* ignore parse error */ }
    }
  }

  if (results.length === 0) {
    throw new Error('No rows parsed from FantasyPros devy rankings — possible block or layout change');
  }

  return results;
}

module.exports = { fetchDynastyRankings, fetchTradeValues, fetchDevyRankings };
