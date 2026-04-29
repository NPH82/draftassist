const axios = require('axios');

const BASE = 'https://api.sleeper.app/v1';

const http = axios.create({
  baseURL: BASE,
  timeout: 10000,
  headers: { 'Accept': 'application/json' },
});

// Short-lived per-league caches to reduce duplicate upstream requests.
const LEAGUE_USERS_TTL_MS = 60 * 1000; // 60s
const LEAGUE_ROSTERS_TTL_MS = 45 * 1000; // 45s
const _leagueUsersCache = new Map(); // key -> { value, at }
const _leagueRostersCache = new Map(); // key -> { value, at }
const _leagueUsersInFlight = new Map(); // key -> Promise
const _leagueRostersInFlight = new Map(); // key -> Promise
const DRAFT_TTL_MS = 20 * 1000; // 20s
const DRAFT_PICKS_TTL_MS = 15 * 1000; // 15s
const _draftCache = new Map(); // key -> { value, at }
const _draftPicksCache = new Map(); // key -> { value, at }
const _draftInFlight = new Map(); // key -> Promise
const _draftPicksInFlight = new Map(); // key -> Promise

function getCachedValue(cache, key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if ((Date.now() - hit.at) > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

async function getOrLoadWithDedup({ cache, inFlight, key, ttlMs, loader }) {
  const cached = getCachedValue(cache, key, ttlMs);
  if (cached) return cached;

  if (inFlight.has(key)) return inFlight.get(key);

  const promise = (async () => {
    try {
      const value = await loader();
      cache.set(key, { value, at: Date.now() });
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// ── User ──────────────────────────────────────────────────────────────────────

async function getUser(username) {
  const { data } = await http.get(`/user/${username}`);
  return data;  // { user_id, username, display_name, avatar, ... }
}

// ── Leagues ───────────────────────────────────────────────────────────────────

async function getUserLeagues(userId, sport = 'nfl', season = String(new Date().getFullYear())) {
  const { data } = await http.get(`/user/${userId}/leagues/${sport}/${season}`);
  return data;  // array of league objects
}

async function getLeague(leagueId) {
  const { data } = await http.get(`/league/${leagueId}`);
  return data;
}

// ── Rosters ───────────────────────────────────────────────────────────────────

async function getRosters(leagueId) {
  const key = String(leagueId);
  return getOrLoadWithDedup({
    cache: _leagueRostersCache,
    inFlight: _leagueRostersInFlight,
    key,
    ttlMs: LEAGUE_ROSTERS_TTL_MS,
    loader: async () => {
      const { data } = await http.get(`/league/${leagueId}/rosters`);
      return data; // array of roster objects
    },
  });
}

async function getLeagueUsers(leagueId) {
  const key = String(leagueId);
  return getOrLoadWithDedup({
    cache: _leagueUsersCache,
    inFlight: _leagueUsersInFlight,
    key,
    ttlMs: LEAGUE_USERS_TTL_MS,
    loader: async () => {
      const { data } = await http.get(`/league/${leagueId}/users`);
      return data; // array of user objects with display names
    },
  });
}

// ── Drafts ────────────────────────────────────────────────────────────────────

async function getLeagueDrafts(leagueId) {
  const { data } = await http.get(`/league/${leagueId}/drafts`);
  return data;
}

async function getDraft(draftId) {
  const key = String(draftId);
  return getOrLoadWithDedup({
    cache: _draftCache,
    inFlight: _draftInFlight,
    key,
    ttlMs: DRAFT_TTL_MS,
    loader: async () => {
      const { data } = await http.get(`/draft/${draftId}`);
      return data;
    },
  });
}

async function getDraftPicks(draftId) {
  const key = String(draftId);
  return getOrLoadWithDedup({
    cache: _draftPicksCache,
    inFlight: _draftPicksInFlight,
    key,
    ttlMs: DRAFT_PICKS_TTL_MS,
    loader: async () => {
      const { data } = await http.get(`/draft/${draftId}/picks`);
      return data; // array of pick objects
    },
  });
}

async function getTradedPicks(draftId) {
  const { data } = await http.get(`/draft/${draftId}/traded_picks`);
  return data;
}

// ── Players ───────────────────────────────────────────────────────────────────

// In-memory cache for the full player list (large ~2MB payload, changes rarely)
let _allPlayersCache = null;
let _allPlayersCacheAt = 0;
const ALL_PLAYERS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Full player database -- large payload, cache aggressively
async function getAllPlayers(sport = 'nfl') {
  const now = Date.now();
  if (_allPlayersCache && now - _allPlayersCacheAt < ALL_PLAYERS_TTL_MS) {
    return _allPlayersCache;
  }
  const { data } = await http.get(`/players/${sport}`);
  _allPlayersCache = data;
  _allPlayersCacheAt = now;
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
      username: u.display_name || u.username || u.metadata?.team_name || 'Unknown',
      teamName: u.metadata?.team_name || null,
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
