import { useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import Layout from '../components/Layout/Layout';
import PlayerCard from '../components/PlayerCard/PlayerCard';
import DraftQueue from '../components/DraftQueue/DraftQueue';
import TradePanel from '../components/TradePanel/TradePanel';
import AlertContainer from '../components/Alerts/AlertContainer';
import WinWindowBadge from '../components/WinWindow/WinWindowBadge';
import FreshnessTag from '../components/DataFreshness/FreshnessTag';
import DraftTargets from '../components/DraftTargets/DraftTargets';
import { DraftProvider, useDraft } from '../context/DraftContext';
import { getDraftTrades } from '../services/api';
import { formatEta } from '../utils/formatting';

export default function DraftMode() {
  const { draftId } = useParams();
  return (
    <DraftProvider draftId={draftId}>
      <DraftModeInner draftId={draftId} />
    </DraftProvider>
  );
}

function DraftModeInner({ draftId }) {
  const { draftState, mode, setMode, queue, addToQueue, removeFromQueue, loading, error } = useDraft();
  const [activeTradePlayer, setActiveTradePlayer] = useState(null);
  const [filter, setFilter] = useState('ALL');
  const [showQueue, setShowQueue] = useState(false);
  const [showTargets, setShowTargets] = useState(false);
  const [hintTrades, setHintTrades] = useState(null);
  const [loadingHintTrades, setLoadingHintTrades] = useState(false);
  const [betterNowTrades, setBetterNowTrades] = useState({});   // keyed by playerId
  const [loadingBetterNow, setLoadingBetterNow] = useState({});

  const ds = draftState;
  const leagueId = ds?.leagueId || null;

  const handleLoadHintTrades = useCallback(async () => {
    if (!draftId || !ds?.strategyHint?.playerId) return;
    setLoadingHintTrades(true);
    try {
      const data = await getDraftTrades(draftId, ds.strategyHint.playerId);
      setHintTrades(data);
    } catch {
      setHintTrades({ tradeUp: [], tradeDown: [] });
    } finally {
      setLoadingHintTrades(false);
    }
  }, [draftId, ds?.strategyHint?.playerId]);

  const handleLoadBetterNowTrades = useCallback(async (playerId) => {
    if (!draftId || !playerId) return;
    if (betterNowTrades[playerId]) {
      // toggle off
      setBetterNowTrades(prev => { const next = { ...prev }; delete next[playerId]; return next; });
      return;
    }
    setLoadingBetterNow(prev => ({ ...prev, [playerId]: true }));
    try {
      const data = await getDraftTrades(draftId, playerId);
      setBetterNowTrades(prev => ({ ...prev, [playerId]: data }));
    } catch {
      setBetterNowTrades(prev => ({ ...prev, [playerId]: { tradeUp: [], tradeDown: [] } }));
    } finally {
      setLoadingBetterNow(prev => { const next = { ...prev }; delete next[playerId]; return next; });
    }
  }, [draftId, betterNowTrades]);

  if (loading) {
    return (
      <Layout>
        <div className="text-secondary" style={{ textAlign: 'center', padding: '3rem' }}>Loading draft...</div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div style={{ color: 'var(--red)', textAlign: 'center', padding: '3rem' }}>Error: {error}</div>
      </Layout>
    );
  }

  const available = (ds?.available || []).filter(p => filter === 'ALL' || p.position === filter);

  const positions = ['ALL', 'QB', 'RB', 'WR', 'TE'];

  return (
    <Layout>
      {/* Draft header */}
      <div style={{ marginBottom: '1rem' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: '0.5rem' }}>
          <div>
            {ds?.leagueName && (
              <div
                className="league-title"
                aria-label={`League ${ds.leagueName}`}
                style={{ fontSize: '1rem', marginBottom: '0.25rem' }}
              >
                {ds.leagueName}
              </div>
            )}
            <div className="font-bold" style={{ fontSize: '1.1rem' }}>
              {ds?.onTheClock
                ? <span className="text-green">On the Clock!</span>
                : `Your pick: ${formatEta(ds?.myNextPickEta)}`}
            </div>
            <div className="text-xs text-secondary">
              Pick {ds?.currentPick} -- Next yours: #{ds?.myNextPick}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.25rem' }}>
            {ds?.winWindow && <WinWindowBadge label={ds.winWindow.label} reason={null} />}
            <FreshnessTag isLive={ds?.status === 'drafting'} />
          </div>
        </div>

        {/* Mode toggle */}
        <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
          <div className="toggle-group">
            <button className={`toggle-btn ${mode === 'team_need' ? 'active' : ''}`} onClick={() => setMode('team_need')}>
              Team Need
            </button>
            <button className={`toggle-btn ${mode === 'bpa' ? 'active' : ''}`} onClick={() => setMode('bpa')}>
              BPA
            </button>
          </div>

          <button
            className={`btn ${showQueue ? 'btn-primary' : 'btn-secondary'} text-sm`}
            style={{ padding: '0.3rem 0.7rem' }}
            onClick={() => setShowQueue(q => !q)}
          >
            Queue {queue.length > 0 ? `(${queue.length})` : ''}
          </button>

          {leagueId && (
            <button
              className={`btn ${showTargets ? 'btn-primary' : 'btn-secondary'} text-sm`}
              style={{ padding: '0.3rem 0.7rem' }}
              onClick={() => setShowTargets(t => !t)}
            >
              {showTargets ? '▲ Targets' : '▼ Targets'}
            </button>
          )}
        </div>
      </div>

      {/* Strategy hint: trade-back or trade-up alert */}
      {ds?.strategyHint && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.65rem 0.8rem',
            borderRadius: 8,
            border: `1px solid ${ds.strategyHint.type === 'trade_back_or_pivot' ? '#7f1d1d88' : '#1e3a5f88'}`,
            background: ds.strategyHint.type === 'trade_back_or_pivot' ? '#7f1d1d22' : '#1e3a5f22',
          }}
        >
          <div
            className="text-xs font-semibold"
            style={{ color: ds.strategyHint.type === 'trade_back_or_pivot' ? '#fda4af' : '#93c5fd', marginBottom: '0.25rem' }}
          >
            {ds.strategyHint.type === 'trade_back_or_pivot' ? '⬇ Trade Back / Pivot' : '⬆ Trade Up Alert'}
          </div>
          <div className="text-xs text-secondary" style={{ marginBottom: '0.4rem' }}>
            {ds.strategyHint.message}
          </div>
          {/* Trade partner details from strategyHint */}
          {ds.strategyHint.tradeBackPartners?.length > 0 && (
            <div style={{ marginBottom: '0.35rem' }}>
              {ds.strategyHint.tradeBackPartners.slice(0, 3).map((p, i) => (
                <div key={i} className="text-xs text-muted">
                  → {p.username}: pick {p.nextPick} ({p.picksBackFromUs > 0
                    ? `${p.picksBackFromUs} back`
                    : `${Math.abs(p.picksBackFromUs)} forward`})
                </div>
              ))}
            </div>
          )}
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem', marginTop: '0.1rem' }}
            onClick={hintTrades ? () => setHintTrades(null) : handleLoadHintTrades}
            disabled={loadingHintTrades}
          >
            {loadingHintTrades ? 'Loading…' : hintTrades ? 'Hide trade details' : 'View trade options'}
          </button>
          {hintTrades && (
            <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {hintTrades.context && (
                <div className="text-xs text-muted">
                  Your pick: <strong style={{ color: 'var(--text-secondary)' }}>{hintTrades.context.myNextPickLabel || `#${hintTrades.context.myNextPickNumber}`}</strong>
                  {hintTrades.context.targetExpectedPick != null && (
                    <> · player expected ~pick <strong style={{ color: 'var(--text-secondary)' }}>{hintTrades.context.targetExpectedPick}</strong></>
                  )}
                </div>
              )}

              {hintTrades.tradeUp?.length > 0 && (
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--green)', marginBottom: '0.3rem' }}>↑ Move up to secure them</div>
                  {hintTrades.tradeUp.slice(0, 2).map((t, i) => (
                    <HintTradeCard key={i} suggestion={t} direction="up" />
                  ))}
                </div>
              )}

              {hintTrades.tradeDown?.length > 0 && (
                <div>
                  <div className="text-xs font-semibold" style={{ color: 'var(--yellow)', marginBottom: '0.3rem' }}>↓ Trade back + still land them</div>
                  {hintTrades.tradeDown.slice(0, 2).map((t, i) => (
                    <HintTradeCard key={i} suggestion={t} direction="down" />
                  ))}
                </div>
              )}

              {!hintTrades.tradeUp?.length && !hintTrades.tradeDown?.length && (
                <div className="text-xs text-muted">No specific trade partners found in the draft order window.</div>
              )}
            </div>
          )}

          {/* Secure a "better value now" player by trading up */}
          {ds.strategyHint.betterValueNow?.length > 0 && (
            <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.45rem' }}>
              <div className="text-xs font-semibold" style={{ color: 'var(--text-muted)', marginBottom: '0.3rem' }}>Want to secure one of the better-value options instead?</div>
              {ds.strategyHint.betterValueNow.map((player) => (
                <div key={player.id} style={{ marginBottom: '0.35rem' }}>
                  <button
                    className="btn btn-secondary"
                    style={{ fontSize: '0.72rem', padding: '0.25rem 0.6rem' }}
                    onClick={() => handleLoadBetterNowTrades(player.id)}
                    disabled={!!loadingBetterNow[player.id]}
                  >
                    {loadingBetterNow[player.id]
                      ? 'Loading…'
                      : betterNowTrades[player.id]
                        ? `▲ Hide — ${player.name}`
                        : `↑ Secure ${player.name}`}
                  </button>
                  {betterNowTrades[player.id]?.tradeUp?.length > 0 && (
                    <div style={{ marginTop: '0.3rem' }}>
                      {betterNowTrades[player.id].tradeUp.slice(0, 2).map((t, i) => (
                        <HintTradeCard key={i} suggestion={t} direction="up" />
                      ))}
                    </div>
                  )}
                  {betterNowTrades[player.id] && !betterNowTrades[player.id].tradeUp?.length && (
                    <div className="text-xs text-muted" style={{ marginTop: '0.2rem' }}>No trade-up options found for {player.name}.</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Always-visible top recommendations */}
      {ds?.recommended?.length > 0 && (
        <div
          className="card"
          style={{ marginBottom: '1rem', padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.45rem' }}
        >
          <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
            Top live recommendations
          </div>
          {ds.recommended.slice(0, 3).map((p, idx) => {
            const id = p.sleeperId || p._id?.toString();
            return (
              <button
                key={id || idx}
                className="btn btn-secondary"
                style={{ justifyContent: 'space-between', width: '100%', padding: '0.45rem 0.6rem' }}
                onClick={() => setActiveTradePlayer(p)}
                aria-label={`View recommendation details for ${p.name}`}
              >
                <span style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {idx + 1}. {p.name} ({p.position})
                </span>
                <span className="text-xs text-muted" style={{ marginLeft: '0.5rem' }}>
                  DAS {p.dasScore ?? '--'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Draft Targets panel (pre-draft / during draft) */}
      {showTargets && leagueId && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.85rem',
            background: 'var(--bg-card)',
            borderRadius: 10,
            border: '1px solid var(--border, #2a2a3e)',
          }}
        >
          <DraftTargets leagueId={leagueId} draftId={draftId} />
        </div>
      )}

      {/* Queue (collapsible on mobile) */}
      {showQueue && (
        <div style={{ marginBottom: '1rem' }}>
          <DraftQueue availablePlayers={ds?.available || []} />
        </div>
      )}

      {/* Recent picks */}
      {ds?.recentPicks?.length > 0 && (
        <div style={{ marginBottom: '1rem' }}>
          <div className="text-xs text-muted" style={{ marginBottom: '0.35rem' }}>Recent picks</div>
          <div className="flex gap-2" style={{ overflowX: 'auto', paddingBottom: '0.25rem' }}>
            {ds.recentPicks.map((p, i) => (
              <div key={i} style={{ flexShrink: 0, background: 'var(--bg-card)', borderRadius: 6, padding: '0.35rem 0.6rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
                <span className={`pos-${p.metadata?.position}`}>{p.metadata?.position} </span>
                {p.metadata?.first_name} {p.metadata?.last_name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Position filter */}
      <div className="flex gap-1" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
        {positions.map(pos => (
          <button
            key={pos}
            className={`toggle-btn ${filter === pos ? 'active' : ''}`}
            style={{ padding: '0.25rem 0.6rem' }}
            onClick={() => setFilter(pos)}
          >
            {pos}
          </button>
        ))}
      </div>

      {/* Trade panel */}
      {activeTradePlayer && (
        <TradePanel
          player={activeTradePlayer}
          draftId={draftId}
          onClose={() => setActiveTradePlayer(null)}
        />
      )}

      {/* Player board */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {available.length === 0 && (
          <div className="text-secondary text-sm" style={{ textAlign: 'center', padding: '2rem' }}>No players available</div>
        )}
        {available.map(player => {
          const id = player.sleeperId || player._id?.toString();
          return (
            <PlayerCard
              key={id}
              player={player}
              isQueued={queue.includes(id)}
              onQueue={() => queue.includes(id) ? removeFromQueue(id) : addToQueue(id)}
              onViewTrades={() => setActiveTradePlayer(player)}
              showAvailability={true}
            />
          );
        })}
      </div>

      {/* Faller / buy-sell alert toasts */}
      <AlertContainer />
    </Layout>
  );
}

/* ── Compact trade card shown inside the strategy hint panel ─────────────── */
function HintTradeCard({ suggestion, direction }) {
  const [showAll, setShowAll] = useState(false);
  const isUp = direction === 'up';
  const accentColor = isUp ? 'var(--green)' : 'var(--yellow)';
  const manager = suggestion.targetManager?.username || 'Unknown';
  const cmp = suggestion.pickComparison;
  const packages = (suggestion.packages && suggestion.packages.length > 0)
    ? suggestion.packages
    : (() => {
        const ourPick = cmp?.ourPick;
        const theirPick = cmp?.theirPick;
        if (!ourPick || !theirPick) return [];
        const baseFuture = isUp
          ? { label: '2027 2nd (Mid)', fpValue: 12 }
          : { label: '2027 3rd Round', fpValue: 5 };
        return [{
          label: isUp ? `${ourPick.label} + ${baseFuture.label}` : `${ourPick.label} -> ${theirPick.label} + ${baseFuture.label}`,
          giving: isUp
            ? [
                { type: 'pick', label: ourPick.label, fpValue: ourPick.fpValue || 0 },
                { type: 'pick', label: baseFuture.label, fpValue: baseFuture.fpValue },
              ]
            : [
                { type: 'pick', label: ourPick.label, fpValue: ourPick.fpValue || 0 },
              ],
          receiving: isUp
            ? [{ type: 'pick', label: theirPick.label, fpValue: theirPick.fpValue || 0 }]
            : [
                { type: 'pick', label: theirPick.label, fpValue: theirPick.fpValue || 0 },
                { type: 'pick', label: baseFuture.label, fpValue: baseFuture.fpValue },
              ],
          fairness: 'slight-favour-them',
          overpayPct: null,
          notes: 'Fallback package generated from pick values.',
        }];
      })();
  const visiblePkgs = showAll ? packages : packages.slice(0, 1);

  const ourFp   = cmp?.ourPick?.fpValue  || 0;
  const theirFp = cmp?.theirPick?.fpValue || 0;
  const maxFp   = Math.max(ourFp, theirFp, 1);

  return (
    <div style={{ background: 'var(--bg-primary)', borderRadius: 7, border: `1px solid var(--border)`, marginBottom: '0.35rem', padding: '0.45rem 0.6rem' }}>
      {/* Manager + pick direction */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
        <span style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-primary)' }}>{manager}</span>
        {cmp && (
          <span style={{ fontSize: '0.68rem', color: accentColor }}>
            {cmp.ourPick?.label} → {cmp.theirPick?.label}
          </span>
        )}
      </div>

      {/* FP value bar */}
      {cmp && (
        <div style={{ marginBottom: '0.3rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.64rem', color: 'var(--text-muted)', marginBottom: '0.08rem' }}>
            <span>{cmp.ourPick?.label} — {ourFp} FP</span>
            <span>{cmp.theirPick?.label} — {theirFp} FP</span>
          </div>
          <div style={{ display: 'flex', gap: 3, height: 4, borderRadius: 3, overflow: 'hidden', background: 'var(--bg-secondary)' }}>
            <div style={{ width: `${(ourFp / maxFp) * 100}%`, background: 'var(--text-muted)', borderRadius: 3 }} />
            <div style={{ width: `${(theirFp / maxFp) * 100}%`, background: accentColor, borderRadius: 3 }} />
          </div>
          {isUp && cmp.neededToAdd > 0 && (
            <div style={{ fontSize: '0.63rem', color: 'var(--text-muted)', marginTop: '0.12rem' }}>
              Gap: {cmp.rawGap?.toFixed(1)} FP · add ~{cmp.neededToAdd?.toFixed(1)} FP (10% premium)
              {cmp.theirPositionalNeed && <> · they need <strong style={{ color: 'var(--text-secondary)' }}>{cmp.theirPositionalNeed}</strong></>}
            </div>
          )}
          {!isUp && cmp.rawSurplus > 0 && (
            <div style={{ fontSize: '0.63rem', color: 'var(--text-muted)', marginTop: '0.12rem' }}>
              You drop {cmp.rawSurplus?.toFixed(1)} FP · ask back ~{cmp.requestBack?.toFixed(1)} FP
            </div>
          )}
        </div>
      )}

      {/* Package options — always visible, no expand click needed */}
      {visiblePkgs.map((pkg, i) => (
        <div key={i} style={{ background: 'var(--bg-secondary)', borderRadius: 5, padding: '0.35rem 0.5rem', marginBottom: '0.2rem', border: pkg.positionalFit ? `1px solid ${accentColor}44` : '1px solid transparent' }}>
          {pkg.positionalFit && (
            <div style={{ fontSize: '0.6rem', color: 'var(--green)', fontWeight: 700, marginBottom: '0.08rem' }}>✓ POSITIONAL FIT</div>
          )}
          <div style={{ fontSize: '0.71rem', marginBottom: '0.12rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Give: </span>
            {(pkg.giving || []).map((a, j) => (
              <span key={j} style={{ color: isUp ? 'var(--red, #ef4444)' : 'var(--text-primary)', fontWeight: 600, marginRight: '0.3rem' }}>
                {a.position && <span style={{ opacity: 0.65, fontWeight: 400 }}>{a.position} </span>}{a.label}
                {a.fpValue > 0 && <span style={{ opacity: 0.5, fontWeight: 400, fontSize: '0.63rem' }}> ({a.fpValue} FP)</span>}
              </span>
            ))}
          </div>
          <div style={{ fontSize: '0.71rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>Get: </span>
            {(pkg.receiving || []).map((a, j) => (
              <span key={j} style={{ color: accentColor, fontWeight: 600, marginRight: '0.3rem' }}>
                {a.label}
                {a.fpValue > 0 && <span style={{ opacity: 0.5, fontWeight: 400, fontSize: '0.63rem' }}> ({a.fpValue} FP)</span>}
              </span>
            ))}
          </div>
          {pkg.fairness && (
            <div style={{ fontSize: '0.62rem', marginTop: '0.1rem', color: pkg.fairness === 'fair' ? 'var(--green)' : pkg.fairness === 'aggressive' ? 'var(--red,#ef4444)' : 'var(--yellow)' }}>
              {pkg.fairness === 'fair' ? 'Fair value' : `~${pkg.overpayPct}% over fair${pkg.fairness === 'aggressive' ? ' — aggressive' : ''}`}
            </div>
          )}
        </div>
      ))}

      {packages.length > 1 && (
        <button
          onClick={() => setShowAll(s => !s)}
          style={{ fontSize: '0.64rem', color: 'var(--text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.05rem 0', marginTop: '0.05rem' }}
        >
          {showAll ? '▴ Show less' : `▾ ${packages.length - 1} more option${packages.length > 2 ? 's' : ''}`}
        </button>
      )}
    </div>
  );
}
