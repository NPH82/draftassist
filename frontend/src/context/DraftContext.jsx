import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getDraftState } from '../services/api';

const DraftContext = createContext(null);

const POLL_INTERVAL_MS = 8000; // 8 sec

export function DraftProvider({ draftId, children }) {
  const [draftState, setDraftState] = useState(null);
  const [mode, setMode] = useState('team_need'); // 'team_need' | 'bpa'
  const [queue, setQueue] = useState([]);       // user's manually ordered draft queue
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const prevPickCount = useRef(0);
  const pollRef = useRef(null);

  const fetchState = useCallback(async () => {
    try {
      const data = await getDraftState(draftId, mode);
      setDraftState(data);

      // Detect new picks -- remove them from queue
      if (data.available && queue.length > 0) {
        const availableIds = new Set(data.available.map(p => p.sleeperId || p._id?.toString()));
        setQueue(q => q.filter(id => availableIds.has(id)));
      }

      // Faller alerts
      if (data.fallerAlerts?.length > 0) {
        setAlerts(prev => {
          const existingIds = new Set(prev.map(a => a.player?.sleeperId));
          const newAlerts = data.fallerAlerts.filter(a => !existingIds.has(a.player?.sleeperId));
          return [...prev, ...newAlerts.map(a => ({ ...a, type: 'faller', id: Date.now() + Math.random() }))];
        });
      }

      prevPickCount.current = data.currentPick;
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [draftId, mode, queue]);

  // Initial load + poll
  useEffect(() => {
    if (!draftId) return;
    fetchState();
    pollRef.current = setInterval(fetchState, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [draftId, mode]);

  // Dismiss alert after 8 seconds
  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = setTimeout(() => setAlerts(a => a.slice(1)), 8000);
    return () => clearTimeout(timer);
  }, [alerts]);

  const addToQueue = useCallback((playerId) => {
    setQueue(q => q.includes(playerId) ? q : [...q, playerId]);
  }, []);

  const removeFromQueue = useCallback((playerId) => {
    setQueue(q => q.filter(id => id !== playerId));
  }, []);

  const reorderQueue = useCallback((newOrder) => {
    setQueue(newOrder);
  }, []);

  const dismissAlert = useCallback((alertId) => {
    setAlerts(a => a.filter(x => x.id !== alertId));
  }, []);

  return (
    <DraftContext.Provider value={{
      draftState, mode, setMode,
      queue, addToQueue, removeFromQueue, reorderQueue,
      alerts, dismissAlert,
      loading, error,
      refresh: fetchState,
    }}>
      {children}
    </DraftContext.Provider>
  );
}

export const useDraft = () => {
  const ctx = useContext(DraftContext);
  if (!ctx) throw new Error('useDraft must be used inside DraftProvider');
  return ctx;
};
