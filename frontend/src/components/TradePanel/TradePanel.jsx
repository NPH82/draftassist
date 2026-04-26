import { useState } from 'react';
import { getDraftTrades } from '../../services/api';

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
          <button className="btn btn-ghost text-sm" onClick={onClose}>x Close</button>
        </div>
        <button className="btn btn-primary w-full" onClick={load}>Load Trade Suggestions</button>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: '0.75rem' }}>
      <div className="flex justify-between items-center" style={{ marginBottom: '0.75rem' }}>
        <span className="font-semibold">Trade Options for {player.name}</span>
        <button className="btn btn-ghost text-sm" onClick={onClose}>x Close</button>
      </div>

      {loading && <div className="text-secondary text-sm">Loading...</div>}

      {trades && (
        <>
          {trades.tradeUp.length > 0 && (
            <section style={{ marginBottom: '1rem' }}>
              <h4 className="text-sm font-semibold text-green" style={{ marginBottom: '0.5rem' }}>Trade Up</h4>
              {trades.tradeUp.map((t, i) => (
                <TradeSuggestion key={i} suggestion={t} />
              ))}
            </section>
          )}
          {trades.tradeDown.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-yellow" style={{ marginBottom: '0.5rem' }}>Trade Down</h4>
              {trades.tradeDown.map((t, i) => (
                <TradeSuggestion key={i} suggestion={t} />
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

function TradeSuggestion({ suggestion }) {
  return (
    <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '0.6rem 0.75rem', marginBottom: '0.4rem', border: '1px solid var(--border)' }}>
      <div className="text-sm font-semibold" style={{ marginBottom: '0.25rem' }}>
        Target: {suggestion.targetManager?.username || 'Unknown Manager'}
      </div>
      <div className="text-xs text-secondary">{suggestion.reason}</div>
      {suggestion.package && (
        <div className="text-xs" style={{ marginTop: '0.3rem' }}>
          <span className="text-muted">Give: </span>
          {suggestion.package.giving?.map((a, i) => <span key={i}>{a.label} </span>)}
        </div>
      )}
      {suggestion.fairness && (
        <div className={`text-xs ${suggestion.fairness.isFair ? 'text-green' : 'text-yellow'}`} style={{ marginTop: '0.2rem' }}>
          {suggestion.fairness.isFair ? 'Fair deal' : `Value gap: ~${suggestion.fairness.deltaPercent}%`}
        </div>
      )}
    </div>
  );
}
