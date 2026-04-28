import { useState, useEffect } from 'react';
import { getDevyPool } from '../../services/api';

const POSITIONS = ['ALL', 'QB', 'RB', 'WR', 'TE'];
const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// Sort devy player by best available value signal
function devyValue(p) {
  return p.devyKtcValue || p.ktcValue || (p.fantasyProsValue || 0) || 0;
}

function fpEq(p) {
  return p?.fpEquivalent || 0;
}

function DevyPlayerRow({ player, showOwner }) {
  const val = devyValue(player);
  const posClass = `pos-${player.position}`;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto auto',
      alignItems: 'center',
      gap: '0.5rem',
      padding: '0.45rem 0.6rem',
      borderRadius: 6,
      background: 'var(--bg-secondary)',
      marginBottom: '0.25rem',
      opacity: showOwner ? 0.75 : 1,
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span className={posClass} style={{ fontSize: '0.7rem', fontWeight: 700, minWidth: 28 }}>
            {player.position}
          </span>
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            {player.name}
          </span>
          {player.onTaxi && (
            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', background: 'var(--bg-primary)', borderRadius: 3, padding: '0.05rem 0.3rem' }}>
              TAXI
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginTop: '0.08rem' }}>
          {[player.college, player.devyClass ? `'${String(player.devyClass).slice(-2)} class` : null]
            .filter(Boolean).join(' · ')}
          {player.fromPlayerNote && player.associatedPlayerName && (
            <span style={{ color: 'var(--text-muted)', marginLeft: '0.4rem' }}>
              via note on {player.associatedPlayerName}
            </span>
          )}
          {showOwner && player.ownerUsername && (
            <span style={{ color: 'var(--yellow)', marginLeft: '0.4rem' }}>→ {player.ownerUsername}</span>
          )}
          {!player.inOurDb && (
            <span style={{ color: 'var(--red, #ef4444)', marginLeft: '0.4rem' }}>⚠ not in DB</span>
          )}
        </div>
      </div>

      <div style={{ textAlign: 'right', fontSize: '0.7rem' }}>
        {val > 0 ? (
          <>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
              {player.devyKtcValue > 0 ? player.devyKtcValue.toLocaleString() : player.ktcValue > 0 ? player.ktcValue.toLocaleString() : '—'}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>
              {player.devyKtcValue > 0 ? 'KTC devy' : 'KTC'}
            </div>
            {fpEq(player) > 0 && (
              <div style={{ color: 'var(--yellow)', fontSize: '0.62rem', marginTop: '0.05rem' }}>
                ~{fpEq(player)} FP
              </div>
            )}
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>—</span>
        )}
      </div>

      {player.dasScore != null && (
        <div style={{ textAlign: 'right', fontSize: '0.7rem' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{player.dasScore}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>DAS</div>
        </div>
      )}
    </div>
  );
}

function RookiePlayerRow({ player }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto auto',
      alignItems: 'center',
      gap: '0.5rem',
      padding: '0.45rem 0.6rem',
      borderRadius: 6,
      background: 'var(--bg-secondary)',
      marginBottom: '0.25rem',
    }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span className={`pos-${player.position}`} style={{ fontSize: '0.7rem', fontWeight: 700, minWidth: 28 }}>
            {player.position}
          </span>
          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            {player.name}
          </span>
          {player.team && (
            <span style={{ fontSize: '0.65rem', color: 'var(--green)', fontWeight: 600 }}>{player.team}</span>
          )}
        </div>
        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
          {[player.college, player.nflDraftYear ? `NFL ${player.nflDraftYear}` : null].filter(Boolean).join(' · ')}
        </div>
      </div>

      <div style={{ textAlign: 'right', fontSize: '0.7rem' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
          {player.ktcValue > 0 ? player.ktcValue.toLocaleString() : '—'}
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>KTC rookie</div>
        {fpEq(player) > 0 && (
          <div style={{ color: 'var(--yellow)', fontSize: '0.62rem', marginTop: '0.05rem' }}>
            ~{fpEq(player)} FP
          </div>
        )}
      </div>

      {player.dasScore != null && (
        <div style={{ textAlign: 'right', fontSize: '0.7rem' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{player.dasScore}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}>DAS</div>
        </div>
      )}
    </div>
  );
}

export default function DevyPool({ leagueId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [posFilter, setPosFilter] = useState('ALL');
  const [tab, setTab] = useState('available'); // 'available' | 'rostered' | 'graduated' | 'compare'
  const [compareMode, setCompareMode] = useState('overall'); // 'overall' | 'position'
  const [showUnknown, setShowUnknown] = useState(false);

  useEffect(() => {
    if (!leagueId) return;
    setLoading(true);
    setError(null);
    getDevyPool(leagueId)
      .then(setData)
      .catch(err => setError(err?.response?.data?.error || 'Failed to load devy pool'))
      .finally(() => setLoading(false));
  }, [leagueId]);

  if (loading) return <div className="text-xs text-muted" style={{ padding: '0.5rem' }}>Loading devy pool…</div>;
  if (error) return <div className="text-xs" style={{ color: 'var(--red)', padding: '0.5rem' }}>{error}</div>;
  if (!data) return null;

  const filterPos = (players) =>
    posFilter === 'ALL' ? players : players.filter(p => p.position === posFilter);

  const available = filterPos(data.available || []);
  const rostered  = filterPos(data.rostered || []);
  const graduated = data.graduated || [];
  const unknown   = data.unknown || [];
  const availableRookies = filterPos(data.availableRookies || []);

  const buildComparisonRows = (devyList, rookieList, limit = 15) =>
    devyList.slice(0, limit).map((devy, idx) => {
      const rookie = rookieList[idx] || null;
      return {
        devy,
        rookie,
        fpGap: rookie ? Math.round((fpEq(devy) - fpEq(rookie)) * 10) / 10 : null,
      };
    });

  const comparisonRows = compareMode === 'overall'
    ? buildComparisonRows(available, availableRookies)
    : (posFilter === 'ALL' ? [] : buildComparisonRows(available, availableRookies));

  const groupedPositionRows = SKILL_POSITIONS.map((pos) => {
    const devyPos = (data.available || []).filter(p => p.position === pos);
    const rookiePos = (data.availableRookies || []).filter(p => p.position === pos);
    return {
      position: pos,
      rows: buildComparisonRows(devyPos, rookiePos, 8),
      devyCount: devyPos.length,
      rookieCount: rookiePos.length,
    };
  }).filter(group => group.devyCount > 0 || group.rookieCount > 0);

  const groupedRowCount = groupedPositionRows.reduce((sum, g) => sum + g.rows.length, 0);

  const tabLabel = (key) => ({
    available: `Available Devy (${filterPos(data.available || []).length})`,
    rostered:  `Drafted Devy (${filterPos(data.rostered || []).length})`,
    graduated: `Drafted to NFL (${graduated.length})`,
    compare: `Board Compare (${compareMode === 'position' && posFilter === 'ALL' ? groupedRowCount : comparisonRows.length})`,
  }[key]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
          🎓 Devy Pool
        </div>
        <div className="text-xs text-muted">
          {data.counts.rostered} rostered · {data.counts.available} devy available · {data.counts.availableRookies || 0} rookie available
        </div>
      </div>

      {/* Position filter */}
      <div className="flex gap-1" style={{ marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        {POSITIONS.map(pos => (
          <button
            key={pos}
            className={`toggle-btn${posFilter === pos ? ' active' : ''}`}
            style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
            onClick={() => setPosFilter(pos)}
          >
            {pos}
          </button>
        ))}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1" style={{ marginBottom: '0.5rem' }}>
        {['available', 'rostered', 'graduated', 'compare'].map(key => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              fontSize: '0.7rem',
              padding: '0.2rem 0.55rem',
              borderRadius: 5,
              border: 'none',
              cursor: 'pointer',
              background: tab === key ? 'var(--accent, #6366f1)' : 'var(--bg-secondary)',
              color: tab === key ? '#fff' : 'var(--text-muted)',
              fontWeight: tab === key ? 600 : 400,
            }}
          >
            {tabLabel(key)}
          </button>
        ))}
      </div>

      {/* Available pool */}
      {tab === 'available' && (
        <div>
          {available.length === 0 ? (
            <div className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>
              No available devy players found.{' '}
              {data.counts.available === 0 && 'Run "Import Devy Players" from the admin panel to seed the pool.'}
            </div>
          ) : (
            available.map(p => <DevyPlayerRow key={p.sleeperId} player={p} showOwner={false} />)
          )}
        </div>
      )}

      {/* Rookie availability pool */}
      {tab === 'compare' && (
        <div>
          <div className="text-xs text-muted" style={{ marginBottom: '0.35rem' }}>
            FP-equivalent blends FP value with KTC (converted) so devy and rookie pools can be compared on one scale.
          </div>

          <div className="flex gap-1" style={{ marginBottom: '0.45rem', flexWrap: 'wrap' }}>
            <button
              className={`toggle-btn${compareMode === 'overall' ? ' active' : ''}`}
              style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}
              onClick={() => setCompareMode('overall')}
            >
              Overall rank-by-rank
            </button>
            <button
              className={`toggle-btn${compareMode === 'position' ? ' active' : ''}`}
              style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}
              onClick={() => setCompareMode('position')}
            >
              Position rank-by-rank
            </button>
          </div>

          {compareMode === 'position' && posFilter === 'ALL' ? (
            <div>
              <div className="text-xs text-muted" style={{ marginBottom: '0.45rem' }}>
                Holistic position view: rank-by-rank comparisons are grouped by position.
              </div>

              {groupedPositionRows.length === 0 ? (
                <div className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>
                  No position comparison rows available yet.
                </div>
              ) : (
                groupedPositionRows.map(group => (
                  <div key={group.position} style={{ marginBottom: '0.6rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                      <div style={{ fontSize: '0.74rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                        {group.position}
                      </div>
                      <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                        {group.devyCount} devy · {group.rookieCount} rookie
                      </div>
                    </div>

                    {group.rows.length === 0 ? (
                      <div className="text-xs text-muted" style={{ padding: '0.25rem 0 0.4rem 0' }}>
                        No comparable rows for {group.position}.
                      </div>
                    ) : (
                      group.rows.map((row, idx) => (
                        <div key={`${group.position}-${row.devy?.sleeperId || idx}`} style={{
                          marginBottom: '0.35rem',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '0.45rem',
                          background: 'var(--bg-primary)',
                        }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.4rem', alignItems: 'center' }}>
                            <div style={{ fontSize: '0.78rem', fontWeight: 600 }}>{row.devy?.name || '—'}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                              {row.fpGap == null ? '—' : (row.fpGap >= 0 ? `+${row.fpGap} FP` : `${row.fpGap} FP`)}
                            </div>
                            <div style={{ fontSize: '0.78rem', fontWeight: 600, textAlign: 'right' }}>{row.rookie?.name || '—'}</div>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.4rem', marginTop: '0.1rem' }}>
                            <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                              ~{row.devy?.fpEquivalent || 0} FP
                            </div>
                            <div />
                            <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                              {row.rookie ? `~${row.rookie.fpEquivalent || 0} FP` : 'No rookie match'}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ))
              )}
            </div>
          ) : comparisonRows.length === 0 ? (
            <div className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>
              No comparison rows available yet.
            </div>
          ) : (
            comparisonRows.map((row, idx) => (
              <div key={`${row.devy?.sleeperId || idx}`} style={{
                marginBottom: '0.4rem',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '0.45rem',
                background: 'var(--bg-primary)',
              }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.4rem', alignItems: 'center' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Devy option</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>vs</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'right' }}>Rookie option</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.4rem', alignItems: 'center', marginTop: '0.2rem' }}>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600 }}>{row.devy?.name || '—'}</div>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                    {row.fpGap == null ? '—' : (row.fpGap >= 0 ? `+${row.fpGap} FP` : `${row.fpGap} FP`)}
                  </div>
                  <div style={{ fontSize: '0.78rem', fontWeight: 600, textAlign: 'right' }}>{row.rookie?.name || '—'}</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: '0.4rem', marginTop: '0.1rem' }}>
                  <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                    {row.devy?.position || '?'} · ~{row.devy?.fpEquivalent || 0} FP
                  </div>
                  <div />
                  <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                    {row.rookie ? `${row.rookie.position || '?'} · ~${row.rookie.fpEquivalent || 0} FP` : 'No rookie match'}
                  </div>
                </div>
              </div>
            ))
          )}

          <div style={{ marginTop: '0.55rem' }}>
            <div className="text-xs text-muted" style={{ marginBottom: '0.3rem' }}>Top currently available rookies in this league:</div>
            {availableRookies.length === 0 ? (
              <div className="text-xs text-muted" style={{ padding: '0.4rem 0' }}>No available rookies detected.</div>
            ) : (
              availableRookies.slice(0, 15).map((p, idx) => <RookiePlayerRow key={`${p.sleeperId || p.name}-${idx}`} player={p} />)
            )}
          </div>
        </div>
      )}

      {/* Rostered players */}
      {tab === 'rostered' && (
        <div>
          {rostered.length === 0 ? (
            <div className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>No rostered devy players found.</div>
          ) : (
            rostered.map(p => <DevyPlayerRow key={p.sleeperId} player={p} showOwner={true} />)
          )}
          {unknown.length > 0 && (
            <div style={{ marginTop: '0.5rem' }}>
              <button
                className="text-xs text-muted"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                onClick={() => setShowUnknown(s => !s)}
              >
                {showUnknown ? '▴' : '▾'} {unknown.length} rostered devy player{unknown.length !== 1 ? 's' : ''} not yet in DB
              </button>
              {showUnknown && unknown.map(p => (
                <DevyPlayerRow key={p.sleeperId} player={p} showOwner={true} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Graduated — NFL-drafted players still on devy rosters */}
      {tab === 'graduated' && (
        <div>
          {graduated.length === 0 ? (
            <div className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>No graduated players detected.</div>
          ) : (
            <>
              <div className="text-xs text-muted" style={{ marginBottom: '0.35rem' }}>
                These players were in the devy pool but are now on NFL rosters (2026 draft class). They may still be on devy rosters pending league action.
              </div>
              {graduated.map(p => (
                <div key={p.sleeperId} style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  alignItems: 'center',
                  padding: '0.4rem 0.6rem',
                  borderRadius: 6,
                  background: 'var(--bg-secondary)',
                  marginBottom: '0.25rem',
                  opacity: 0.7,
                }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <span className={`pos-${p.position}`} style={{ fontSize: '0.7rem', fontWeight: 700, minWidth: 28 }}>
                        {p.position}
                      </span>
                      <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>{p.name}</span>
                      {p.team && (
                        <span style={{ fontSize: '0.65rem', color: 'var(--green)', fontWeight: 600 }}>
                          {p.team}
                        </span>
                      )}
                      {p.onTaxi && (
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', background: 'var(--bg-primary)', borderRadius: 3, padding: '0.05rem 0.3rem' }}>
                          TAXI
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                      {p.college ? `${p.college} · ` : ''}NFL draft 2026
                      {p.ownerUsername && <span style={{ color: 'var(--yellow)', marginLeft: '0.4rem' }}>→ {p.ownerUsername}</span>}
                    </div>
                  </div>
                  <div style={{ fontSize: '0.68rem', color: 'var(--green)', fontWeight: 600, textAlign: 'right' }}>
                    Drafted ✓
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
