import { dasClass } from '../../utils/formatting';

/**
 * PlayerCard -- compact mobile-first card for the draft board
 * Props:
 *   player: { name, position, team, age, dasScore, dasBreakdown, fantasyProsRank, ktcRank, ktcValue, fantasyProsValue, valueGap, availabilityProb, ... }
 *   isQueued: bool
 *   onQueue: () => void
 *   onViewTrades: () => void
 *   showAvailability: bool
 */
export default function PlayerCard({ player, isQueued, onQueue, onViewTrades, showAvailability = false }) {
  const das = player.dasScore ?? '--';
  const scoreClass = typeof das === 'number' ? dasClass(das) : 'das-low';
  const vg = player.valueGap;

  return (
    <div
      className="card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
        padding: '0.75rem',
        borderLeft: `3px solid ${posColor(player.position)}`,
        opacity: player.taken ? 0.4 : 1,
      }}
    >
      {/* Row 1: DAS score + name + position badge */}
      <div className="flex gap-3 items-center">
        <div className={`das-score ${scoreClass}`}>{das}</div>
        <div className="flex flex-col" style={{ flex: 1, minWidth: 0 }}>
          <div className="flex items-center gap-2">
            <span className="font-bold" style={{ fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {player.name}
            </span>
            {vg?.isGap && (
              <span className="badge badge-gap" title={`${vg.favors} ranks higher by ${vg.rankDiff} spots`}>
                {vg.favors} +{vg.rankDiff}
              </span>
            )}
          </div>
          <div className="flex gap-2 items-center">
            <span className={`badge badge-${player.position}`}>{player.position}</span>
            {player.team && <span className="text-xs text-secondary">{player.team}</span>}
            {player.age && <span className="text-xs text-muted">Age {player.age}</span>}
          </div>
        </div>
        {/* Queue button */}
        <button
          className={`btn ${isQueued ? 'btn-primary' : 'btn-secondary'}`}
          style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
          onClick={onQueue}
          aria-label={isQueued ? 'Remove from queue' : 'Add to queue'}
        >
          {isQueued ? 'Queued' : '+ Queue'}
        </button>
      </div>

      {/* Row 2: External rankings */}
      <div className="flex gap-4" style={{ fontSize: '0.78rem' }}>
        <span>
          <span className="text-muted">FP:</span>{' '}
          <span className="font-semibold">{player.fantasyProsRank ? `#${player.fantasyProsRank}` : '--'}</span>
        </span>
        <span>
          <span className="text-muted">KTC:</span>{' '}
          <span className="font-semibold">{player.ktcValue ? player.ktcValue.toLocaleString() : '--'}</span>
        </span>
        {player.underdogAdp && (
          <span>
            <span className="text-muted">ADP:</span>{' '}
            <span className="font-semibold">{player.underdogAdp.toFixed(1)}</span>
          </span>
        )}
        {player.nflDraftRound && (
          <span>
            <span className="text-muted">Rd:</span>{' '}
            <span className="font-semibold">{player.nflDraftRound}</span>
          </span>
        )}
      </div>

      {/* Row 3: Availability bar */}
      {showAvailability && player.availabilityProb != null && (
        <div>
          <div className="flex justify-between" style={{ fontSize: '0.7rem', marginBottom: '2px' }}>
            <span className="text-muted">Availability</span>
            <span className={player.availabilityProb < 0.3 ? 'text-red' : player.availabilityProb < 0.6 ? 'text-yellow' : 'text-green'}>
              {Math.round(player.availabilityProb * 100)}%
            </span>
          </div>
          <div className="avail-bar">
            <div
              className="avail-fill"
              style={{
                width: `${player.availabilityProb * 100}%`,
                background: player.availabilityProb < 0.3 ? 'var(--red)' : player.availabilityProb < 0.6 ? 'var(--yellow)' : 'var(--green)',
              }}
            />
          </div>
        </div>
      )}

      {/* Row 4: Trade action */}
      {onViewTrades && (
        <button className="btn btn-ghost text-xs" style={{ alignSelf: 'flex-start', padding: '0.1rem 0' }} onClick={() => onViewTrades(player)}>
          View trade options
        </button>
      )}
    </div>
  );
}

function posColor(pos) {
  const map = { QB: '#3b82f6', RB: '#22c55e', WR: '#a855f7', TE: '#f97316' };
  return map[pos] || 'var(--border)';
}
