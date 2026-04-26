import { useEffect, useState } from 'react';
import Layout from '../components/Layout/Layout';
import WinWindowBadge from '../components/WinWindow/WinWindowBadge';
import { getTradeHubSuggestions } from '../services/api';
import { useApp } from '../context/AppContext';

export default function TradeHub() {
  const { leagues } = useApp();
  const [suggestions, setSuggestions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selectedLeague, setSelectedLeague] = useState('all');

  useEffect(() => {
    getTradeHubSuggestions()
      .then(d => setSuggestions(d))
      .catch(() => setSuggestions({ byLeague: [] }))
      .finally(() => setLoading(false));
  }, []);

  const groups = suggestions?.byLeague || [];
  const visible = selectedLeague === 'all' ? groups : groups.filter(g => g.leagueId === selectedLeague);

  return (
    <Layout>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700 }}>Trade Hub</h1>
          <p className="text-secondary text-sm">Off-season trade opportunities across your leagues</p>
        </div>

        {/* League filter */}
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <button className={`toggle-btn ${selectedLeague === 'all' ? 'active' : ''}`} onClick={() => setSelectedLeague('all')}>
            All Leagues
          </button>
          {leagues.map(lg => (
            <button
              key={lg.leagueId}
              className={`toggle-btn ${selectedLeague === lg.leagueId ? 'active' : ''}`}
              onClick={() => setSelectedLeague(lg.leagueId)}
            >
              {lg.name}
            </button>
          ))}
        </div>

        {loading && <div className="text-secondary text-sm">Loading trade suggestions...</div>}

        {!loading && visible.length === 0 && (
          <div className="card text-secondary text-sm" style={{ textAlign: 'center', padding: '2rem' }}>
            No trade suggestions available. Add more leagues from your Sleeper account.
          </div>
        )}

        {visible.map(group => (
          <section key={group.leagueId}>
            <h2 className="font-semibold" style={{ marginBottom: '0.75rem' }}>{group.leagueName}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {(group.trades || []).map((t, i) => (
                <TradeSuggestionCard key={i} trade={t} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Layout>
  );
}

function TradeSuggestionCard({ trade }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card">
      <div className="flex justify-between items-start">
        <div>
          <div className="font-semibold">{trade.summary || `Deal with ${trade.targetManager?.username}`}</div>
          <div className="text-xs text-secondary" style={{ marginTop: '0.2rem' }}>{trade.reason}</div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
          {trade.fairness && (
            <span className={`badge ${trade.fairness.isFair ? 'text-green' : 'text-yellow'}`} style={{ background: 'transparent', border: '1px solid currentColor' }}>
              {trade.fairness.isFair ? 'Fair' : `~${trade.fairness.deltaPercent}%`}
            </span>
          )}
          <button className="btn btn-ghost text-xs" onClick={() => setExpanded(e => !e)}>
            {expanded ? 'Less' : 'Details'}
          </button>
        </div>
      </div>

      {expanded && (
        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {/* Target manager */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.3rem' }}>
              {trade.targetManager?.username}
            </div>
            {trade.targetManager?.winWindow && (
              <WinWindowBadge label={trade.targetManager.winWindow} reason={null} />
            )}
            <div className="text-xs" style={{ marginTop: '0.35rem' }}>
              {(trade.targetAssets || []).map((a, i) => (
                <div key={i}>{a.label}</div>
              ))}
            </div>
          </div>

          {/* You give */}
          <div style={{ flex: 1, minWidth: 200 }}>
            <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.3rem' }}>You Give</div>
            <div className="text-xs">
              {(trade.yourAssets || []).map((a, i) => (
                <div key={i}>{a.label}</div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
