export function timeAgo(date) {
  if (!date) return 'unknown';
  const ms = Date.now() - new Date(date).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatEta(etaMs) {
  if (!etaMs) return '--';
  const diff = etaMs - Date.now();
  if (diff <= 0) return 'Now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '<1m';
  if (mins < 60) return `~${mins}m`;
  return `~${Math.floor(mins / 60)}h`;
}

export function dasClass(score) {
  if (score >= 70) return 'das-high';
  if (score >= 45) return 'das-mid';
  return 'das-low';
}

export function winWindowColor(label) {
  if (label === 'Built To Win') return 'text-green';
  if (label === 'Sustainable Contender') return 'text-green';
  if (label === 'Aging Contender') return 'text-yellow';
  if (label === 'Contending') return 'text-accent';
  if (label === 'Re-Tooling') return 'text-yellow';
  return 'text-secondary';
}
