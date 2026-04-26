import { useDraft } from '../../context/DraftContext';

export default function AlertContainer() {
  const { alerts, dismissAlert } = useDraft();

  if (alerts.length === 0) return null;

  return (
    <div className="toast-container">
      {alerts.map(alert => (
        <AlertToast key={alert.id} alert={alert} onDismiss={() => dismissAlert(alert.id)} />
      ))}
    </div>
  );
}

function AlertToast({ alert, onDismiss }) {
  const typeClass = alert.type === 'faller' ? 'toast-alert' : alert.type === 'sell' ? 'toast-sell' : 'toast-buy';
  const icon = alert.type === 'faller' ? '!' : alert.type === 'sell' ? '$' : '+';
  const label = alert.type === 'faller'
    ? `${alert.player?.name} falling! (${alert.fallAmount} picks past projected)`
    : alert.message;

  return (
    <div className={`toast ${typeClass}`}>
      <div className="flex justify-between items-center">
        <div className="flex gap-2 items-center">
          <span style={{ fontSize: '1rem' }}>{icon}</span>
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <button className="btn btn-ghost text-xs" onClick={onDismiss} aria-label="Dismiss">
          x
        </button>
      </div>
    </div>
  );
}
