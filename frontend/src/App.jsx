import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import DraftMode from './pages/DraftMode';
import TradeHub from './pages/TradeHub';

function RequireAuth({ children }) {
  const { user, loadingUser } = useApp();
  if (loadingUser) return null;
  if (!user) return <Navigate to="/" replace />;
  return children;
}

function PublicOnly({ children }) {
  const { user, loadingUser } = useApp();
  if (loadingUser) return null;
  if (user) return <Navigate to="/dashboard" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Routes>
          <Route
            path="/"
            element={
              <PublicOnly>
                <Login />
              </PublicOnly>
            }
          />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/draft/:draftId"
            element={
              <RequireAuth>
                <DraftMode />
              </RequireAuth>
            }
          />
          <Route
            path="/tradehub"
            element={
              <RequireAuth>
                <TradeHub />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}
