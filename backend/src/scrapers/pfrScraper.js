/**
 * Pro Football Reference scraper
 * Fetches combine data, college stats, and NFL injury history for rookies.
 */

const axios = require('axios');
const cheerio = require('cheerio');

const PFR_BASE = 'https://www.pro-football-reference.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
};

// Combine data for a given draft year
async function fetchCombineData(year = 2026) {
  const url = `${PFR_BASE}/draft/${year}-combine.htm`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);
  const results = [];

  $('table#combine tbody tr').each((_, row) => {
    if ($(row).hasClass('thead')) return;
    const cells = $(row).find('td, th');
    const name = $(row).find('[data-stat="player"] a').text().trim();
    if (!name) return;

    const pos = $(row).find('[data-stat="pos"]').text().trim().toUpperCase();
    const college = $(row).find('[data-stat="school_name"]').text().trim();
    const fortyTime = parseFloat($(row).find('[data-stat="forty_yd"]').text().trim()) || null;
    const verticalJump = parseFloat($(row).find('[data-stat="vertical"]').text().trim()) || null;
    const broadJump = parseFloat($(row).find('[data-stat="broad_jump"]').text().trim()) || null;

    results.push({ name, position: pos, college, fortyTime, verticalJump, broadJump });
  });

  return results;
}

// NFL injury data from player page (if needed for specific player)
async function fetchPlayerInjuryHistory(pfrPath) {
  const url = `${PFR_BASE}${pfrPath}`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const injuries = [];

  $('table#injuries tbody tr').each((_, row) => {
    const season = parseInt($(row).find('[data-stat="year_id"]').text().trim(), 10);
    const description = $(row).find('[data-stat="inj_detail"]').text().trim();
    const games = parseInt($(row).find('[data-stat="games_missed"]').text().trim(), 10) || 0;
    if (season && description) injuries.push({ season, description, games });
  });

  return injuries;
}

// Combine stats + college data in one pass
async function fetchCombineAndCollegeStats(year = 2026) {
  return fetchCombineData(year);
}

// ── College stats (sports-reference.com/cfb) ──────────────────────────────────

const CFB_BASE = 'https://www.sports-reference.com/cfb';

/**
 * College receiving stats for a given season year.
 * Returns: [{ name, school, collegeYardsPerRec, collegeTDs, rec, recYards }]
 */
async function fetchCollegeReceivingStats(year = 2025) {
  const url =
    `${CFB_BASE}/play-index/pgl_finder.fcgi?request=1&match=player` +
    `&year_min=${year}&year_max=${year}` +
    `&c1stat=rec_yds&c1comp=gt&c1val=50&order_by=ypr`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);
  const results = [];

  $('table#results tbody tr').each((_, row) => {
    if ($(row).hasClass('thead') || $(row).hasClass('partial_table')) return;
    const name = $(row).find('[data-stat="player"] a').text().trim();
    if (!name) return;

    const school   = $(row).find('[data-stat="school_name"]').text().trim();
    const rec      = parseInt($(row).find('[data-stat="rec"]').text().trim(), 10)            || 0;
    const recYards = parseInt($(row).find('[data-stat="rec_yds"]').text().trim().replace(/,/g, ''), 10) || 0;
    const ypr      = parseFloat($(row).find('[data-stat="ypr"]').text().trim())              || null;
    const tds      = parseInt($(row).find('[data-stat="rec_td"]').text().trim(), 10)         || 0;

    results.push({ name, school, rec, recYards, collegeYardsPerRec: ypr, collegeTDs: tds });
  });

  return results;
}

/**
 * College rushing stats for a given season year.
 * Returns: [{ name, school, collegeRushYpc, rushAtt, rushYards }]
 */
async function fetchCollegeRushingStats(year = 2025) {
  const url =
    `${CFB_BASE}/play-index/pgl_finder.fcgi?request=1&match=player` +
    `&year_min=${year}&year_max=${year}` +
    `&c1stat=rush_att&c1comp=gt&c1val=50&order_by=rush_ypc`;
  const { data: html } = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  const $ = cheerio.load(html);
  const results = [];

  $('table#results tbody tr').each((_, row) => {
    if ($(row).hasClass('thead') || $(row).hasClass('partial_table')) return;
    const name = $(row).find('[data-stat="player"] a').text().trim();
    if (!name) return;

    const school    = $(row).find('[data-stat="school_name"]').text().trim();
    const rushAtt   = parseInt($(row).find('[data-stat="rush_att"]').text().trim(), 10)           || 0;
    const rushYards = parseInt($(row).find('[data-stat="rush_yds"]').text().trim().replace(/,/g, ''), 10) || 0;
    const ypc       = parseFloat($(row).find('[data-stat="rush_ypc"]').text().trim())             || null;

    results.push({ name, school, rushAtt, rushYards, collegeRushYpc: ypc });
  });

  return results;
}

module.exports = {
  fetchCombineData,
  fetchPlayerInjuryHistory,
  fetchCombineAndCollegeStats,
  fetchCollegeReceivingStats,
  fetchCollegeRushingStats,
};
