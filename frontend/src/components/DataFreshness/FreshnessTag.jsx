import { timeAgo } from '../../utils/formatting';

export default function FreshnessTag({ lastUpdated, isLive = false }) {
  if (!lastUpdated && !isLive) return null;
  const stale = lastUpdated && Date.now() - new Date(lastUpdated).getTime() > 6 * 60 * 60 * 1000; // >6h

  return (
    <span className={`freshness-tag ${stale ? 'freshness-stale' : ''}`}>
      {isLive ? (
        <>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', display: 'inline-block' }} />
          Live
        </>
      ) : (
        `Updated ${timeAgo(lastUpdated)}`
      )}
    </span>
  );
}
