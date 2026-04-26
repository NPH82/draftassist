import { useState } from 'react';
import { getDraftTrades } from '../../services/api';

const fmt    = (n) => Math.round(n || 0).toLocaleString();
const fmtKtc = (n) => n > 0 ? Math.round(n).toLocaleString() : null;
// Returns a short display string showing available value sources
function assetValueLabel(asset) {
  const fp  = asset.fpValue  > 0 ? `${asset.fpValue} FP`  : null;
  // For players, prefer raw ktcValue; for picks use ktcValue attached to asset
  const ktcRaw = asset.ktcValue > 0 ? asset.ktcValue : null;
  const ktc = ktcRaw ? `${Math.round(ktcRaw).toLocaleString()} KTC` : null;
  if (fp && ktc) return `${fp} / ${ktc}`;
  return fp || ktc || '';
}

/**
 * Trade panel -- shown when user taps "View trade options" on a player card.
 */
export default function TradePanel({ player, draftId, onClose }) {
  const [trades, setTrades] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await getDraftTrades(draftId, player.sleeperId || player._id);
      setTrades(data);
    } catch {
      setTrades({ tradeUp: [], tradeDown: [] });
    } finally {
      setLoading(false);
    }
  };

  if (!trades && !loading) {
    return (
      <div className="card" style={{ marginTop: '0.75rem' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: '0.75rem' }}>
          <span className="font-semibold">Trade Options for {player.name}</span>
          <button className="btn btn-ghost text-sm" onClick={onClose}>✕ Close</button>
        </div>
        <button className="btn btn-primary w-full" onClick={load}>Load Trade Suggestions</button>
      </div>
    );
  }

  const myPickLabel = trades?.context?.myNextPickLabel || `Pick ${trades?.context?.myNextPickNumber}`;

  return (
    <div className="card" style={{ marginTop: '0.75rem' }}>
      <div className="flex justify-between items-center" style={{ marginBottom: '0.75rem' }}>
        <span className="font-semibold">Trade Options for {player.name}</span>
        <button className="btn btn-ghost text-sm" onClick={onClose}>✕ Close</button>
      </div>

      {loading && <div className="text-secondary text-sm">Analysing trade opportunities…</div>}

      {trades && (
        <>
          {/* Context banner */}
          {trades.context && (
            <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '0.5rem 0.75rem', marginBottom: '1rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
              Your next pick: <strong style={{ color: 'var(--text-primary)' }}>{myPickLabel}</strong>
              {trades.context.targetExpectedPick && (
                <> · {player.name} expected at pick <strong style={{ color: 'var(--text-primary)' }}>{Math.round(trades.context.targetExpectedPick)}</strong></>
              )}
            </div>
          )}

          {trades.tradeUp.length > 0 && (
            <section style={{ marginBottom: '1.25rem' }}>
              <h4 style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--green)', marginBottom: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                ↑ Move Up to Land {player.name}
              </h4>
              {trades.tradeUp.map((t, i) => (
                <TradeUpCard key={i} suggestion={t} myPickLabel={myPickLabel} />
              ))}
            </section>
          )}

          {trades.tradeDown.length > 0 && (
            <section>
              <h4 style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--yellow)', marginBottom: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                ↓ Drop Back + Gain Capital
              </h4>
              {trades.tradeDown.map((t, i) => (
                <TradeDownCard key={i} suggestion={t} myPickLabel={myPickLabel} />
              ))}
            </section>
          )}

          {trades.tradeUp.length === 0 && trades.tradeDown.length === 0 && (
            <div className="text-secondary text-sm">No trade opportunities available right now.</div>
          )}
        </>
      )}
    </div>
  );
}

