/**
 * KeepTradeCut Dynasty Values scraper
 * KTC exposes dynasty values via their API endpoint.
 */

const axios = require('axios');

const KTC_API = 'https://keeptradecut.com/api/players?format=2&type=dynasty&position[]=QB&position[]=RB&position[]=WR&position[]=TE';

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

module.exports = { fetchDynastyValues };
