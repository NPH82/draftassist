/**
 * KeepTradeCut Dynasty Values scraper
 * KTC exposes dynasty values via their API endpoint.
 */

const axios = require('axios');

const KTC_API = 'https://keeptradecut.com/api/players?format=2&type=dynasty&position[]=QB&position[]=RB&position[]=WR&position[]=TE';
const KTC_DEVY_API = 'https://keeptradecut.com/api/players?format=2&type=devy&position[]=QB&position[]=RB&position[]=WR&position[]=TE';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
  'Referer': 'https://keeptradecut.com/dynasty-rankings',
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
 * Fetch KTC devy (college prospect) rankings.
 * Returns players with their devy-specific dynasty values.
 * KTC devy values use a separate scale than dynasty values — typically 0–8000+.
 */
async function fetchDevyValues() {
  const { data } = await axios.get(KTC_DEVY_API, {
    headers: { ...HEADERS, Referer: 'https://keeptradecut.com/devy-rankings' },
    timeout: 15000,
  });
  const players = Array.isArray(data) ? data : data.players || [];

  return players.map((p, i) => ({
    name: p.playerName || p.name,
    position: p.position,
    value: p.value ?? p.overallValue ?? 0,
    rank: p.rank ?? i + 1,
    ktcId: p.playerID || p.id,
    college: p.college || p.team || null,
    // KTC sometimes exposes expected draft year
    devyClass: p.draftYear || p.draft_year || null,
  })).filter(p => p.name);
}

module.exports = { fetchDynastyValues, fetchDevyValues };
