import { useState, useEffect, useRef } from 'react';
import { useApp } from '../../context/AppContext';
import { getManagerProfiles, getLeagueManagerProfiles, searchManagers } from '../../services/api';
import WinWindowBadge from '../WinWindow/WinWindowBadge';

const POS_COLOR = { QB: 'var(--blue)', RB: 'var(--green)', WR: 'var(--yellow)', TE: 'var(--red)' };

const WIN_WINDOW_ORDER = ['Win Now', 'Contending', 'Transitioning', 'Rebuilding'];

function ManagerCard({ p, showWinWindow }) {
  const [expanded, setExpanded] = useState(false);
  const hasData = p.totalPicksObserved > 0;

  return (
    <div
      style={{
        background: 'var(--bg-primary)',
        borderRadius: 6,
        padding: '0.6rem 0.75rem',
        border: p.isCurrentUser ? '1px solid var(--blue)' : '1px solid var(--border)',
        opacity: hasData ? 1 : 0.6,
      }}
    >
      {/* Header row */}
      <div className="flex justify-between items-start" style={{ gap: '0.5rem' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center" style={{ gap: '0.4rem' }}>
            <span className="font-semibold text-sm" style={{ wordBreak: 'break-all' }}>
              {p.username || p.sleeperId}
            </span>
            {p.isCurrentUser && (
              <span className="badge text-xs" style={{ background: '#1e3a5f', color: 'var(--blue)', flexShrink: 0 }}>You</span>
            )}
          </div>
          <span className="text-xs text-muted">
            {p.draftsObserved} draft{p.draftsObserved !== 1 ? 's' : ''} · {p.totalPicksObserved} picks
          </span>
        </div>

        {/* Win-window badge (league view only) */}
        {showWinWindow && p.winWindowLabel && (
          <div style={{ flexShrink: 0 }}>
            <WinWindowBadge label={p.winWindowLabel} reason={null} />
          </div>
        )}
      </div>

      {/* Win-window reason (league view only) */}
      {showWinWindow && p.winWindowReason && (
        <div className="text-xs text-muted" style={{ marginTop: '0.2rem' }}>{p.winWindowReason}</div>
      )}

      {/* Positional needs (league view only) */}
      {showWinWindow && p.positionalNeeds && (
        <div className="flex gap-2" style={{ marginTop: '0.35rem', flexWrap: 'wrap' }}>
          {Object.entries(p.positionalNeeds).map(([pos, need]) =>
            need !== 'low' ? (
              <span key={pos} className={`badge badge-${pos}`} style={{ opacity: need === 'high' ? 1 : 0.65, fontSize: '0.68rem' }}>
                {pos} {need === 'high' ? '!!' : '!'}
              </span>
            ) : null
          )}
        </div>
      )}

      {!hasData && (
        <div className="text-xs text-muted" style={{ marginTop: '0.25rem' }}>No draft data yet</div>
      )}

      {hasData && (
        <>
          {/* Scouting notes (always visible) */}
          {p.scoutingNotes?.length > 0 && (
            <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.15rem', margin: '0.35rem 0' }}>
              {p.scoutingNotes.map((note, i) => (
                <li key={i} className="text-xs text-secondary">
                  <span style={{ color: 'var(--yellow)', marginRight: '0.3rem' }}>!</span>{note}
                </li>
              ))}
            </ul>
          )}

          {/* Toggle extra details */}
          <button
            className="btn btn-ghost text-xs"
            style={{ marginTop: '0.2rem', padding: '0.1rem 0' }}
            onClick={() => setExpanded(e => !e)}
          >
            {expanded ? '▲ Less' : '▼ More'}
          </button>

          {expanded && (
            <div style={{ marginTop: '0.35rem', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
              {/* College + NFL teams */}
              <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                {p.topColleges?.length > 0 && (
                  <div className="text-xs text-muted">
                    <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>Colleges: </span>
                    {p.topColleges.map(c => c.name).join(', ')}
                  </div>
                )}
                {p.topNflTeams?.length > 0 && (
                  <div className="text-xs text-muted">
                    <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>NFL Teams: </span>
                    {p.topNflTeams.map(t => t.team).join(', ')}
                  </div>
                )}
              </div>

              {/* 2026 draft class targets */}
              {p.favoriteDraftClassPlayers?.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.2rem' }}>2026 Targets:</div>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    {p.favoriteDraftClassPlayers.map((fp, i) => (
                      <span key={i} style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '0.1rem 0.4rem',
                        fontSize: '0.75rem',
                      }}>
                        {fp.name}
                        <span style={{ color: POS_COLOR[fp.position] || 'var(--text-muted)', marginLeft: '0.2rem' }}>
                          {fp.position}
                        </span>
                        {fp.timesDrafted > 1 && (
                          <span style={{ color: 'var(--yellow)', marginLeft: '0.2rem' }}>×{fp.timesDrafted}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Pos weights */}
              {p.positionWeights && (
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {['QB', 'RB', 'WR', 'TE'].map(pos => (
                    <span key={pos} className="text-xs text-muted">
                      <span style={{ color: POS_COLOR[pos] }}>{pos}</span>{' '}
                      {Math.round((p.positionWeights[pos] || 0) * 100)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ScoutingHub({ onLearn, learning, learnMsg }) {
  const { leagues } = useApp();

  const [selectedLeagueId, setSelectedLeagueId] = useState('');
  const [searchText, setSearchText] = useState('');
  const [profiles, setProfiles] = useState(null);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState(null);

  const searchTimer = useRef(null);

  // Load default (all leaguemates) on mount
  useEffect(() => {
    setLoading(true);
    getManagerProfiles()
      .then(data => {
        setProfiles(data.profiles || []);
        setStats({ total: data.totalLeaguemates, profiled: data.totalProfiled, unprofiled: data.unprofiled });
      })
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }, []);

  // When league selection changes, reload
  useEffect(() => {
    if (!selectedLeagueId) {
      // Reset to all leaguemates unless there's a search text
      if (!searchText.trim()) {
        setLoading(true);
        getManagerProfiles()
          .then(data => {
            setProfiles(data.profiles || []);
            setStats({ total: data.totalLeaguemates, profiled: data.totalProfiled, unprofiled: data.unprofiled });
          })
          .catch(() => setProfiles([]))
          .finally(() => setLoading(false));
      }
      return;
    }
    setSearchText('');
    setLoading(true);
    getLeagueManagerProfiles(selectedLeagueId)
      .then(data => {
        setProfiles(data.profiles || []);
        setStats({ total: data.totalLeaguemates });
      })
      .catch(() => setProfiles([]))
      .finally(() => setLoading(false));
  }, [selectedLeagueId]);

  // Debounced manager search
  const handleSearchChange = (e) => {
    const q = e.target.value;
    setSearchText(q);
    setSelectedLeagueId(''); // clear league filter when typing

    clearTimeout(searchTimer.current);
    if (!q.trim()) {
      // Reset to all leaguemates
      setLoading(true);
      getManagerProfiles()
        .then(data => {
          setProfiles(data.profiles || []);
          setStats({ total: data.totalLeaguemates, profiled: data.totalProfiled, unprofiled: data.unprofiled });
        })
        .catch(() => setProfiles([]))
        .finally(() => setLoading(false));
      return;
    }
    searchTimer.current = setTimeout(() => {
      setLoading(true);
      searchManagers(q)
        .then(data => {
          setProfiles(data.profiles || []);
          setStats(null);
        })
        .catch(() => setProfiles([]))
        .finally(() => setLoading(false));
    }, 350);
  };

  const showWinWindow = Boolean(selectedLeagueId);

  // Sort: when league view, sort by win-window (Win Now first), then by picks observed
  const sorted = profiles ? [...profiles].sort((a, b) => {
    if (showWinWindow) {
      const aIdx = WIN_WINDOW_ORDER.indexOf(a.winWindowLabel || '');
      const bIdx = WIN_WINDOW_ORDER.indexOf(b.winWindowLabel || '');
      const aOrd = aIdx === -1 ? 99 : aIdx;
      const bOrd = bIdx === -1 ? 99 : bIdx;
      if (aOrd !== bOrd) return aOrd - bOrd;
    }
    return (b.totalPicksObserved || 0) - (a.totalPicksObserved || 0);
  }) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Controls row */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {/* Manager search */}
        <input
          type="text"
          className="input text-sm"
          placeholder="Search any manager..."
          value={searchText}
          onChange={handleSearchChange}
          style={{ flex: '1 1 180px', minWidth: 0 }}
        />

        {/* League dropdown */}
        <select
          className="input text-sm"
          value={selectedLeagueId}
          onChange={e => setSelectedLeagueId(e.target.value)}
          style={{ flex: '1 1 160px', minWidth: 0 }}
        >
          <option value="">All leaguemates</option>
          {leagues.map(lg => (
            <option key={lg.leagueId} value={lg.leagueId}>
              {lg.name} ({lg.totalRosters}-team)
            </option>
          ))}
        </select>
      </div>

      {/* Stats bar */}
      {stats && !loading && (
        <div className="flex gap-4 text-sm" style={{ flexWrap: 'wrap' }}>
          {stats.total != null && (
            <span><span className="text-muted">Managers:</span> <span className="font-semibold">{stats.total}</span></span>
          )}
          {stats.profiled != null && (
            <span><span className="text-muted">Profiled:</span> <span className={`font-semibold ${stats.profiled > 0 ? 'text-green' : 'text-yellow'}`}>{stats.profiled}</span></span>
          )}
          {stats.unprofiled != null && (
            <span><span className="text-muted">No data:</span> <span className="font-semibold text-muted">{stats.unprofiled}</span></span>
          )}
          {showWinWindow && (
            <span className="text-xs text-muted" style={{ alignSelf: 'center' }}>Sorted by win window · rebuild status shown</span>
          )}
        </div>
      )}

      {/* Scout button */}
      {learnMsg && (
        <div className="text-xs text-green" style={{ padding: '0.4rem 0.6rem', background: '#14532d33', borderRadius: 4 }}>
          {learnMsg}
        </div>
      )}
      <button className="btn btn-secondary text-sm" onClick={onLearn} disabled={learning}>
        {learning ? 'Scanning draft history...' : 'Scout All Opponents Now'}
      </button>
      <div className="text-xs text-muted">
        Scans completed drafts across your leagues and leaguemates' other leagues. Already-processed drafts are skipped automatically.
      </div>

      {/* Results */}
      {loading && <div className="text-secondary text-sm">Loading...</div>}

      {!loading && sorted.length === 0 && (
        <div className="text-muted text-sm" style={{ textAlign: 'center', padding: '1rem' }}>
          {searchText ? 'No managers found matching that name' : 'No manager profiles yet — run Scout to build them'}
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {showWinWindow && (
            <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.1rem' }}>
              League standings &amp; scouting
            </div>
          )}
          {!showWinWindow && sorted.some(p => p.totalPicksObserved > 0) && (
            <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.1rem' }}>Known tendencies</div>
          )}
          {sorted.map(p => (
            <ManagerCard key={p.sleeperId} p={p} showWinWindow={showWinWindow} />
          ))}
        </div>
      )}
    </div>
  );
}
