import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getMe, login as apiLogin, logout as apiLogout, getLeagues } from '../services/api';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [leagues, setLeagues] = useState([]);
  const [loadingUser, setLoadingUser] = useState(true);
  const [error, setError] = useState(null);

  // Restore session on mount
  useEffect(() => {
    const token = localStorage.getItem('authToken');
    if (!token) { setLoadingUser(false); return; }

    getMe()
      .then(u => { setUser(u); return getLeagues(); })
      .then(data => setLeagues(data.leagues || []))
      .catch(() => { localStorage.removeItem('authToken'); })
      .finally(() => setLoadingUser(false));
  }, []);

  const login = useCallback(async (username) => {
    const data = await apiLogin(username);
    localStorage.setItem('authToken', data.token);
    setUser(data.user);
    const lg = await getLeagues();
    setLeagues(lg.leagues || []);
    return data;
  }, []);

  const logout = useCallback(async () => {
    await apiLogout().catch(() => {});
    localStorage.removeItem('authToken');
    setUser(null);
    setLeagues([]);
  }, []);

  const refreshLeagues = useCallback(async () => {
    const data = await getLeagues();
    setLeagues(data.leagues || []);
  }, []);

  return (
    <AppContext.Provider value={{ user, leagues, loadingUser, error, login, logout, refreshLeagues }}>
      {children}
    </AppContext.Provider>
  );
}

export const useApp = () => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
};
