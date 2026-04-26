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

module.exports = { fetchDynastyRankings, fetchTradeValues };
