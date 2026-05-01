import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';
import { getActiveDrafts, triggerLearn, getLeagueDraftGrade } from '../services/api';
import Layout from '../components/Layout/Layout';
import WinWindowBadge from '../components/WinWindow/WinWindowBadge';
import DraftTargets from '../components/DraftTargets/DraftTargets';
import ScoutingHub from '../components/ScoutingHub/ScoutingHub';
import DevyPool from '../components/DevyPool/DevyPool';
import { formatEta } from '../utils/formatting';

function LeagueFeatureToggle({ label, checked, disabled, onChange }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!disabled) onChange(!checked);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.45rem',
        background: 'transparent',
        border: 'none',
        color: 'var(--text-primary)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.65 : 1,
        padding: 0,
      }}
    >
      <span style={{ fontSize: '0.72rem', fontWeight: 600 }}>{label}</span>
      <span
        style={{
          width: 34,
          height: 20,
          borderRadius: 999,
          background: checked ? 'var(--accent, #6366f1)' : 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          position: 'relative',
          transition: 'background 160ms ease',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: checked ? 16 : 1,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 160ms ease',
          }}
        />
      </span>
    </button>
  );
}

const GRADE_COLOR = {
  'A+': '#86efac', A: '#86efac', 'A-': '#86efac',
  'B+': '#6ee7b7', B: '#6ee7b7', 'B-': '#6ee7b7',
  'C+': '#93c5fd', C: '#93c5fd', 'C-': '#93c5fd',
  'D+': '#fbbf24', D: '#fbbf24', 'D-': '#fbbf24',
  F: '#f87171',
};

