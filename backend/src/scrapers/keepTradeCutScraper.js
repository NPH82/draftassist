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
 * The JSON API endpoint for devy was removed; the HTML page embeds a `playersArray`
 * script payload that includes clean playerName/position/draftYear/value fields.
 */
async function fetchDevyValues() {
  const { data: html } = await axios.get(KTC_DEVY_PAGE, { headers: HEADERS, timeout: 20000 });
  const page = String(html || '');
  const playersArrayMatch = page.match(/var\s+playersArray\s*=\s*(\[[\s\S]*?\]);/);
  if (!playersArrayMatch) {
    throw new Error('KTC devy page did not expose playersArray payload');
  }

  let playersArray;
  try {
    playersArray = JSON.parse(playersArrayMatch[1]);
  } catch (err) {
    throw new Error(`Failed to parse KTC playersArray payload: ${err.message}`);
  }

  const results = (Array.isArray(playersArray) ? playersArray : []).map((p) => {
    const sf = p?.superflexValues || {};
    const oneQb = p?.oneQBValues || {};
    const value = Number(sf.value ?? oneQb.value ?? 0) || 0;
    const rank = Number(sf.rank ?? oneQb.rank ?? 0) || null;
    const devyClass = Number(p?.draftYear || p?.seasonsExperience || 0) || null;

    return {
      name: p?.playerName || null,
      position: p?.position || null,
      value,
      rank,
      college: p?.team || null,
      devyClass,
    };
  }).filter((p) => p.name && p.position);

  if (results.length === 0) {
    throw new Error('KTC devy parse returned 0 results — payload shape may have changed');
  }

  return results;
}

module.exports = { fetchDynastyValues, fetchDevyValues };
