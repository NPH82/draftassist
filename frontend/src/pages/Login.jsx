import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../context/AppContext';

export default function Login() {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const { login } = useApp();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    const clean = username.trim().toLowerCase();
    if (!clean) return;

    setLoading(true);
    setError(null);
    try {
      await login(clean);
      navigate('/dashboard');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Check your Sleeper username.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-primary)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem',
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 380 }}>
        {/* Logo / branding */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ fontSize: '2.5rem', fontWeight: 900, color: 'var(--accent)', letterSpacing: '-1px' }}>
            DraftAssist
          </div>
          <div className="text-secondary text-sm" style={{ marginTop: '0.25rem' }}>
            Dynasty Rookie Draft Assistant
          </div>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label htmlFor="username" className="text-sm font-semibold" style={{ display: 'block', marginBottom: '0.4rem' }}>
              Sleeper Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="your_sleeper_name"
              autoCapitalize="none"
              autoComplete="username"
              spellCheck={false}
              className="w-full"
              disabled={loading}
            />
            <div className="text-xs text-muted" style={{ marginTop: '0.3rem' }}>
              No password needed -- uses Sleeper's public API
            </div>
          </div>

          {error && (
            <div style={{ background: '#450a0a', border: '1px solid var(--red)', borderRadius: 6, padding: '0.6rem 0.75rem', fontSize: '0.85rem', color: '#fca5a5' }}>
              {error}
            </div>
          )}

          <button type="submit" className="btn btn-primary w-full" disabled={loading || !username.trim()}>
            {loading ? 'Connecting...' : 'Connect to Sleeper'}
          </button>
        </form>

        <div className="text-xs text-muted" style={{ marginTop: '1.5rem', textAlign: 'center', lineHeight: 1.6 }}>
          Pulls your dynasty leagues, rosters, and live draft state from Sleeper. No account required.
        </div>
      </div>
    </div>
  );
}
