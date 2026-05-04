import { useState, useEffect } from 'react';
import { getDevyPool, reportDevyDiscrepancy } from '../../services/api';

const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

// Sort devy player by best available value signal
function devyValue(p) {
  return p.devyKtcValue || p.ktcValue || (p.fantasyProsValue || 0) || 0;
}

function fpEq(p) {
  return p?.fpEquivalent || 0;
}

function sheetVsKtcLabel(player) {
  const labels = [];
  if (player.sheetRank) labels.push(`Sheet #${player.sheetRank}`);
  if (player.devyKtcRank) labels.push(`KTC #${player.devyKtcRank}`);
  if (player.sheetVsKtcDelta === 0) labels.push('Aligned');
  if (player.sheetVsKtcDelta > 0) labels.push(`KTC ${player.sheetVsKtcDelta} spots lower`);
  if (player.sheetVsKtcDelta < 0) labels.push(`KTC ${Math.abs(player.sheetVsKtcDelta)} spots higher`);
  return labels.join(' · ');
}

function DevyPlayerRow({
  player,
  showOwner,
  onReportDrafted,
  reporting,
  selectable,
  selected,
  onToggleSelect,
}) {
  const val = devyValue(player);
  const posClass = `pos-${player.position}`;
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto auto auto',
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
          {selectable && (
            <input
              type="checkbox"
              checked={!!selected}
              onChange={() => onToggleSelect?.(player)}
              aria-label={`Select ${player.name}`}
            />
          )}
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
            <span style={{ color: 'var(--yellow)', marginLeft: '0.4rem' }}>
              → {player.ownerUsername}{player.ownerTeamName ? ` (${player.ownerTeamName})` : ''}
            </span>
          )}
          {!player.inOurDb && (
            <span style={{ color: 'var(--red, #ef4444)', marginLeft: '0.4rem' }}>⚠ not in DB</span>
          )}
        </div>
        {sheetVsKtcLabel(player) && (
          <div style={{ fontSize: '0.64rem', color: 'var(--yellow)', marginTop: '0.12rem' }}>
            {sheetVsKtcLabel(player)}
          </div>
        )}
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

      {!showOwner && onReportDrafted && (
        <div style={{ textAlign: 'right', marginLeft: '0.4rem' }}>
          <div style={{ display: 'flex', gap: '0.25rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              onClick={() => onReportDrafted(player)}
              disabled={!!reporting}
              style={{
                fontSize: '0.62rem',
                border: 'none',
                borderRadius: 4,
                padding: '0.18rem 0.38rem',
                cursor: reporting ? 'default' : 'pointer',
                background: reporting ? 'var(--bg-primary)' : 'rgba(239,68,68,0.12)',
                color: reporting ? 'var(--text-muted)' : '#f87171',
                fontWeight: 600,
              }}
              title="Report this player as already drafted"
            >
              {reporting ? 'Sending...' : 'Report drafted'}
            </button>
          </div>
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
  const [reportingKey, setReportingKey] = useState(null);
  const [reportingBulk, setReportingBulk] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPlayers, setSelectedPlayers] = useState({});
  const [reportStatus, setReportStatus] = useState(null);

  useEffect(() => {
    if (!leagueId) return;
    setLoading(true);
    setError(null);
    getDevyPool(leagueId)
      .then(setData)
      .catch(err => setError(err?.response?.data?.error || 'Failed to load devy pool'))
      .finally(() => setLoading(false));

    // Quietly re-fetch in the background so players drafted mid-session
    // are excluded without the user having to manually refresh.
    const interval = setInterval(() => {
      getDevyPool(leagueId)
        .then(setData)
        .catch(() => { /* silent — don't clobber a visible error */ });
    }, 45_000);
    return () => clearInterval(interval);
  }, [leagueId]);

  if (loading) return <div className="text-xs text-muted" style={{ padding: '0.5rem' }}>Loading devy pool…</div>;
  if (error) return <div className="text-xs" style={{ color: 'var(--red)', padding: '0.5rem' }}>{error}</div>;
  if (!data) return null;

  const positionOptions = ['ALL', ...(data.positionFilters || SKILL_POSITIONS)];
  const normalizePos = (value) => String(value || '').toUpperCase().trim();
  const playerMatchesPos = (player, selectedPos) => {
    if (selectedPos === 'ALL') return true;
    const pos = normalizePos(player?.position);
    if (!pos) return false;
    if (pos === selectedPos) return true;
    // Handle composite labels like WR/TE or LB/ED.
    return pos.split('/').map((p) => p.trim()).includes(selectedPos);
  };
  const filterPos = (players) =>
    posFilter === 'ALL' ? players : players.filter((p) => playerMatchesPos(p, posFilter));

  const available = filterPos(data.available || []);
  const rostered  = filterPos(data.rostered || []);
  const graduated = filterPos(data.graduated || []);
  const unknown   = filterPos(data.unknown || []);
  const availableRookies = filterPos(data.availableRookies || []);
  const comparableAvailable = available.filter((player) => SKILL_POSITIONS.includes(player.position));
  const comparableRookies = availableRookies.filter((player) => SKILL_POSITIONS.includes(player.position));
  const tabs = data.isDevyLeague ? ['available', 'rostered', 'graduated', 'compare'] : ['available', 'rostered', 'graduated'];
  const poolTitle = data.isDevyLeague && data.isIdpLeague
    ? 'Devy / IDP Pool'
    : data.isIdpLeague
      ? 'IDP Prospect Pool'
      : 'Devy Pool';

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
    ? buildComparisonRows(comparableAvailable, comparableRookies)
    : (posFilter === 'ALL' ? [] : buildComparisonRows(comparableAvailable, comparableRookies));

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

  const devyRowKey = (player, idx) => (
    player.sleeperId
      || `${player.ownerId || 'na'}-${player.associatedPlayerName || player.name}-${idx}`
  );

  const reportKeyForPlayer = (player) => (
    player.sleeperId || `${player.name}-${player.position || '?'}-${player.college || 'na'}`
  );

  const isSelected = (player) => !!selectedPlayers[reportKeyForPlayer(player)];

  function toggleSelectPlayer(player) {
    const key = reportKeyForPlayer(player);
    setSelectedPlayers((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else next[key] = player;
      return next;
    });
  }

  function clearSelection() {
    setSelectedPlayers({});
  }

  async function handleReportDrafted(player) {
    const reason = window.prompt(
      `Add a quick note for why ${player.name} should be excluded (optional):`,
      ''
    );
    const key = reportKeyForPlayer(player);
    setReportingKey(key);
    setReportStatus(null);
    try {
      const res = await reportDevyDiscrepancy(leagueId, {
        playerName: player.name,
        playerSleeperId: player.sleeperId || null,
        associatedPlayerId: player.associatedPlayerId || null,
        associatedPlayerName: player.associatedPlayerName || null,
        sourceTab: 'available',
        note: reason ? String(reason).trim() : null,
      });
      setReportStatus({
        type: 'ok',
        message: `${player.name} reported. Saved and learning updated.`,
      });

      // Refresh pool after report so any newly-caught matches disappear immediately.
      const refreshed = await getDevyPool(leagueId);
      setData(refreshed);
    } catch (err) {
      setReportStatus({
        type: 'err',
        message: err?.response?.data?.error || `Failed to report ${player.name}`,
      });
    } finally {
      setReportingKey(null);
    }
  }

  async function handleBulkReportDrafted() {
    const selected = Object.values(selectedPlayers);
    if (!selected.length) {
      setReportStatus({ type: 'err', message: 'Select at least one player first.' });
      return;
    }
    const note = window.prompt(
      `Optional note for ${selected.length} selected player(s):`,
      ''
    );
    setReportingBulk(true);
    setReportStatus(null);
    let okCount = 0;
    for (const player of selected) {
      try {
        await reportDevyDiscrepancy(leagueId, {
          playerName: player.name,
          playerSleeperId: player.sleeperId || null,
          associatedPlayerId: player.associatedPlayerId || null,
          associatedPlayerName: player.associatedPlayerName || null,
          sourceTab: 'available',
          note: note ? String(note).trim() : null,
        });
        okCount += 1;
      } catch {
        // Continue to submit the remaining selections.
      }
    }

    setReportStatus({
      type: okCount === selected.length ? 'ok' : 'err',
      message: okCount === selected.length
        ? `Reported ${okCount} drafted player${okCount !== 1 ? 's' : ''} successfully.`
        : `Reported ${okCount}/${selected.length} players. Please retry remaining ones.`,
    });

    const refreshed = await getDevyPool(leagueId);
    setData(refreshed);
    clearSelection();
    setSelectionMode(false);
    setReportingBulk(false);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <div className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
          🎓 {poolTitle}
        </div>
        <div className="text-xs text-muted">
          {data.counts.rostered} rostered · {data.counts.available} available · {data.counts.availableRookies || 0} rookie available
        </div>
      </div>

      {/* Position filter */}
      <div className="flex gap-1" style={{ marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        {positionOptions.map(pos => (
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
        {tabs.map(key => (
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
          <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.45rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`toggle-btn${selectionMode ? ' active' : ''}`}
              style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem' }}
              onClick={() => {
                setSelectionMode((s) => !s);
                if (selectionMode) clearSelection();
              }}
            >
              {selectionMode ? 'Exit select mode' : 'Select players'}
            </button>
            {selectionMode && (
              <>
                <button
                  type="button"
                  style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem', borderRadius: 5, border: 'none', cursor: reportingBulk ? 'default' : 'pointer', background: reportingBulk ? 'var(--bg-secondary)' : 'rgba(239,68,68,0.12)', color: reportingBulk ? 'var(--text-muted)' : '#f87171', fontWeight: 600 }}
                  onClick={handleBulkReportDrafted}
                  disabled={reportingBulk}
                >
                  {reportingBulk ? 'Submitting...' : `Report selected drafted (${Object.keys(selectedPlayers).length})`}
                </button>
                <button
                  type="button"
                  style={{ padding: '0.2rem 0.55rem', fontSize: '0.7rem', borderRadius: 5, border: 'none', cursor: 'pointer', background: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
                  onClick={clearSelection}
                >
                  Clear selection
                </button>
              </>
            )}
          </div>

          {reportStatus && (
            <div
              className="text-xs"
              style={{
                marginBottom: '0.4rem',
                color: reportStatus.type === 'ok' ? 'var(--green)' : 'var(--red, #ef4444)',
              }}
            >
              {reportStatus.message}
            </div>
          )}
          {available.length === 0 ? (
            <div className="text-xs text-muted" style={{ padding: '0.5rem 0' }}>
              No available prospects found.{' '}
              {data.counts.available === 0 && 'Run the devy rankings sync to seed the pool from the spreadsheet and KTC.'}
            </div>
          ) : (
            available.map((p, idx) => (
              <DevyPlayerRow
                key={devyRowKey(p, idx)}
                player={p}
                showOwner={false}
                onReportDrafted={handleReportDrafted}
                reporting={reportingKey === reportKeyForPlayer(p)}
                selectable={selectionMode}
                selected={isSelected(p)}
                onToggleSelect={toggleSelectPlayer}
              />
            ))
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
            rostered.map((p, idx) => <DevyPlayerRow key={devyRowKey(p, idx)} player={p} showOwner={true} />)
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
              {showUnknown && unknown.map((p, idx) => (
                <DevyPlayerRow key={devyRowKey(p, idx)} player={p} showOwner={true} />
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
