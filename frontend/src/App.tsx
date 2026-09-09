import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from './store';
import { getLiveClient } from './ws/liveClient';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { NavigationPage } from './pages/NavigationPage';
import { SensorsPage } from './pages/SensorsPage';
import { GnssPage } from './pages/GnssPage';
import { FusionPage } from './pages/FusionPage';
import { AlarmsPage } from './pages/AlarmsPage';
import { ScenarioPage } from './pages/ScenarioPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { DemoPage } from './pages/DemoPage';
import { ConfigPage } from './pages/ConfigPage';
import { AdminPage } from './pages/AdminPage';
import { hasRole } from './store/authSlice';
import { useApplyTheme } from './theme/useTheme';
import type { Role } from './types';

/**
 * Error boundary.
 *
 * A rendering fault in one panel must not take down the whole bridge display,
 * and it must never fail silently: the operator is told the display is broken
 * rather than being left looking at a blank area they might read as "nominal".
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Interface error', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-full items-center justify-center p-8">
          <div className="panel max-w-lg p-6 text-center">
            <div
              aria-hidden
              className="mx-auto flex h-12 w-12 items-center justify-center rounded-full border border-critical/50 bg-critical/15 text-xl text-critical"
            >
              ✕
            </div>
            <h1 className="mt-4 text-lg font-semibold text-critical-light">The display has failed</h1>
            <p className="mt-2 text-sm leading-relaxed text-bridge-300">
              A fault in the user interface stopped this screen from rendering. Navigation processing on the server is
              unaffected, but this display is not showing current data.{' '}
              <strong className="text-caution">Do not rely on it until it has been reloaded.</strong>
            </p>
            <pre className="mt-3 max-h-32 overflow-auto rounded border border-bridge-700 bg-bridge-950 p-2 text-left text-[10px] text-bridge-400">
              {this.state.error.message}
            </pre>
            <button type="button" className="btn-primary mt-4" onClick={() => window.location.reload()}>
              Reload the display
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Route guard for role-restricted screens. */
function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const user = useAppSelector((s) => s.auth.user);
  if (!hasRole(user?.role, role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/** Opens and maintains the live WebSocket for the signed-in session. */
function LiveConnection() {
  const dispatch = useAppDispatch();
  const token = useAppSelector((s) => s.auth.token);

  useEffect(() => {
    if (!token) return undefined;
    const client = getLiveClient(dispatch);
    client.connect(token);
    return () => client.close();
  }, [token, dispatch]);

  return null;
}

export function App() {
  const token = useAppSelector((s) => s.auth.token);
  // Keeps `data-theme` on the document in step with the stored preference, and
  // follows the operating system while that preference is `system`. Mounted
  // above the sign-in screen so the login page is themed too.
  useApplyTheme();

  if (!token) {
    return (
      <ErrorBoundary>
        <LoginPage />
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      {/* Opt in to the v7 behaviours now so the upgrade is not a behaviour change. */}
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <LiveConnection />
        <AppShell>
          <Routes>
            <Route path="/" element={<NavigationPage />} />
            <Route path="/sensors" element={<SensorsPage />} />
            <Route path="/gnss" element={<GnssPage />} />
            <Route path="/fusion" element={<FusionPage />} />
            <Route path="/alarms" element={<AlarmsPage />} />
            <Route path="/scenarios" element={<ScenarioPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/demo" element={<DemoPage />} />
            <Route
              path="/config"
              element={
                <RequireRole role="engineer">
                  <ConfigPage />
                </RequireRole>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireRole role="administrator">
                  <AdminPage />
                </RequireRole>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AppShell>
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
