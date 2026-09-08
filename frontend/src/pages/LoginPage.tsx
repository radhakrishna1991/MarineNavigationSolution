/**
 * Sign-in screen.
 *
 * Carries the platform's classification prominently: anyone who reaches this
 * screen should understand what the system is before they log into it.
 */

import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { useLoginMutation, errorMessage } from '../api/api';
import { expiryAcknowledged, loggedIn } from '../store/authSlice';
import { Field } from '../components/ui';

export function LoginPage() {
  const dispatch = useAppDispatch();
  const sessionExpired = useAppSelector((s) => s.auth.sessionExpired);
  const [login, { isLoading }] = useLoginMutation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({});

  useEffect(() => {
    if (sessionExpired) {
      setFormError('Your session expired. Sign in again.');
      dispatch(expiryAcknowledged());
    }
  }, [sessionExpired, dispatch]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const errors: typeof fieldErrors = {};
    if (!username.trim()) errors.username = 'Enter your username.';
    if (!password) errors.password = 'Enter your password.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setFormError(null);
    try {
      const result = await login({ username: username.trim(), password }).unwrap();
      dispatch(loggedIn({ token: result.token, user: result.user }));
    } catch (err) {
      setFormError(errorMessage(err));
      setPassword('');
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bridge-950 px-4 py-10">
      <div className="w-full max-w-5xl">
        <div className="grid overflow-hidden rounded-xl border border-bridge-700 shadow-panel lg:grid-cols-2">
          {/* Identity */}
          <div className="flex flex-col justify-between bg-bridge-900 p-8">
            <div>
              <div className="flex items-center gap-3">
                <div
                  aria-hidden
                  className="flex h-11 w-11 items-center justify-center rounded-lg border border-bridge-600 bg-bridge-850 text-xl text-assured"
                >
                  ⬆
                </div>
                <div>
                  <p className="text-lg font-semibold leading-tight text-bridge-100">iSpatialTec</p>
                  <p className="text-sm leading-tight text-bridge-400">Assured Marine Navigation Platform</p>
                </div>
              </div>

              <p className="mt-6 text-sm leading-relaxed text-bridge-300">
                Resilient vessel positioning and integrity monitoring for when GNSS is unavailable, jammed, spoofed,
                degraded or simply inconsistent.
              </p>

              <ul className="mt-6 space-y-2.5">
                {[
                  'Treats GNSS as one potentially untrusted sensor',
                  'Detects spoofing and interference from cross-checks, not from trust',
                  'Continues on radar, LiDAR, bathymetric matching, DVL and gyro',
                  'Quantifies the uncertainty and bounds it with a protection level',
                  'States plainly when the 2 m requirement can no longer be assured'
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-xs leading-relaxed text-bridge-300">
                    <span aria-hidden className="mt-0.5 text-assured">
                      ✓
                    </span>
                    {line}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-8 rounded-lg border border-caution/40 bg-caution/10 p-3">
              <p className="text-2xs font-bold uppercase tracking-[0.14em] text-caution">
                Proof of concept · decision support only
              </p>
              <p className="mt-1.5 text-xs leading-relaxed text-bridge-300">
                This is a demonstration system, not a certified navigation product. Geospatial data is synthetic and is
                not an official chart. The platform has no control interface to autopilot, dynamic positioning,
                propulsion or steering gear.
              </p>
            </div>
          </div>

          {/* Form */}
          <div className="bg-bridge-850 p-8">
            <h1 className="text-lg font-semibold text-bridge-100">Sign in</h1>
            <p className="mt-1 text-xs text-bridge-400">
              Access is role-based. Every sign-in, successful or not, is recorded in the audit log.
            </p>

            <form className="mt-6 space-y-4" onSubmit={submit} noValidate>
              {formError && (
                <div role="alert" className="rounded-md border border-critical/50 bg-critical/10 px-3 py-2.5">
                  <p className="flex items-start gap-2 text-sm text-critical-light">
                    <span aria-hidden>✕</span>
                    <span>{formError}</span>
                  </p>
                </div>
              )}

              <Field label="Username" error={fieldErrors.username} required>
                <input
                  className="field-input"
                  value={username}
                  autoComplete="username"
                  autoFocus
                  onChange={(e) => setUsername(e.target.value)}
                  aria-invalid={Boolean(fieldErrors.username)}
                />
              </Field>

              <Field label="Password" error={fieldErrors.password} required>
                <input
                  className="field-input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={Boolean(fieldErrors.password)}
                />
              </Field>

              <button type="submit" className="btn-primary w-full" disabled={isLoading}>
                {isLoading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div className="mt-6 rounded-md border border-bridge-700 bg-bridge-900 p-3">
              <p className="text-2xs font-semibold uppercase tracking-wider text-bridge-300">Demonstration accounts</p>
              <p className="mt-1 text-2xs leading-relaxed text-bridge-500">
                Seeded by <code className="text-bridge-400">npm run db:seed</code>. Passwords come from the
                environment (<code className="text-bridge-400">SEED_ADMIN_PASSWORD</code> and{' '}
                <code className="text-bridge-400">SEED_DEMO_PASSWORD</code>) and are never stored in source.
              </p>
              <ul className="mt-2 space-y-1">
                {[
                  ['admin', 'administrator', 'everything, including user management'],
                  ['engineer', 'engineer', 'configuration, fault injection, ingestion'],
                  ['operator', 'operator', 'scenario control and alarm acknowledgement'],
                  ['viewer', 'viewer', 'read-only']
                ].map(([name, role, scope]) => (
                  <li key={name} className="flex items-baseline gap-2 text-2xs">
                    <button
                      type="button"
                      className="font-mono text-info hover:underline"
                      onClick={() => setUsername(name)}
                    >
                      {name}
                    </button>
                    <span className="text-bridge-500">{role}</span>
                    <span className="text-bridge-600">— {scope}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <p className="mt-4 text-center text-2xs text-bridge-600">
          Demonstration geospatial data — not for navigation.
        </p>
      </div>
    </div>
  );
}

export default LoginPage;
