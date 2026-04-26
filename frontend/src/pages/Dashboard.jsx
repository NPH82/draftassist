import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { getActiveDrafts, getDataStatus, refreshRankings, triggerLearn, seedRookies, syncSleeperIds, importSleeperPlayers } from '../services/api';
import Layout from '../components/Layout/Layout';
import WinWindowBadge from '../components/WinWindow/WinWindowBadge';
import FreshnessTag from '../components/DataFreshness/FreshnessTag';
import DraftTargets from '../components/DraftTargets/DraftTargets';
import ScoutingHub from '../components/ScoutingHub/ScoutingHub';
import { formatEta, timeAgo } from '../utils/formatting';

export default function Dashboard() {
  const { user, leagues } = useApp();
  const navigate = useNavigate();
  const [activeDrafts, setActiveDrafts] = useState([]);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [dataStatus, setDataStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null);
  const [learning, setLearning] = useState(false);
  const [learnMsg, setLearnMsg] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState(null);
  const [expandedLeague, setExpandedLeague] = useState(null);

  useEffect(() => {
    getActiveDrafts()
      .then(d => setActiveDrafts(d.drafts || []))
      .catch(() => {})
      .finally(() => setLoadingDrafts(false));
    getDataStatus().then(setDataStatus).catch(() => {});
  }, []);

  const handleRefreshRankings = async () => {
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const res = await refreshRankings();
      setRefreshMsg(res.message);
      setTimeout(() => getDataStatus().then(setDataStatus).catch(() => {}), 65000);
    } catch {
      setRefreshMsg('Refresh failed -- check Render logs');
    } finally {
      setRefreshing(false);
    }
  };

  const handleImportSleeperPlayers = async () => {
    setImporting(true);
    setImportMsg(null);
    try {
      const res = await importSleeperPlayers();
      setImportMsg(res.message);
    } catch (err) {
      setImportMsg(err?.response?.data?.error || 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const handleSyncSleeperIds = async () => {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await syncSleeperIds();
      setSyncMsg(res.message);
    } catch (err) {
      setSyncMsg(err?.response?.data?.error || 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const handleSeedRookies = async (year) => {
    setSeeding(true);
    setSeedMsg(null);
    try {
      const res = await seedRookies(year);
      setSeedMsg(res.message);
    } catch (err) {
      setSeedMsg(err?.response?.data?.error || 'Seed failed');
    } finally {
      setSeeding(false);
    }
  };

  const handleLearn = async () => {
    setLearning(true);
    setLearnMsg(null);
    try {
      const res = await triggerLearn();
      setLearnMsg(res.message);
    } catch {
      setLearnMsg('Scout failed -- check Render logs');
    } finally {
      setLearning(false);
    }
  };

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
              {leagues.map(lg => {
                const isExpanded = expandedLeague === lg.leagueId;
                return (
                  <div key={lg.leagueId}>
                    <button
                      className="card"
                      style={{ cursor: 'pointer', userSelect: 'none', width: '100%', textAlign: 'left' }}
                      onClick={() => setExpandedLeague(isExpanded ? null : lg.leagueId)}
                    >
                      <div className="flex justify-between items-center" style={{ marginBottom: '0.4rem' }}>
                        <div>
                          <div className="font-semibold">{lg.name}</div>
                          <div className="text-xs text-secondary">{lg.totalRosters}-team{lg.isSuperFlex ? ' SuperFlex' : ''}{lg.isPpr ? ' PPR' : ''}</div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                          {lg.myRoster?.winWindowLabel && (
                            <WinWindowBadge label={lg.myRoster.winWindowLabel} reason={null} />
                          )}
                          <span className="text-muted" style={{ fontSize: '1rem' }}>
                            {isExpanded ? '▲' : '▼'}
                          </span>
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
                    </button>

                    {/* Inline draft targets panel */}
                    {isExpanded && (
                      <div
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.85rem',
                          background: 'var(--bg-card, #1a1a2e)',
                          borderRadius: 10,
                          border: '1px solid var(--border, #2a2a3e)',
                        }}
                      >
                        <DraftTargets leagueId={lg.leagueId} draftId={lg.draftId} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Data Status & Manual Refresh */}
        <section>
          <h2 className="font-semibold" style={{ marginBottom: '0.75rem' }}>Rankings Data</h2>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {dataStatus ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <div className="flex justify-between text-sm">
                  <span className="text-muted">Players in DB</span>
                  <span className="font-semibold">{dataStatus.playerCount}</span>
                </div>
                {Object.entries(dataStatus.sources).map(([src, info]) => (
                  <div key={src} className="flex justify-between text-sm">
                    <span className="text-muted">{src === 'fantasyPros' ? 'FantasyPros' : src === 'ktc' ? 'KTC' : 'Underdog'}</span>
                    <span className={info.lastUpdated ? 'text-green' : 'text-yellow'}>
                      {info.lastUpdated ? `Updated ${timeAgo(info.lastUpdated)}${info.playersWithData ? ` (${info.playersWithData} players)` : ''}` : 'No data yet'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-secondary text-sm">Loading data status...</div>
            )}

            {refreshMsg && (
              <div className="text-xs text-green" style={{ padding: '0.4rem 0.6rem', background: '#14532d33', borderRadius: 4 }}>
                {refreshMsg}
              </div>
            )}

            <button
              className="btn btn-secondary text-sm"
              onClick={handleRefreshRankings}
              disabled={refreshing}
            >
              {refreshing ? 'Triggering refresh...' : 'Refresh Rankings Now'}
            </button>
            <div className="text-xs text-muted">
              Scrapes FantasyPros, KTC, and Underdog. Data updates ~60s after triggering. Runs automatically daily at 3am UTC.
            </div>

            {seedMsg && (
              <div className="text-xs text-green" style={{ padding: '0.4rem 0.6rem', background: '#14532d33', borderRadius: 4 }}>
                {seedMsg}
              </div>
            )}
            <button
              className="btn btn-secondary text-sm"
              onClick={() => handleSeedRookies(2026)}
              disabled={seeding}
            >
              {seeding ? 'Seeding...' : 'Seed 2026 Rookie Class'}
            </button>
            <div className="text-xs text-muted">
              Adds 2026 NFL Draft dynasty Top 48 to the player database (skips if already seeded).
            </div>

            {syncMsg && (
              <div className="text-xs text-green" style={{ padding: '0.4rem 0.6rem', background: '#14532d33', borderRadius: 4 }}>
                {syncMsg}
              </div>
            )}
            <button
              className="btn btn-secondary text-sm"
              onClick={handleSyncSleeperIds}
              disabled={syncing}
            >
              {syncing ? 'Syncing Sleeper IDs...' : 'Sync Sleeper Player IDs'}
            </button>
            <div className="text-xs text-muted">
              Fetches the Sleeper player database and back-fills missing player IDs so scraper data matches correctly.
            </div>

            {importMsg && (
              <div className="text-xs text-green" style={{ padding: '0.4rem 0.6rem', background: '#14532d33', borderRadius: 4 }}>
                {importMsg}
              </div>
            )}
            <button
              className="btn btn-secondary text-sm"
              onClick={handleImportSleeperPlayers}
              disabled={importing}
            >
              {importing ? 'Importing...' : 'Import All Sleeper Players'}
            </button>
            <div className="text-xs text-muted">
              Upserts all QB/RB/WR/TE players from Sleeper into the database so veteran rosters evaluate correctly. Safe to re-run.
            </div>
          </div>
        </section>

        {/* Scout Opponents */}
        <section>
          <h2 className="font-semibold" style={{ marginBottom: '0.75rem' }}>Scout Opponents</h2>
          <div className="card">
            <ScoutingHub
              onLearn={handleLearn}
              learning={learning}
              learnMsg={learnMsg}
              preferredLeagueId={expandedLeague}
            />
          </div>
        </section>
      </div>
    </Layout>
  );
}
