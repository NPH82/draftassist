import { useState } from 'react';
import { getScoutingReport } from '../../services/api';

const POS_COLOR = { QB: 'var(--blue)', RB: 'var(--green)', WR: 'var(--yellow)', TE: 'var(--red)' };

export default function ScoutingReport({ managerId, draftId }) {
  const [report, setReport] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    if (!open && !report) {
      setLoading(true);
      const data = await getScoutingReport(draftId, managerId).catch(() => null);
      setReport(data);
      setLoading(false);
    }
    setOpen(o => !o);
  };

  return (
    <div>
      <button className="btn btn-ghost text-xs" onClick={toggle}>
        {open ? 'Hide' : 'Scout'} Report
      </button>

      {open && (
        <div className="card" style={{ marginTop: '0.5rem', fontSize: '0.82rem' }}>
          {loading && <div className="text-secondary">Loading...</div>}
          {report?.noData && <div className="text-muted">{report.message}</div>}
          {report && !report.noData && (
            <>
              {/* Header */}
              <div className="flex justify-between items-center" style={{ marginBottom: '0.5rem' }}>
                <span className="font-semibold">{report.username || managerId}</span>
                <span className="text-xs text-muted">
                  {report.draftsObserved?.length || 0} draft{(report.draftsObserved?.length || 0) !== 1 ? 's' : ''} · {report.totalPicksObserved || 0} picks
                </span>
              </div>

              {/* Scouting notes */}
              {report.scoutingNotes?.length > 0 && (
                <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.5rem' }}>
                  {report.scoutingNotes.map((note, i) => (
                    <li key={i} style={{ display: 'flex', gap: '0.4rem' }}>
                      <span style={{ color: 'var(--yellow)' }}>!</span>
                      <span>{note}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Colleges + NFL Teams */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.5rem' }}>
                {report.topColleges?.length > 0 && (
                  <div className="text-xs">
                    <span className="text-muted">Colleges: </span>
                    {report.topColleges.map(c => c.name).join(', ')}
                  </div>
                )}
                {report.topNflTeams?.length > 0 && (
                  <div className="text-xs">
                    <span className="text-muted">NFL Teams: </span>
                    {report.topNflTeams.map(t => t.team).join(', ')}
                  </div>
                )}
              </div>

              {/* Favorite 2026 draft class players */}
              {report.favoriteDraftClassPlayers?.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-muted" style={{ marginBottom: '0.2rem' }}>2026 Targets:</div>
                  <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                    {report.favoriteDraftClassPlayers.map((fp, i) => (
                      <span key={i} style={{
                        background: 'var(--bg-secondary)',
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        padding: '0.1rem 0.4rem',
                        fontSize: '0.75rem',
                      }}>
                        {fp.name}
                        <span style={{ color: POS_COLOR[fp.position] || 'var(--text-muted)', marginLeft: '0.2rem' }}>
                          {fp.position}
                        </span>
                        {fp.timesDrafted > 1 && (
                          <span style={{ color: 'var(--yellow)', marginLeft: '0.2rem' }}>×{fp.timesDrafted}</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
