/**
 * OurLads NFL Depth Chart scraper
 * Scrapes position depth charts for all NFL teams.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.ourlads.com/nfldepthcharts/';

const POSITIONS = ['QB', 'RB', 'WR', 'TE'];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
};

async function fetchDepthCharts() {
  const { data: html } = await axios.get(BASE, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);
  const results = [];

  // OurLads depth chart layout: each row is a depth position for a player
  $('table.dc-table').each((_, table) => {
    // Try to find the team name from the section header
    const teamHeader = $(table).closest('section, div').find('h2, h3').first().text().trim();

    $(table).find('tr').each((rowIndex, row) => {
      const cells = $(row).find('td');
      if (cells.length < 2) return;
      const position = $(cells[0]).text().trim().toUpperCase();
      const depth = parseInt($(cells[1]).text().trim(), 10) || rowIndex + 1;
      const playerCell = $(cells[2] || cells[1]);
      const name = playerCell.find('a').text().trim() || playerCell.text().trim();

      if (POSITIONS.includes(position) && name) {
        results.push({ position, depthRank: depth, name, team: teamHeader });
      }
    });
  });

  // Fallback: try alternative table structure
  if (results.length === 0) {
    $('tr').each((_, row) => {
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      const pos = $(cells[0]).text().trim().toUpperCase();
      if (!POSITIONS.includes(pos)) return;
      const name = $(cells[2]).find('a').text().trim();
      if (name) results.push({ position: pos, depthRank: 1, name });
    });
  }

  return results;
}

module.exports = { fetchDepthCharts };
