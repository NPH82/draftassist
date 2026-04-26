/**
 * Underdog Fantasy ADP scraper
 * Fetches best-ball / dynasty ADP data.
 */

const axios = require('axios');

// Underdog has a public ADP API
const UNDERDOG_API = 'https://underdogfantasy.com/api/v3/players/adp?sport=NFL&game_type=dynasty';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
};

async function fetchAdp() {
  try {
    const { data } = await axios.get(UNDERDOG_API, { headers: HEADERS, timeout: 15000 });
    const players = data.players || data || [];

    return players.map(p => ({
      name: p.full_name || `${p.first_name} ${p.last_name}`.trim(),
      position: (p.position || '').toUpperCase(),
      adp: p.adp ?? p.average_draft_position,
      team: p.team,
    })).filter(p => p.name && p.adp != null);
  } catch {
    // Fallback to best-ball ADP if dynasty endpoint unavailable
    const { data } = await axios.get(
      'https://underdogfantasy.com/api/v3/players/adp?sport=NFL&game_type=best_ball',
      { headers: HEADERS, timeout: 15000 }
    );
    const players = data.players || data || [];
    return players.map(p => ({
      name: p.full_name || `${p.first_name} ${p.last_name}`.trim(),
      position: (p.position || '').toUpperCase(),
      adp: p.adp ?? p.average_draft_position,
      team: p.team,
    })).filter(p => p.name && p.adp != null);
  }
}

module.exports = { fetchAdp };
