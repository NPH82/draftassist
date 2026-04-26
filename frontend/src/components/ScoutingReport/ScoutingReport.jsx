import { useState } from 'react';
import { getScoutingReport } from '../../services/api';

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
              <div className="font-semibold" style={{ marginBottom: '0.4rem' }}>{report.username || managerId}</div>
              <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {(report.scoutingNotes || []).map((note, i) => (
                  <li key={i} style={{ display: 'flex', gap: '0.4rem' }}>
                    <span style={{ color: 'var(--yellow)' }}>!</span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
              <div style={{ marginTop: '0.5rem', color: 'var(--text-muted)' }}>
                Based on {report.totalPicksObserved || 0} observed picks
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
