import { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { getDraftState } from '../services/api';

const DraftContext = createContext(null);

const POLL_INTERVAL_MS = 8000; // 8 sec
const AUTO_DISMISS_MS = 8000;
const MAX_VISIBLE_ALERTS = 3;
const MAX_NON_TARGET_ALERTS = 2;

function getAlertPlayerId(alert = {}) {
  const sleeperId = String(alert?.player?.sleeperId || '').trim();
  if (sleeperId) return sleeperId;
  const playerId = String(alert?.player?.id || '').trim();
  if (playerId) return playerId;
  return '';
}

function withAlertMeta(alert = {}) {
  const playerId = getAlertPlayerId(alert);
  const stableId = alert.type === 'faller' && playerId
    ? `faller:${playerId}`
    : `${alert.type || 'alert'}:${Date.now()}:${Math.random()}`;

  return {
    ...alert,
    id: alert.id || stableId,
    playerKey: playerId || null,
    createdAt: Number(alert.createdAt || Date.now()),
  };
}

function trimAlertsByPolicy(alerts = [], targetPlayerId = null) {
  const targetId = String(targetPlayerId || '').trim();
  const ordered = [...alerts].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));

  const targetAlerts = [];
  const nonTargetAlerts = [];
  for (const alert of ordered) {
    const isTarget = !!(targetId && alert.type === 'faller' && alert.playerKey === targetId);
    if (isTarget) targetAlerts.push(alert);
    else nonTargetAlerts.push(alert);
  }

  const pinnedTarget = targetAlerts.length ? [targetAlerts[0]] : [];
  const keptNonTarget = nonTargetAlerts.slice(0, MAX_NON_TARGET_ALERTS);
  return [...pinnedTarget, ...keptNonTarget].slice(0, MAX_VISIBLE_ALERTS);
}

function buildDismissedStorageKey() {
  const token = localStorage.getItem('authToken');
  if (!token) return 'dismissedFallerAlerts:anon';
  return `dismissedFallerAlerts:${token}`;
}

export function DraftProvider({ draftId, children }) {
  const [draftState, setDraftState] = useState(null);
  const [mode, setMode] = useState('team_need'); // 'team_need' | 'bpa'
  const [queue, setQueue] = useState([]);       // user's manually ordered draft queue
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const prevPickCount = useRef(0);
  const pollRef = useRef(null);
  const queueRef = useRef(queue);
  const dismissedStorageKeyRef = useRef(buildDismissedStorageKey());
  const dismissedFallerIdsRef = useRef(new Set());

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    const storageKey = buildDismissedStorageKey();
    dismissedStorageKeyRef.current = storageKey;
    try {
      const raw = localStorage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      dismissedFallerIdsRef.current = new Set(Array.isArray(parsed) ? parsed.map((v) => String(v || '').trim()).filter(Boolean) : []);
    } catch {
      dismissedFallerIdsRef.current = new Set();
    }
  }, []);

  const persistDismissedFallerIds = useCallback(() => {
    try {
      const key = dismissedStorageKeyRef.current;
      localStorage.setItem(key, JSON.stringify([...dismissedFallerIdsRef.current]));
    } catch {
      // Best effort only.
    }
  }, []);

  const markFallerDismissed = useCallback((alert = {}) => {
    if (alert.type !== 'faller') return;
    const playerId = getAlertPlayerId(alert);
    if (!playerId) return;
    dismissedFallerIdsRef.current.add(playerId);
    persistDismissedFallerIds();
  }, [persistDismissedFallerIds]);

  const fetchState = useCallback(async () => {
    try {
      const data = await getDraftState(draftId, mode);
      setDraftState(data);

      // Detect new picks -- remove them from queue using functional update (avoids stale queue closure)
      if (data.available) {
        const availableIds = new Set(data.available.map(p => p.sleeperId || p._id?.toString()));
        setQueue(q => q.filter(id => availableIds.has(id)));
      }

      // Faller alerts
      setAlerts(prev => {
        const targetPlayerId = String((queueRef.current?.[0] || '')).trim();
        const existingById = new Map(prev.map((alert) => [alert.id, alert]));

        for (const rawAlert of (data.fallerAlerts || [])) {
          const playerId = getAlertPlayerId(rawAlert);
          if (playerId && dismissedFallerIdsRef.current.has(playerId)) continue;
          const normalized = withAlertMeta({ ...rawAlert, type: 'faller' });
          existingById.set(normalized.id, {
            ...(existingById.get(normalized.id) || {}),
            ...normalized,
          });
        }

        return trimAlertsByPolicy([...existingById.values()], targetPlayerId);
      });

      prevPickCount.current = data.currentPick;
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [draftId, mode]); // queue removed — setQueue functional update avoids stale closure

  // Initial load + poll — re-runs whenever fetchState changes (i.e. draftId or mode changes)
  useEffect(() => {
    if (!draftId) return;
    fetchState();
    pollRef.current = setInterval(fetchState, POLL_INTERVAL_MS);
    return () => clearInterval(pollRef.current);
  }, [fetchState]);

  // Auto-dismiss only non-target alerts; target alert remains pinned.
  useEffect(() => {
    if (alerts.length === 0) return;
    const targetPlayerId = String((queue[0] || '')).trim();
    const nonTarget = alerts.find((alert) => !(targetPlayerId && alert.type === 'faller' && alert.playerKey === targetPlayerId));
    if (!nonTarget) return;

    const timer = setTimeout(() => {
      setAlerts((current) => current.filter((alert) => alert.id !== nonTarget.id));
      markFallerDismissed(nonTarget);
    }, AUTO_DISMISS_MS);

    return () => clearTimeout(timer);
  }, [alerts, queue, markFallerDismissed]);

  // Re-apply cap rules whenever target selection changes.
  useEffect(() => {
    const targetPlayerId = String((queue[0] || '')).trim();
    setAlerts((current) => trimAlertsByPolicy(current, targetPlayerId));
  }, [queue]);

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
    setAlerts((current) => {
      const alert = current.find((item) => item.id === alertId);
      if (alert) markFallerDismissed(alert);
      return current.filter((item) => item.id !== alertId);
    });
  }, [markFallerDismissed]);

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
