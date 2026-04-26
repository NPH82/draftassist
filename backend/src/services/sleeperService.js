const axios = require('axios');

const BASE = 'https://api.sleeper.app/v1';

const http = axios.create({
  baseURL: BASE,
  timeout: 10000,
  headers: { 'Accept': 'application/json' },
});

// ── User ──────────────────────────────────────────────────────────────────────

async function getUser(username) {
  const { data } = await http.get(`/user/${username}`);
  return data;  // { user_id, username, display_name, avatar, ... }
}

// ── Leagues ───────────────────────────────────────────────────────────────────

async function getUserLeagues(userId, sport = 'nfl', season = '2026') {
  const { data } = await http.get(`/user/${userId}/leagues/${sport}/${season}`);
  return data;  // array of league objects
}

async function getLeague(leagueId) {
  const { data } = await http.get(`/league/${leagueId}`);
  return data;
}

// ── Rosters ───────────────────────────────────────────────────────────────────

async function getRosters(leagueId) {
  const { data } = await http.get(`/league/${leagueId}/rosters`);
  return data;  // array of roster objects
}

async function getLeagueUsers(leagueId) {
  const { data } = await http.get(`/league/${leagueId}/users`);
  return data;  // array of user objects with display names
}

// ── Drafts ────────────────────────────────────────────────────────────────────

async function getLeagueDrafts(leagueId) {
  const { data } = await http.get(`/league/${leagueId}/drafts`);
  return data;
}

async function getDraft(draftId) {
  const { data } = await http.get(`/draft/${draftId}`);
  return data;
}

async function getDraftPicks(draftId) {
  const { data } = await http.get(`/draft/${draftId}/picks`);
  return data;  // array of pick objects
}

async function getTradedPicks(draftId) {
  const { data } = await http.get(`/draft/${draftId}/traded_picks`);
  return data;
}

// ── Players ───────────────────────────────────────────────────────────────────

// Full player database -- large payload, cache aggressively
async function getAllPlayers(sport = 'nfl') {
  const { data } = await http.get(`/players/${sport}`);
  return data;  // map of player_id -> player object
}

async function getTrendingPlayers(sport = 'nfl', type = 'add', hours = 24, limit = 25) {
  const { data } = await http.get(`/players/${sport}/trending/${type}?lookback_hours=${hours}&limit=${limit}`);
  return data;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

async function getPlayerStats(sport, season, week) {
  const { data } = await http.get(`/stats/${sport}/${season}/${week}`);
  return data;
}

async function getProjections(sport, season, week) {
  const { data } = await http.get(`/projections/${sport}/${season}/${week}`);
  return data;
}

// ── Traded Picks (league) ─────────────────────────────────────────────────────

async function getLeagueTradedPicks(leagueId) {
  const { data } = await http.get(`/league/${leagueId}/traded_picks`);
  return data;
}

// ── Helper: build user map for a league ──────────────────────────────────────
// Returns { userId -> { username, displayName, avatar } }
async function buildUserMap(leagueId) {
  const users = await getLeagueUsers(leagueId);
  return Object.fromEntries(
    users.map(u => [u.user_id, {
      username: u.metadata?.team_name || u.display_name,
      displayName: u.display_name,
      avatar: u.avatar,
    }])
  );
}

// ── Helper: infer IsSuperFlex ─────────────────────────────────────────────────
function detectSuperFlex(rosterPositions) {
  return Array.isArray(rosterPositions) && rosterPositions.includes('SUPER_FLEX');
}

// ── Helper: infer isPPR ───────────────────────────────────────────────────────
function detectPpr(scoringSettings) {
  return scoringSettings && (scoringSettings.rec || 0) > 0;
}

module.exports = {
  getUser,
  getUserLeagues,
  getLeague,
  getRosters,
  getLeagueUsers,
  getLeagueDrafts,
  getDraft,
  getDraftPicks,
  getTradedPicks,
  getAllPlayers,
  getTrendingPlayers,
  getPlayerStats,
  getProjections,
  getLeagueTradedPicks,
  buildUserMap,
  detectSuperFlex,
  detectPpr,
};
