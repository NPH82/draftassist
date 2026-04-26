import { useEffect, useState, useCallback } from 'react';
import { getLeagueDraftTargets, submitDraftFeedback, getDraftTrades } from '../../services/api';
import { dasClass } from '../../utils/formatting';

const POS_COLOR = { QB: '#c084fc', RB: '#4ade80', WR: '#60a5fa', TE: '#fb923c' };

/**
 * Compact player row used in recommendation and alternatives lists.
 */
function PlayerRow({ player, action, actionLabel, actionActive = false }) {
  if (!player) return null;
  const das = player.dasScore ?? '--';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.6rem',
        padding: '0.5rem 0.65rem',
        background: 'var(--bg-surface, #1a1a2e)',
        borderRadius: 8,
        borderLeft: `3px solid ${POS_COLOR[player.position] || '#555'}`,
      }}
    >
      <div
        className={`das-score ${typeof das === 'number' ? dasClass(das) : 'das-low'}`}
        style={{ fontSize: '0.85rem', minWidth: 30, textAlign: 'center' }}
      >
        {das}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="font-semibold"
          style={{ fontSize: '0.87rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {player.name}
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', fontSize: '0.72rem', marginTop: '0.1rem' }}>
          <span className={`badge badge-${player.position}`}>{player.position}</span>
          {player.team && <span className="text-muted">{player.team}</span>}
          {player.ktcValue != null && (
            <span className="text-muted">KTC {player.ktcValue.toLocaleString()}</span>
          )}
          {player.fantasyProsRank != null && (
            <span className="text-muted">FP #{player.fantasyProsRank}</span>
          )}
          {player.underdogAdp != null && (
            <span className="text-muted">ADP {player.underdogAdp.toFixed(1)}</span>
          )}
        </div>
      </div>
      {action && (
        <button
          className={`btn ${actionActive ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '0.25rem 0.55rem', fontSize: '0.72rem', whiteSpace: 'nowrap' }}
          onClick={action}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Card for a single pick slot showing recommendation + agree/disagree flow.
 */
function PickTargetCard({ pick, leagueId, draftId, onFeedbackSaved }) {
  const existingFb = pick.feedback;
  const [status, setStatus] = useState(
    existingFb?.agreed ? 'agreed' : existingFb?.preferredPlayerId ? 'custom' : null
  );
  const [selectedAltId, setSelectedAltId] = useState(existingFb?.preferredPlayerId || null);
  const [saving, setSaving] = useState(false);
  const [trades, setTrades] = useState(null);
  const [loadingTrades, setLoadingTrades] = useState(false);

  const saveFeedback = useCallback(async (agreed, preferredPlayerId = null) => {
    setSaving(true);
    try {
      await submitDraftFeedback(leagueId, {
        pickNumber: pick.pickNumber,
        recommendedPlayerId: pick.recommendation?._id,
        agreed,
        preferredPlayerId,
      });
      onFeedbackSaved?.();
    } finally {
      setSaving(false);
    }
  }, [leagueId, pick, onFeedbackSaved]);

  const handleAgree = () => saveFeedback(true).then(() => setStatus('agreed'));
  const handleDisagree = () => setStatus('disagreed');

  const handleSelectAlt = async (player) => {
    setSelectedAltId(String(player._id));
    await saveFeedback(false, String(player._id));
    setStatus('custom');
  };

  const handleLoadTrades = async () => {
    if (!draftId || !pick.recommendation?.sleeperId) return;
    setLoadingTrades(true);
    try {
      const data = await getDraftTrades(draftId, pick.recommendation.sleeperId);
      setTrades(data);
    } catch {
      setTrades({ tradeUp: [], tradeDown: [] });
    } finally {
      setLoadingTrades(false);
    }
  };

  const handleReset = () => {
    setStatus(null);
    setSelectedAltId(null);
    setTrades(null);
  };

  return (
    <div
      className="card"
      style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}
    >
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <span className="font-bold" style={{ fontSize: '0.95rem' }}>Pick #{pick.pickNumber}</span>
          <span className="text-xs text-muted" style={{ marginLeft: '0.5rem' }}>
            Rd {pick.round} · Slot {pick.pickInRound}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
          {status === 'agreed' && (
            <span className="badge" style={{ background: '#14532d', color: '#86efac' }}>✓ Locked In</span>
          )}
          {status === 'custom' && (
            <span className="badge" style={{ background: '#1e3a5f', color: '#93c5fd' }}>Custom Pick</span>
          )}
          {(status === 'agreed' || status === 'custom') && (
            <button
              className="btn btn-secondary"
              style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
              onClick={handleReset}
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Recommendation */}
      {pick.recommendation ? (
        <div>
          <div className="text-xs text-muted" style={{ marginBottom: '0.3rem' }}>
            Recommended target
          </div>
          <PlayerRow player={pick.recommendation} />
        </div>
      ) : (
        <div className="text-sm text-secondary">No player data available for this pick yet.</div>
      )}

      {/* Agree / Disagree buttons (only when no decision yet) */}
      {status === null && pick.recommendation && (
        <div className="flex gap-2">
          <button
            className="btn btn-primary"
            style={{ flex: 1, fontSize: '0.85rem' }}
            onClick={handleAgree}
            disabled={saving}
          >
            ✓ Agree
          </button>
          <button
            className="btn btn-secondary"
            style={{ flex: 1, fontSize: '0.85rem' }}
            onClick={handleDisagree}
            disabled={saving}
          >
            ✗ Disagree
          </button>
        </div>
      )}

      {/* Disagreed flow: show alternatives */}
      {status === 'disagreed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
          <div className="text-xs text-muted">Choose your preferred target:</div>
          {pick.alternatives.length > 0 ? (
            pick.alternatives.map(alt => (
              <PlayerRow
                key={String(alt._id)}
                player={alt}
                action={() => handleSelectAlt(alt)}
                actionLabel={selectedAltId === String(alt._id) ? '✓ Selected' : 'Select'}
                actionActive={selectedAltId === String(alt._id)}
              />
            ))
          ) : (
            <div className="text-xs text-secondary">No alternatives available.</div>
          )}

          {/* Trade opportunities */}
          {draftId && pick.recommendation && (
            <div style={{ marginTop: '0.25rem' }}>
              <button
                className="btn btn-secondary"
                style={{ fontSize: '0.75rem', width: '100%' }}
                onClick={handleLoadTrades}
                disabled={loadingTrades}
              >
                {loadingTrades ? 'Loading trade options…' : 'View Trade Opportunities'}
              </button>

              {trades && (
                <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                  {trades.tradeUp?.length > 0 && (
                    <div>
                      <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>Trade-up options</div>
                      {trades.tradeUp.slice(0, 2).map((t, i) => (
                        <div
                          key={i}
                          className="text-xs"
                          style={{ padding: '0.35rem 0.5rem', background: 'var(--bg-surface, #1a1a2e)', borderRadius: 6, marginBottom: '0.2rem' }}
                        >
                          {t.reason}
                        </div>
                      ))}
                    </div>
                  )}
                  {trades.tradeDown?.length > 0 && (
                    <div>
                      <div className="text-xs text-muted" style={{ marginBottom: '0.25rem' }}>Trade-down options</div>
                      {trades.tradeDown.slice(0, 2).map((t, i) => (
                        <div
                          key={i}
                          className="text-xs"
                          style={{ padding: '0.35rem 0.5rem', background: 'var(--bg-surface, #1a1a2e)', borderRadius: 6, marginBottom: '0.2rem' }}
                        >
                          {t.reason}
                        </div>
                      ))}
                    </div>
                  )}
                  {trades.tradeUp?.length === 0 && trades.tradeDown?.length === 0 && (
                    <div className="text-xs text-muted">
                      No trade opportunities found. Full trade analysis available during live draft.
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * DraftTargets — shows per-pick recommendations with agree/disagree feedback.
 *
 * Props:
 *   leagueId  — Sleeper league ID (required)
 *   draftId   — Sleeper draft ID (optional; enables live trade suggestions)
 */
export default function DraftTargets({ leagueId, draftId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getLeagueDraftTargets(leagueId)
      .then(setData)
      .catch(e => setError(e?.response?.data?.error || 'Failed to load draft targets'))
      .finally(() => setLoading(false));
  }, [leagueId]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="text-secondary text-sm" style={{ padding: '1rem', textAlign: 'center' }}>
        Loading draft targets…
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="text-sm"
        style={{ color: 'var(--red, #f87171)', padding: '0.75rem', background: '#7f1d1d22', borderRadius: 8 }}
      >
        {error}
      </div>
    );
  }

  if (!data) return null;

  const activeDraftId = draftId || data.draftId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Header row */}
      <div className="flex justify-between items-center" style={{ flexWrap: 'wrap', gap: '0.4rem' }}>
        <div className="font-semibold" style={{ fontSize: '0.92rem' }}>
          Draft Targets
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            className="text-xs"
            style={{
              padding: '0.15rem 0.5rem',
              borderRadius: 999,
              background: data.draftStatus === 'drafting' ? '#14532d' : '#1e3a5f',
              color: data.draftStatus === 'drafting' ? '#86efac' : '#93c5fd',
            }}
          >
            {data.draftStatus === 'drafting' ? '🟢 Live' : data.draftStatus === 'pre_draft' ? 'Pre-Draft' : 'Complete'}
          </span>
          <span className="text-xs text-muted">
            Slot #{data.myPickSlot} · {data.totalTeams} teams · {data.rounds} rds
          </span>
        </div>
      </div>

      {data.myPicks.length === 0 ? (
        <div className="text-sm text-secondary card" style={{ padding: '0.85rem' }}>
          All picks have passed or the draft is complete.
        </div>
      ) : (
        data.myPicks.map(pick => (
          <PickTargetCard
            key={pick.pickNumber}
            pick={pick}
            leagueId={leagueId}
            draftId={activeDraftId}
            onFeedbackSaved={load}
          />
        ))
      )}
    </div>
  );
}