function CompletedDraftGradePanel({ data }) {
  if (!data?.myGrade) {
    return (
      <div className="text-xs text-secondary" style={{ padding: '0.5rem 0' }}>
        Draft complete. No grade available (ADP data may be limited for this draft type).
      </div>
    );
  }
  const { myGrade, totalManagers, targetsHit, targetsTotal } = data;
  const color = GRADE_COLOR[myGrade.grade] || '#93c5fd';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      <div className="font-semibold" style={{ fontSize: '0.92rem' }}>Draft Grade</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: '2rem',
            fontWeight: 800,
            color,
            lineHeight: 1,
          }}
        >
          {myGrade.grade}
        </span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
          <span className="text-sm">
            League rank: <strong>#{myGrade.rank}</strong> of {totalManagers}
          </span>
          {myGrade.avgPickDelta != null && (
            <span className="text-xs text-secondary">
              {myGrade.avgPickDelta > 0 ? '+' : ''}{myGrade.avgPickDelta} picks vs ADP avg
            </span>
          )}
          {targetsTotal > 0 && (
            <span className="text-xs text-secondary">
              Targets drafted: {targetsHit} / {targetsTotal}
            </span>
          )}
        </div>
      </div>
      {data.leagueGrades?.length > 1 && (
        <details style={{ marginTop: '0.25rem' }}>
          <summary className="text-xs text-secondary" style={{ cursor: 'pointer', userSelect: 'none' }}>
            View all grades
          </summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginTop: '0.45rem' }}>
            {data.leagueGrades.map((mgr) => {
              const isMine = mgr.ownerId === data.myGrade?.ownerId;
              const mc = GRADE_COLOR[mgr.grade] || '#93c5fd';
              return (
                <div
                  key={mgr.ownerId}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.3rem 0.5rem',
                    borderRadius: 6,
                    background: isMine ? 'rgba(34,197,94,0.08)' : 'transparent',
                  }}
                >
                  <span className="text-xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    #{mgr.rank} {mgr.ownerUsername}{isMine ? ' (You)' : ''}
                  </span>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: '0.8rem', color: mc }}>{mgr.grade}</span>
                    {mgr.avgPickDelta != null && (
                      <span className="text-xs text-muted">
                        {mgr.avgPickDelta > 0 ? '+' : ''}{mgr.avgPickDelta}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

export default function Dashboard() {
  const { user, leagues, loadingLeagues, updateLeaguePreferences } = useApp();
  const navigate = useNavigate();
  const [activeDrafts, setActiveDrafts] = useState([]);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [draftsError, setDraftsError] = useState(null);
  const [learning, setLearning] = useState(false);
  const [learnMsg, setLearnMsg] = useState(null);
  const [expandedLeague, setExpandedLeague] = useState(null);
  const [savingLeaguePrefs, setSavingLeaguePrefs] = useState({});
  const [leaguePrefErrors, setLeaguePrefErrors] = useState({});
  const [draftGrades, setDraftGrades] = useState({});

  useEffect(() => {
    getActiveDrafts()
      .then(d => {
        setActiveDrafts(d.drafts || []);
        setDraftsError(null);
      })
      .catch(() => {
        setActiveDrafts([]);
        setDraftsError('Could not load active drafts. Please refresh in a moment.');
      })
      .finally(() => setLoadingDrafts(false));
  }, []);

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

  // Fetch completed draft grade when a league card is expanded
  useEffect(() => {
    if (!expandedLeague) return;
    const lg = leagues.find((l) => l.leagueId === expandedLeague);
    if (!lg?.draftId) return;
    // Only fetch once per leagueId
    if (draftGrades[expandedLeague] !== undefined) return;
    getLeagueDraftGrade(expandedLeague)
      .then((data) => setDraftGrades((prev) => ({ ...prev, [expandedLeague]: data })))
      .catch(() => setDraftGrades((prev) => ({ ...prev, [expandedLeague]: null })));
  }, [expandedLeague, leagues]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLeaguePreferenceChange = async (leagueId, key, value) => {
    setSavingLeaguePrefs((current) => ({ ...current, [leagueId]: true }));
    setLeaguePrefErrors((current) => ({ ...current, [leagueId]: null }));
    try {
      await updateLeaguePreferences(leagueId, { [key]: value });
    } catch {
      setLeaguePrefErrors((current) => ({
        ...current,
        [leagueId]: 'Could not save league settings right now.',
      }));
    } finally {
      setSavingLeaguePrefs((current) => ({ ...current, [leagueId]: false }));
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
          ) : draftsError ? (
            <div className="card text-secondary text-sm" style={{ textAlign: 'center', padding: '1.5rem' }}>
              {draftsError}
            </div>
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
                      <div className="font-semibold league-title">{d.leagueName}</div>
                      <div className="text-xs text-secondary">Pick {d.currentPick} of {d.totalRosters * d.rounds}</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      {d.onTheClock ? (
                        <span className="badge text-green" style={{ background: '#14532d', color: '#86efac' }}>On the Clock</span>
                      ) : d.myNextPick == null ? (
                        <span className="text-sm text-secondary">No picks remaining in this draft</span>
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
          {loadingLeagues ? (
            <div className="card text-secondary text-sm" style={{ textAlign: 'center', padding: '1.5rem' }}>
              Gathering leagues...
            </div>
          ) : leagues.length === 0 ? (
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
                      aria-expanded={isExpanded}
                      aria-label={`Toggle league details for ${lg.name}`}
                      onClick={() => setExpandedLeague(isExpanded ? null : lg.leagueId)}
                    >
                      <div className="flex justify-between items-center" style={{ marginBottom: '0.4rem' }}>
                        <div>
                          <div className="font-semibold league-title">{lg.name}</div>
                          <div className="text-xs text-secondary">
                            {lg.totalRosters}-team{lg.isSuperFlex ? ' SuperFlex' : ''}{lg.isPpr ? ' PPR' : ''}
                            {lg.devyEnabled ? ' · Devy' : ''}
                            {lg.idpEnabled ? ' · IDP' : ''}
                          </div>
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
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
                          <div>
                            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)' }}>League Format</div>
                            <div className="text-xs text-muted">Saved per league and restored on your next login.</div>
                          </div>
                          <div style={{ display: 'flex', gap: '0.9rem', flexWrap: 'wrap' }}>
                            <LeagueFeatureToggle
                              label="Devy"
                              checked={!!lg.devyEnabled}
                              disabled={!!savingLeaguePrefs[lg.leagueId]}
                              onChange={(nextValue) => handleLeaguePreferenceChange(lg.leagueId, 'devyEnabled', nextValue)}
                            />
                            <LeagueFeatureToggle
                              label="IDP"
                              checked={!!lg.idpEnabled}
                              disabled={!!savingLeaguePrefs[lg.leagueId]}
                              onChange={(nextValue) => handleLeaguePreferenceChange(lg.leagueId, 'idpEnabled', nextValue)}
                            />
                          </div>
                        </div>
                        {leaguePrefErrors[lg.leagueId] && (
                          <div className="text-xs" style={{ color: 'var(--red)', marginBottom: '0.75rem' }}>
                            {leaguePrefErrors[lg.leagueId]}
                          </div>
                        )}
                        {draftGrades[lg.leagueId]?.complete ? (
                          <CompletedDraftGradePanel data={draftGrades[lg.leagueId]} />
                        ) : (
                          <DraftTargets leagueId={lg.leagueId} draftId={lg.draftId} />
                        )}
                      </div>
                    )}

                    {(isExpanded && (lg.devyEnabled || lg.idpEnabled)) && (
                      <div
                        style={{
                          marginTop: '0.5rem',
                          padding: '0.85rem',
                          background: 'var(--bg-card, #1a1a2e)',
                          borderRadius: 10,
                          border: '1px solid var(--border, #2a2a3e)',
                        }}
                      >
                        <DevyPool leagueId={lg.leagueId} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
