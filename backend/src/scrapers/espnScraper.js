/**
 * ESPN 2026 NFL Draft Results scraper
 */

const axios = require('axios');
const cheerio = require('cheerio');

const ESPN_URL = 'https://www.espn.com/nfl/draft/rounds';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
};

async function fetchDraftResults(year = 2026) {
  const url = `${ESPN_URL}/_/year/${year}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);
  const picks = [];

  // ESPN uses a list of picks grouped by round
  $('[class*="pick__"]').each((_, el) => {
    const name = $(el).find('[class*="playerName"]').text().trim();
    const position = $(el).find('[class*="position"]').text().trim().toUpperCase();
    const team = $(el).find('[class*="teamName"]').text().trim();
    const pickText = $(el).find('[class*="pickNumber"], [class*="pick__number"]').text().trim();
    const pickNumber = parseInt(pickText, 10) || null;

    if (name && pickNumber) {
      const round = Math.ceil(pickNumber / 32);
      picks.push({ name, position, team, pickNumber, round });
    }
  });

  // Fallback: look for table structure
  if (picks.length === 0) {
    $('table tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;
      const pickNumber = parseInt($(cells[0]).text().trim(), 10);
      const name = $(cells[2]).find('a').text().trim() || $(cells[2]).text().trim();
      const position = $(cells[3]).text().trim().toUpperCase();
      const team = $(cells[1]).text().trim();
      if (pickNumber && name) picks.push({ name, position, team, pickNumber, round: Math.ceil(pickNumber / 32) });
    });
  }

  return picks;
}

module.exports = { fetchDraftResults };
