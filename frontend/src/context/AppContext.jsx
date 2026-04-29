import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getMe, login as apiLogin, logout as apiLogout, getLeagues, updateLeaguePreferences as apiUpdateLeaguePreferences } from '../services/api';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [leagues, setLeagues] = useState([]);
  const [loadingUser, setLoadingUser] = useState(true);
  const [loadingLeagues, setLoadingLeagues] = useState(false);
  const [error, setError] = useState(null);

  // Restore session on mount
  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (!token) { setLoadingUser(false); return; }

    setLoadingLeagues(true);

    getMe()
      .then(async (u) => {
        setUser(u);
        try {
          const data = await getLeagues();
          setLeagues(data.leagues || []);
          setError(null);
        } catch {
          // Keep authenticated session even if league sync fails temporarily.
          setLeagues([]);
          setError('Could not load leagues right now. Pull to refresh in a moment.');
        }
      })
      .catch(() => { localStorage.removeItem('authToken'); })
      .finally(() => {
        setLoadingUser(false);
        setLoadingLeagues(false);
      });
  }, []);

  const login = useCallback(async (username) => {
    setLoadingLeagues(true);
    const data = await apiLogin(username);
    localStorage.setItem('authToken', data.token);
    setUser(data.user);
    try {
      const lg = await getLeagues();
      setLeagues(lg.leagues || []);
      setError(null);
    } catch {
      setLeagues([]);
      setError('Could not load leagues right now. Pull to refresh in a moment.');
    } finally {
      setLoadingLeagues(false);
    }
    return data;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout().catch(() => {});
    localStorage.removeItem('authToken');
    setUser(null);
    setLeagues([]);
    setLoadingLeagues(false);
  }, []);

  const refreshLeagues = useCallback(async () => {
    setLoadingLeagues(true);
    try {
      const data = await getLeagues();
      setLeagues(data.leagues || []);
      setError(null);
    } catch {
      setLeagues([]);
      setError('Could not load leagues right now. Pull to refresh in a moment.');
    } finally {
      setLoadingLeagues(false);
    }
  }, []);

  const updateLeaguePreferences = useCallback(async (leagueId, updates) => {
    const response = await apiUpdateLeaguePreferences(leagueId, updates);
    setLeagues((current) => current.map((league) => (
      league.leagueId === leagueId
        ? {
            ...league,
            ...(typeof response.devyEnabled === 'boolean' ? { devyEnabled: response.devyEnabled } : {}),
            ...(typeof response.idpEnabled === 'boolean' ? { idpEnabled: response.idpEnabled } : {}),
          }
        : league
    )));
    return response;
  }, []);

  return (
    <AppContext.Provider value={{ user, leagues, loadingUser, loadingLeagues, error, login, logout, refreshLeagues, updateLeaguePreferences }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
};
