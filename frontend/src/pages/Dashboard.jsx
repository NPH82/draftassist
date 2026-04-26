import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { getActiveDrafts, getDataStatus, refreshRankings, getManagerProfiles, triggerLearn, seedRookies } from '../services/api';
import Layout from '../components/Layout/Layout';
import WinWindowBadge from '../components/WinWindow/WinWindowBadge';
import FreshnessTag from '../components/DataFreshness/FreshnessTag';
import { formatEta, timeAgo } from '../utils/formatting';

export default function Dashboard() {
  const { user, leagues } = useApp();
  const navigate = useNavigate();
  const [activeDrafts, setActiveDrafts] = useState([]);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [dataStatus, setDataStatus] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState(null);
  const [managerProfiles, setManagerProfiles] = useState(null);
  const [learning, setLearning] = useState(false);
  const [learnMsg, setLearnMsg] = useState(null);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState(null);

  useEffect(() => {
    getActiveDrafts()
      .then(d => setActiveDrafts(d.drafts || []))
      .catch(() => {})
      .finally(() => setLoadingDrafts(false));
    getDataStatus().then(setDataStatus).catch(() => {});
    getManagerProfiles().then(setManagerProfiles).catch(() => {});
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
      // Re-fetch profiles after 2.5 min to show updated data
      setTimeout(() => getManagerProfiles().then(setManagerProfiles).catch(() => {}), 150000);
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
          </div>
        </section>

        {/* Scout Opponents */}
        <section>
          <h2 className="font-semibold" style={{ marginBottom: '0.75rem' }}>Scout Opponents</h2>
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {managerProfiles && (
              <div className="flex gap-4 text-sm" style={{ flexWrap: 'wrap' }}>
                <span><span className="text-muted">Leaguemates:</span> <span className="font-semibold">{managerProfiles.totalLeaguemates}</span></span>
                <span><span className="text-muted">Profiled:</span> <span className={`font-semibold ${managerProfiles.totalProfiled > 0 ? 'text-green' : 'text-yellow'}`}>{managerProfiles.totalProfiled}</span></span>
                <span><span className="text-muted">No data yet:</span> <span className="font-semibold text-muted">{managerProfiles.unprofiled}</span></span>
              </div>
            )}

            {learnMsg && (
              <div className="text-xs text-green" style={{ padding: '0.4rem 0.6rem', background: '#14532d33', borderRadius: 4 }}>
                {learnMsg}
              </div>
            )}

            <button
              className="btn btn-secondary text-sm"
              onClick={handleLearn}
              disabled={learning}
            >
              {learning ? 'Scanning draft history...' : 'Scout All Opponents Now'}
            </button>
            <div className="text-xs text-muted">
              Scans completed drafts across your leagues and leaguemates' other leagues. Already-processed drafts are skipped automatically.
            </div>

            {/* Manager profile cards */}
            {managerProfiles?.profiles?.filter(p => p.totalPicksObserved > 0).length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
                <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.1rem' }}>Known tendencies</div>
                {managerProfiles.profiles
                  .filter(p => p.totalPicksObserved > 0)
                  .sort((a, b) => b.totalPicksObserved - a.totalPicksObserved)
                  .map(p => (
                    <div key={p.sleeperId} style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '0.6rem 0.75rem', border: '1px solid var(--border)' }}>
                      <div className="flex justify-between items-center" style={{ marginBottom: '0.3rem' }}>
                        <span className="font-semibold text-sm">{p.username || p.sleeperId}</span>
                        <span className="text-xs text-muted">{p.draftsObserved} draft{p.draftsObserved !== 1 ? 's' : ''} · {p.totalPicksObserved} picks</span>
                      </div>
                      {p.scoutingNotes?.length > 0 ? (
                        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                          {p.scoutingNotes.map((note, i) => (
                            <li key={i} className="text-xs text-secondary">
                              <span style={{ color: 'var(--yellow)', marginRight: '0.3rem' }}>!</span>{note}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="text-xs text-muted">Not enough data for tendencies yet</div>
                      )}
                      {p.topColleges?.length > 0 && (
                        <div className="text-xs text-muted" style={{ marginTop: '0.2rem' }}>
                          Favors: {p.topColleges.map(c => c.name).join(', ')}
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </Layout>
  );
}