/* ── Trade-Up Card ────────────────────────────────────────────────────────── */
function TradeUpCard({ suggestion, myPickLabel }) {
  const [expanded, setExpanded] = useState(false);
  const { pickComparison, packages = [], targetManager, reason } = suggestion;

  return (
    <div style={{ background: 'var(--bg-primary)', borderRadius: 8, marginBottom: '0.6rem', border: '1px solid var(--border)', overflow: 'hidden' }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ width: '100%', textAlign: 'left', padding: '0.6rem 0.75rem', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        <div className="flex justify-between items-center">
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            {targetManager?.username || 'Unknown Manager'}
          </span>
          <span style={{ fontSize: '0.72rem', color: 'var(--green)' }}>{expanded ? '▲' : '▼'}</span>
        </div>

        {pickComparison && (
          <PickValueBar
            ourPick={pickComparison.ourPick}
            theirPick={pickComparison.theirPick}
            direction="up"
          />
        )}

        {pickComparison?.neededToAdd > 0 && (
          <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            Gap:{' '}
            <strong style={{ color: 'var(--yellow)' }}>
              {pickComparison.rawGap.toFixed(1)} FP
            </strong>
            {' '}· need to add (12% premium):{' '}
            <strong style={{ color: 'var(--orange, #f59e0b)' }}>
              ~{pickComparison.neededToAdd.toFixed(1)} FP
            </strong>
          </div>
        )}
        {pickComparison?.theirPositionalNeed && (
          <div style={{ marginTop: '0.2rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            They need: <strong style={{ color: 'var(--text-secondary)' }}>{pickComparison.theirPositionalNeed}</strong>
          </div>
        )}
      </button>

      {/* Package Options */}
      {expanded && packages.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '0.6rem 0.75rem' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Package Options
          </div>
          {packages.map((pkg, i) => (
            <PackageOption key={i} pkg={pkg} direction="up" />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Trade-Down Card ──────────────────────────────────────────────────────── */
function TradeDownCard({ suggestion, myPickLabel }) {
  const [expanded, setExpanded] = useState(false);
  const { pickComparison, packages = [], targetManager, safeZone, exploratory } = suggestion;

  return (
    <div style={{ background: 'var(--bg-primary)', borderRadius: 8, marginBottom: '0.6rem', border: `1px solid ${safeZone ? 'var(--yellow)' : 'var(--border)'}`, overflow: 'hidden', opacity: exploratory ? 0.85 : 1 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{ width: '100%', textAlign: 'left', padding: '0.6rem 0.75rem', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        <div className="flex justify-between items-center">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
              {targetManager?.username || 'Unknown Manager'}
            </span>
            {safeZone && <span style={{ fontSize: '0.65rem', background: 'var(--yellow)', color: '#000', borderRadius: 4, padding: '0.1rem 0.35rem', fontWeight: 700 }}>SAFE</span>}
            {exploratory && <span style={{ fontSize: '0.65rem', background: 'var(--border)', color: 'var(--text-muted)', borderRadius: 4, padding: '0.1rem 0.35rem' }}>RISKY</span>}
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--yellow)' }}>{expanded ? '▲' : '▼'}</span>
        </div>

        {pickComparison && (
          <PickValueBar
            ourPick={pickComparison.ourPick}
            theirPick={pickComparison.theirPick}
            direction="down"
          />
        )}

        {pickComparison?.rawSurplus > 0 && (
          <div style={{ marginTop: '0.35rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
            Your surplus:{' '}
            <strong style={{ color: 'var(--green)' }}>
              {pickComparison.rawSurplus.toFixed(1)} FP
            </strong>
            {' '}· asking back (88%):{' '}
            <strong style={{ color: 'var(--green)' }}>
              ~{pickComparison.requestBack.toFixed(1)} FP
            </strong>
          </div>
        )}
      </button>

      {expanded && packages.length > 0 && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '0.6rem 0.75rem' }}>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Package Options
          </div>
          {packages.map((pkg, i) => (
            <PackageOption key={i} pkg={pkg} direction="down" />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Pick value comparison bar ────────────────────────────────────────────── */
function PickValueBar({ ourPick, theirPick, direction }) {
  const ourFp  = ourPick.fpValue   || 0;
  const theirFp = theirPick.fpValue || 0;
  const maxVal  = Math.max(ourFp, theirFp, 1);
  const ourPct  = (ourFp  / maxVal) * 100;
  const theirPct = (theirFp / maxVal) * 100;
  const accentColor = direction === 'up' ? 'var(--green, #22c55e)' : 'var(--yellow, #eab308)';

  const ourKtc   = ourPick.ktcValue   > 0 ? ` / ${Math.round(ourPick.ktcValue).toLocaleString()} KTC`   : '';
  const theirKtc = theirPick.ktcValue > 0 ? ` / ${Math.round(theirPick.ktcValue).toLocaleString()} KTC` : '';

  return (
    <div style={{ marginTop: '0.4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>
        <span>Your {ourPick.label} <span style={{ color: 'var(--text-secondary)' }}>({ourFp} FP{ourKtc})</span></span>
        <span>Their {theirPick.label} <span style={{ color: 'var(--text-secondary)' }}>({theirFp} FP{theirKtc})</span></span>
      </div>
      <div style={{ display: 'flex', gap: 3, height: 5, borderRadius: 3, overflow: 'hidden', background: 'var(--bg-secondary)' }}>
        <div style={{ width: `${ourPct}%`, background: 'var(--text-muted)', borderRadius: 3 }} />
        <div style={{ width: `${theirPct}%`, background: accentColor, borderRadius: 3 }} />
      </div>
    </div>
  );
}

/* ── Single package option row ────────────────────────────────────────────── */
function PackageOption({ pkg, direction }) {
  const isUp = direction === 'up';
  const giveColor    = isUp ? 'var(--red, #ef4444)'   : 'var(--text-primary)';
  const receiveColor = isUp ? 'var(--green, #22c55e)' : 'var(--yellow, #eab308)';

  return (
    <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '0.5rem 0.6rem', marginBottom: '0.35rem', border: pkg.positionalFit ? '1px solid var(--green, #22c55e)' : '1px solid transparent' }}>
      {pkg.positionalFit && (
        <div style={{ fontSize: '0.65rem', color: 'var(--green)', fontWeight: 700, marginBottom: '0.2rem' }}>✓ POSITIONAL FIT</div>
      )}

      {/* Give side */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.3rem', marginBottom: '0.2rem' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', minWidth: 40 }}>Give:</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
          {(pkg.giving || []).map((a, i) => (
            <AssetTag key={i} asset={a} color={giveColor} />
          ))}
        </div>
      </div>

      {/* Receive side */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.3rem', marginBottom: '0.2rem' }}>
        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', minWidth: 40 }}>Get:</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
          {(pkg.receiving || []).map((a, i) => (
            <AssetTag key={i} asset={a} color={receiveColor} />
          ))}
        </div>
      </div>

      {/* Value totals (FP scale) */}
      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
        <span>You give: <strong style={{ color: giveColor }}>{(pkg.giveTotal || 0).toFixed(1)} FP</strong></span>
        <span>You get: <strong style={{ color: receiveColor }}>{(pkg.receiveTotal || 0).toFixed(1)} FP</strong></span>
      </div>

      {pkg.notes && (
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.25rem', fontStyle: 'italic' }}>
          {pkg.notes}
        </div>
      )}
    </div>
  );
}

/* ── Asset pill (pick or player) ──────────────────────────────────────────── */
function AssetTag({ asset, color }) {
  const valueStr = assetValueLabel(asset);
  return (
    <span style={{
      fontSize: '0.7rem',
      background: 'var(--bg-primary)',
      border: `1px solid ${color}33`,
      color,
      borderRadius: 4,
      padding: '0.1rem 0.4rem',
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {asset.position && <span style={{ opacity: 0.7, marginRight: '0.2rem' }}>{asset.position}</span>}
      {asset.label}
      {valueStr && (
        <span style={{ opacity: 0.6, fontWeight: 400, marginLeft: '0.3rem', fontSize: '0.65rem' }}>
          {valueStr}
        </span>
      )}
    </span>
  );
}
