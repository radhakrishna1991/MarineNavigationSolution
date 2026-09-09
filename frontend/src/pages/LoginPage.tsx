/**
 * Sign-in screen.
 *
 * One centred card and nothing else. This screen has exactly one job, and the
 * capability summary it used to carry alongside the form was read by nobody
 * signing in and got in the way of everybody who was. What the platform does is
 * explained by the platform.
 */

import { useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { useLoginMutation, errorMessage } from '../api/api';
import { expiryAcknowledged, loggedIn } from '../store/authSlice';
import { Field } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';

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
      <div className="w-full max-w-sm">
        {/* Identity, reduced to a mark and a name. */}
        <div className="mb-6 flex flex-col items-center text-center">
          <div
            aria-hidden
            className="flex h-12 w-12 items-center justify-center rounded-xl border border-bridge-700 bg-bridge-900 text-xl text-assured shadow-panel"
          >
            ⬆
          </div>
          <p className="mt-3 text-base font-semibold leading-tight text-bridge-100">iSpatialTec</p>
          <p className="mt-0.5 text-xs text-bridge-400">Assured Marine Navigation</p>
        </div>

        <div className="panel p-6">
          <h1 className="text-base font-semibold text-bridge-100">Sign in</h1>
          <p className="mt-1 text-xs text-bridge-400">
            Every attempt, successful or not, is recorded in the audit log.
          </p>

          <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
            {formError && (
              <div role="alert" className="rounded-md border border-critical/50 bg-critical/10 px-3 py-2.5">
                <p className="flex items-start gap-2 text-sm text-critical">
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

          {/* Kept because it is a control, not a caption: each fills the
              username field, which is the fastest way into a demonstration. */}
          <div className="mt-5 border-t border-bridge-700 pt-4">
            <p className="text-2xs font-semibold uppercase tracking-[0.12em] text-bridge-400">
              Demonstration accounts
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {['admin', 'engineer', 'operator', 'viewer'].map((name) => (
                <button
                  key={name}
                  type="button"
                  className="rounded-md border border-bridge-600 bg-bridge-850 px-2.5 py-1 font-mono text-2xs text-bridge-300 transition-colors hover:border-info hover:text-info"
                  onClick={() => setUsername(name)}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-5 flex justify-center">
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
