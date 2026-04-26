import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 15000,
});

// Attach token to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('authToken');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Auth
export const login = (username) => api.post('/auth/login', { username }).then(r => r.data);
export const logout = () => api.post('/auth/logout').then(r => r.data);
export const getMe = () => api.get('/auth/me').then(r => r.data);

// Leagues
export const getLeagues = (year = '2026') => api.get('/leagues', { params: { year } }).then(r => r.data);
export const getLeague = (id) => api.get(`/leagues/${id}`).then(r => r.data);
export const getLeagueAlerts = (id, days = 30) => api.get(`/leagues/${id}/alerts`, { params: { days } }).then(r => r.data);

// Players
export const getPlayers = (params) => api.get('/players', { params }).then(r => r.data);
export const getPlayer = (id) => api.get(`/players/${id}`).then(r => r.data);
export const importPlayers = (players) => api.post('/players/import', { players }).then(r => r.data);
export const recalculateScores = () => api.post('/players/recalculate-scores').then(r => r.data);

// Draft
export const getActiveDrafts = () => api.get('/draft/active').then(r => r.data);
export const getDraftState = (draftId, mode) => api.get(`/draft/${draftId}`, { params: { mode } }).then(r => r.data);
export const getDraftTrades = (draftId, playerId) => api.get(`/draft/${draftId}/trades`, { params: { player: playerId } }).then(r => r.data);
export const getScoutingReport = (draftId, managerId) => api.get(`/draft/${draftId}/scouting/${managerId}`).then(r => r.data);

// Trade Hub
export const getTradeHubSuggestions = () => api.get('/tradehub').then(r => r.data);

// Admin
export const getDataStatus = () => api.get('/admin/data-status').then(r => r.data);
export const refreshRankings = () => api.post('/admin/refresh/rankings').then(r => r.data);
export const refreshDepthCharts = () => api.post('/admin/refresh/depth-charts').then(r => r.data);
export const triggerLearn = () => api.post('/admin/learn').then(r => r.data);
export const getManagerProfiles = () => api.get('/admin/manager-profiles').then(r => r.data);

export default api;
