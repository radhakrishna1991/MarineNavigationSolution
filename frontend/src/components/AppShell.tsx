/**
 * Application shell: navigation rail, header, disclaimer and toast host.
 *
 * The demonstration disclaimer is part of the chrome rather than a dismissible
 * banner. A screenshot of any screen in this platform has to carry the fact
 * that it is not a navigational display.
 */

import { type ReactNode, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAppDispatch, useAppSelector } from '../store';
import { sidebarToggled, toastDismissed } from '../store/uiSlice';
import { signedOut } from '../store/authSlice';
import { CompactStatus } from './StatusBanner';
import { SEVERITY_PRESENTATION } from '../utils/status';
import { hasRole } from '../store/authSlice';
import type { Role } from '../types';

interface NavItem {
  to: string;
  label: string;
  glyph: string;
  minRole?: Role;
  description: string;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Navigation', glyph: '◎', description: 'Live map, trusted position and requirement status' },
  { to: '/sensors', label: 'Sensors', glyph: '▤', description: 'Per-sensor health, residuals and decisions' },
  { to: '/gnss', label: 'GNSS Integrity', glyph: '◈', description: 'Trust score, anomalies and cross-checks' },
  { to: '/fusion', label: 'Fusion & Integrity', glyph: '⬡', description: 'Filter state, covariance and protection level' },
  { to: '/alarms', label: 'Alarms', glyph: '⚠', description: 'Alarm list, acknowledgement and export' },
  { to: '/scenarios', label: 'Replay & Scenario', glyph: '▶', description: 'Scenario control, fault injection, replay' },
  { to: '/analytics', label: 'Performance', glyph: '◫', description: 'Error statistics and scenario reports' },
  { to: '/demo', label: 'Demonstration', glyph: '★', description: 'The guided Safeen demonstration script' },
  { to: '/config', label: 'Configuration', glyph: '⚙', minRole: 'engineer', description: 'Thresholds and engine tuning' },
  { to: '/admin', label: 'Administration', glyph: '⚿', minRole: 'administrator', description: 'Users and audit trail' }
];

function ConnectionPill() {
  const { connection, frameCount } = useAppSelector((s) => s.live);
  const map = {
    open: { label: 'LIVE', class: 'text-assured border-assured/50 bg-assured/15', glyph: '●' },
    connecting: { label: 'CONNECTING', class: 'text-caution border-caution/50 bg-caution/15', glyph: '◐' },
    closed: { label: 'DISCONNECTED', class: 'text-critical border-critical/50 bg-critical/15', glyph: '○' },
    error: { label: 'LINK ERROR', class: 'text-critical border-critical/50 bg-critical/15', glyph: '✕' },
    idle: { label: 'IDLE', class: 'text-bridge-400 border-bridge-600 bg-bridge-800', glyph: '○' }
  }[connection];
  return (
    <span className={`chip ${map.class}`} title={`${frameCount} frames received`}>
      <span aria-hidden>{map.glyph}</span>
      {map.label}
    </span>
  );
}

function AlarmBell() {
  const active = useAppSelector((s) => s.live.activeAlarms);
  const unacknowledged = active.filter((a) => !a.acknowledged_at);
  const highest = ['CRITICAL', 'WARNING', 'ADVISORY', 'INFO'].find((s) =>
    unacknowledged.some((a) => a.severity === s)
  ) as keyof typeof SEVERITY_PRESENTATION | undefined;
  const presentation = highest ? SEVERITY_PRESENTATION[highest] : null;

  return (
    <NavLink
      to="/alarms"
      className={`chip ${
        presentation ? `${presentation.bg} ${presentation.border} ${presentation.text}` : 'border-bridge-600 bg-bridge-800 text-bridge-300'
      } ${highest === 'CRITICAL' ? 'animate-pulse-critical' : ''}`}
      title={`${unacknowledged.length} unacknowledged of ${active.length} active`}
    >
      <span aria-hidden>{presentation?.glyph ?? '○'}</span>
      {unacknowledged.length > 0 ? `${unacknowledged.length} UNACK` : `${active.length} ACTIVE`}
    </NavLink>
  );
}

