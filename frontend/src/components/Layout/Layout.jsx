import { useOffline } from '../../hooks/useOffline';
import { useApp } from '../../context/AppContext';
import { useNavigate, Link, useLocation } from 'react-router-dom';

export default function Layout({ children }) {
  const isOffline = useOffline();
  const { user, logout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <div className="app-layout">
      {isOffline && (
        <div className="offline-banner">
          Offline -- using cached data
        </div>
      )}
      <nav className="top-nav">
        <Link to="/dashboard" style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text-primary)' }}>
          DraftAssist
        </Link>
        <div className="flex gap-3 items-center">
          <Link
            to="/dashboard"
            className="btn btn-ghost text-sm"
            style={{ fontWeight: location.pathname === '/dashboard' ? '700' : '400' }}
          >
            Home
          </Link>
          <Link
            to="/tradehub"
            className="btn btn-ghost text-sm"
            style={{ fontWeight: location.pathname === '/tradehub' ? '700' : '400' }}
          >
            Trade Hub
          </Link>
          {user && (
            <button className="btn btn-ghost text-sm" onClick={handleLogout}>
              {user.displayName || user.username}
            </button>
          )}
        </div>
      </nav>
      <main className="page-content">
        {children}
      </main>
    </div>
  );
}
