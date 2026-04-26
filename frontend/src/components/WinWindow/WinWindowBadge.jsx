import { winWindowColor } from '../../utils/formatting';

export default function WinWindowBadge({ label, reason }) {
  if (!label) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
      <span className={`text-sm font-semibold ${winWindowColor(label)}`}>{label}</span>
      {reason && <span className="text-xs text-muted">{reason}</span>}
    </div>
  );
}
