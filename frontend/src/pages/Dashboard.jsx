import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { getActiveDrafts } from '../services/api';
import Layout from '../components/Layout/Layout';
import WinWindowBadge from '../components/WinWindow/WinWindowBadge';
import FreshnessTag from '../components/DataFreshness/FreshnessTag';
import { formatEta } from '../utils/formatting';

export default function Dashboard() {
  const { user, leagues } = useApp();
  const navigate = useNavigate();
  const [activeDrafts, setActiveDrafts] = useState([]);
  const [loadingDrafts, setLoadingDrafts] = useState(true);

  useEffect(() => {
    getActiveDrafts()
      .then(d => setActiveDrafts(d.drafts || []))
      .catch(() => {})
      .finally(() => setLoadingDrafts(false));
  }, []);

  return (
    <Layout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {/* Welcome */}
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>
            Hey, {user?.displayName || user?.username}
          </h1>
          <p className="text-secondary text-sm">Your dynasty dashboard</p>
        </div>

        {/* Active Drafts */}
        <section>
          <h2 className="font-semibold" style={{ marginBottom: '0.75rem' }}>Active Drafts</h2>
          {loadingDrafts ? (
            <div className="text-secondary text-sm">Loading drafts...</div>
          ) : activeDrafts.length === 0 ? (
            <div className="card text-secondary text-sm" style={{ textAlign: 'center', padding: '1.5rem' }}>
              No active drafts right now
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {activeDrafts.map(d => (
                <button
                  key={d.draftId}
                  className="card"
                  style={{ textAlign: 'left', cursor: 'pointer', width: '100%', borderLeft: d.onTheClock ? '3px solid var(--green)' : '3px solid var(--border)' }}
                  onClick={() => navigate(`/draft/${d.draftId}`)}
                >
                  <div className="flex justify-between items-center">
                    <div>
                      <div className="font-semibold">{d.leagueName}</div>
                      <div className="text-xs text-secondary">Pick {d.currentPick} of {d.totalRosters * d.rounds}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      {d.onTheClock ? (
                        <span className="badge text-green" style={{ background: '#14532d', color: '#86efac' }}>On the Clock</span>
                      ) : (
                        <span className="text-sm text-secondary">Your pick in {formatEta(d.etaMs)}</span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* My Leagues */}
        <section>
          <h2 className="font-semibold" style={{ marginBottom: '0.75rem' }}>My Leagues</h2>
          {leagues.length === 0 ? (
            <div className="card text-secondary text-sm" style={{ textAlign: 'center', padding: '1.5rem' }}>
              No leagues found
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {leagues.map(lg => (
                <div key={lg.leagueId} className="card">
                  <div className="flex justify-between items-center" style={{ marginBottom: '0.4rem' }}>
                    <div>
                      <div className="font-semibold">{lg.name}</div>
                      <div className="text-xs text-secondary">{lg.totalRosters}-team{lg.isSuperFlex ? ' SuperFlex' : ''}{lg.isPpr ? ' PPR' : ''}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {lg.myRoster?.winWindowLabel && (
                        <WinWindowBadge label={lg.myRoster.winWindowLabel} reason={null} />
                      )}
                    </div>
                  </div>
                  {lg.myRoster?.winWindowReason && (
                    <div className="text-xs text-muted">{lg.myRoster.winWindowReason}</div>
                  )}
                  {lg.myRoster?.positionalNeeds && (
                    <div className="flex gap-2" style={{ marginTop: '0.4rem', flexWrap: 'wrap' }}>
                      {Object.entries(lg.myRoster.positionalNeeds).map(([pos, need]) =>
                        need !== 'low' ? (
                          <span key={pos} className={`badge badge-${pos}`} style={{ opacity: need === 'high' ? 1 : 0.65 }}>
                            {pos} {need === 'high' ? '!!' : '!'}
                          </span>
                        ) : null
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </Layout>
  );
}
