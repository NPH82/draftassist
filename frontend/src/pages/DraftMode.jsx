import { useState } from 'react';
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

  const leagueId = ds?.leagueId || null;

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

  const ds = draftState;
  const available = (ds?.available || []).filter(p => filter === 'ALL' || p.position === filter);

  const positions = ['ALL', 'QB', 'RB', 'WR', 'TE'];

  return (
    <Layout>
      {/* Draft header */}
      <div style={{ marginBottom: '1rem' }}>
        <div className="flex justify-between items-center" style={{ marginBottom: '0.5rem' }}>
          <div>
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