function ToastHost() {
  const toasts = useAppSelector((s) => s.ui.toasts);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (toasts.length === 0) return undefined;
    const timers = toasts.map((t) =>
      window.setTimeout(() => dispatch(toastDismissed(t.id)), t.severity === 'error' ? 9000 : 5000)
    );
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [toasts, dispatch]);

  if (toasts.length === 0) return null;

  const toneClass = {
    info: 'border-info/50 bg-info/15 text-info-light',
    success: 'border-assured/50 bg-assured/15 text-assured-light',
    warning: 'border-caution/50 bg-caution/15 text-caution-light',
    error: 'border-critical/50 bg-critical/15 text-critical-light'
  };
  const glyph = { info: 'i', success: '✓', warning: '▲', error: '✕' };

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-3 rounded-lg border px-3 py-2.5 shadow-panel backdrop-blur ${toneClass[toast.severity]}`}
        >
          <span aria-hidden className="mt-0.5">
            {glyph[toast.severity]}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{toast.title}</p>
            {toast.detail && <p className="mt-0.5 break-words text-xs opacity-90">{toast.detail}</p>}
          </div>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 text-current opacity-60 hover:opacity-100"
            onClick={() => dispatch(toastDismissed(toast.id))}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const dispatch = useAppDispatch();
  const { sidebarCollapsed, reducedMotion } = useAppSelector((s) => s.ui);
  const user = useAppSelector((s) => s.auth.user);
  const navigation = useAppSelector((s) => s.live.navigation);
  const location = useLocation();

  const visibleItems = NAV_ITEMS.filter((item) => !item.minRole || hasRole(user?.role, item.minRole));
  const activeItem = visibleItems.find((i) => (i.to === '/' ? location.pathname === '/' : location.pathname.startsWith(i.to)));

  return (
    <div className={`flex h-full min-h-0 flex-col bg-bridge-950 ${reducedMotion ? 'reduced-motion' : ''}`}>
      {/* Header */}
      <header className="z-30 flex shrink-0 items-center gap-3 border-b border-bridge-700 bg-bridge-900 px-3 py-2">
        <button
          type="button"
          className="btn-ghost btn-sm lg:hidden"
          onClick={() => dispatch(sidebarToggled())}
          aria-label={sidebarCollapsed ? 'Open navigation' : 'Close navigation'}
        >
          ☰
        </button>

        <div className="flex min-w-0 items-center gap-2.5">
          <div
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-bridge-600 bg-bridge-850 text-assured"
          >
            ⬆
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight text-bridge-100">
              iSpatialTec <span className="text-bridge-400">Assured Marine Navigation</span>
            </p>
            <p className="truncate text-[10px] uppercase tracking-[0.14em] text-caution">
              Proof of concept · decision support only · not for navigation
            </p>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="hidden xl:block">
            <CompactStatus navigation={navigation} />
          </div>
          <ConnectionPill />
          <AlarmBell />
          <div className="hidden items-center gap-2 border-l border-bridge-700 pl-2 sm:flex">
            <div className="text-right">
              <p className="text-xs font-medium leading-tight text-bridge-200">{user?.full_name ?? user?.username}</p>
              <p className="text-[10px] uppercase tracking-wider text-bridge-400">{user?.role}</p>
            </div>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => dispatch(signedOut())}
              title="Sign out"
              aria-label="Sign out"
            >
              ⏻
            </button>
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Navigation rail */}
        <nav
          aria-label="Main"
          className={`${
            sidebarCollapsed ? 'hidden' : 'flex'
          } absolute inset-y-0 left-0 z-20 w-64 shrink-0 flex-col border-r border-bridge-700 bg-bridge-900 pt-14 lg:static lg:flex lg:w-56 lg:pt-0 xl:w-64`}
        >
          <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
            {visibleItems.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.to === '/'}
                  title={item.description}
                  onClick={() => {
                    if (window.innerWidth < 1024 && !sidebarCollapsed) dispatch(sidebarToggled());
                  }}
                  className={({ isActive }) =>
                    `flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-info/15 font-medium text-info'
                        : 'text-bridge-300 hover:bg-bridge-800 hover:text-bridge-100'
                    }`
                  }
                >
                  <span aria-hidden className="w-4 text-center text-base">
                    {item.glyph}
                  </span>
                  <span className="truncate">{item.label}</span>
                </NavLink>
              </li>
            ))}
          </ul>

          <div className="border-t border-bridge-700 p-3">
            <p className="text-[10px] leading-relaxed text-bridge-500">
              Demonstration geospatial data — not for navigation. This platform has no control interface to
              autopilot, DP, propulsion or steering gear.
            </p>
          </div>
        </nav>

        {/* Content */}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[120rem] p-3 sm:p-4">
            {activeItem && (
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2 lg:hidden">
                <h1 className="text-lg font-semibold text-bridge-100">{activeItem.label}</h1>
                <p className="text-xs text-bridge-400">{activeItem.description}</p>
              </div>
            )}
            {children}
          </div>
        </main>
      </div>

      <ToastHost />
    </div>
  );
}
