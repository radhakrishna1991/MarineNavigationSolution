/**
 * Shared interface primitives.
 *
 * These exist so that loading, empty and error states are consistent
 * everywhere: a screen that forgets to handle "no data yet" is a screen that
 * shows a blank panel and leaves the operator guessing.
 */

import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { StatusPresentation } from '../utils/status';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = '',
  bodyClassName = 'panel-body',
  tone
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  tone?: 'critical' | 'caution' | 'assured';
}) {
  const toneClass =
    tone === 'critical'
      ? 'border-critical/50 shadow-glow-critical'
      : tone === 'caution'
        ? 'border-caution/50'
        : tone === 'assured'
          ? 'border-assured/40'
          : '';
  return (
    <section className={`panel ${toneClass} ${className}`}>
      {(title || actions) && (
        <header className="panel-header">
          <div className="min-w-0">
            {title && <h2 className="panel-title truncate">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-bridge-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function LoadingState({ label = 'Loading', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="skeleton h-3 w-3 rounded-full" />
          <div className="skeleton h-3 flex-1" style={{ maxWidth: `${90 - i * 15}%` }} />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
  icon = '◇'
}: {
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full border border-bridge-700 bg-bridge-850 text-xl text-bridge-500"
      >
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium text-bridge-200">{title}</p>
        {detail && <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-bridge-400">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  detail,
  onRetry
}: {
  title?: string;
  detail?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full border border-critical/50 bg-critical/15 text-xl text-critical"
      >
        ✕
      </div>
      <div>
        <p className="text-sm font-medium text-critical-light">{title}</p>
        {detail && <p className="mx-auto mt-1.5 max-w-md break-words text-xs leading-relaxed text-bridge-300">{detail}</p>}
      </div>
      {onRetry && (
        <button type="button" className="btn-secondary btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function SuccessState({ title, detail, action }: { title: string; detail?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-8 text-center">
      <div
        aria-hidden
        className="flex h-12 w-12 items-center justify-center rounded-full border border-assured/50 bg-assured/15 text-xl text-assured"
      >
        ✓
      </div>
      <div>
        <p className="text-sm font-medium text-assured-light">{title}</p>
        {detail && <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-bridge-300">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

/**
 * One wrapper that covers the whole query lifecycle, so no screen can
 * accidentally render an undefined result as a blank panel.
 */
export function QueryBoundary<T>({
  isLoading,
  isError,
  error,
  data,
  isEmpty,
  emptyTitle = 'No data',
  emptyDetail,
  onRetry,
  loadingRows,
  children
}: {
  isLoading: boolean;
  isError?: boolean;
  error?: unknown;
  data: T | undefined;
  isEmpty?: (data: T) => boolean;
  emptyTitle?: string;
  emptyDetail?: ReactNode;
  onRetry?: () => void;
  loadingRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (isLoading) return <LoadingState rows={loadingRows} />;
  if (isError) {
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : undefined;
    return <ErrorState detail={message} onRetry={onRetry} />;
  }
  if (data === undefined) return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  if (isEmpty?.(data)) return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  return <>{children(data)}</>;
}

// ---------------------------------------------------------------------------
// Status display
// ---------------------------------------------------------------------------

/**
 * A status chip. Always renders glyph + label, never colour alone - the
 * specification requires that colour is not the only indicator.
 */
export function StatusChip({
  presentation,
  size = 'md',
  showGlyph = true,
  label,
  title
}: {
  presentation: StatusPresentation;
  size?: 'sm' | 'md' | 'lg';
  showGlyph?: boolean;
  label?: string;
  title?: string;
}) {
  const sizeClass = size === 'lg' ? 'px-3 py-1 text-xs' : size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-2xs';
  return (
    <span
      className={`chip ${presentation.bg} ${presentation.border} ${presentation.text} ${sizeClass}`}
      title={title ?? presentation.meaning}
    >
      {showGlyph && <span aria-hidden>{presentation.glyph}</span>}
      <span>{label ?? presentation.short}</span>
    </span>
  );
}

/** A labelled numeric readout. */
export function Readout({
  label,
  value,
  unit,
  tone,
  hint,
  size = 'md',
  className = ''
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  tone?: 'assured' | 'caution' | 'critical' | 'info' | 'neutral';
  hint?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const toneClass =
    tone === 'assured'
      ? 'text-assured'
      : tone === 'caution'
        ? 'text-caution'
        : tone === 'critical'
          ? 'text-critical'
          : tone === 'info'
            ? 'text-info'
            : 'text-bridge-100';
  const sizeClass = size === 'lg' ? 'text-readout' : size === 'sm' ? 'text-lg' : 'text-2xl';
  return (
    <div className={className} title={hint}>
      <p className="readout-label">{label}</p>
      <p className={`mt-1 font-mono font-semibold tabular-nums ${sizeClass} ${toneClass}`}>
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-bridge-400">{unit}</span>}
      </p>
      {hint && <p className="mt-1 text-2xs leading-tight text-bridge-500">{hint}</p>}
    </div>
  );
}

/** Key/value row for dense detail panels. */
export function KeyValue({
  label,
  value,
  tone,
  title
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: 'assured' | 'caution' | 'critical' | 'neutral';
  title?: string;
}) {
  const toneClass =
    tone === 'assured'
      ? 'text-assured'
      : tone === 'caution'
        ? 'text-caution'
        : tone === 'critical'
          ? 'text-critical'
          : 'text-bridge-100';
  return (
    <div className="kv-row" title={title}>
      <span className="kv-key">{label}</span>
      <span className={`kv-value ${toneClass}`}>{value}</span>
    </div>
  );
}

/** A horizontal meter with an optional limit marker. */
export function Meter({
  value,
  max,
  limit,
  tone = 'info',
  label,
  formatValue
}: {
  value: number | null;
  max: number;
  limit?: number;
  tone?: 'assured' | 'caution' | 'critical' | 'info';
  label?: string;
  formatValue?: (v: number) => string;
}) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const limitPct = limit === undefined ? null : Math.max(0, Math.min(100, (limit / max) * 100));
  const barClass =
    tone === 'assured' ? 'bg-assured' : tone === 'caution' ? 'bg-caution' : tone === 'critical' ? 'bg-critical' : 'bg-info';
  return (
    <div>
      {label && (
        <div className="mb-1 flex items-baseline justify-between">
          <span className="readout-label">{label}</span>
          <span className="font-mono text-xs tabular-nums text-bridge-200">
            {value === null ? '—' : (formatValue?.(value) ?? value.toFixed(2))}
          </span>
        </div>
      )}
      <div
        className="relative h-2 overflow-hidden rounded-full bg-bridge-800"
        role="meter"
        aria-valuenow={value ?? undefined}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label}
      >
        <div className={`h-full rounded-full transition-[width] duration-300 ${barClass}`} style={{ width: `${pct}%` }} />
        {limitPct !== null && (
          <div
            className="absolute top-0 h-full w-0.5 bg-bridge-200"
            style={{ left: `${limitPct}%` }}
            title={`Limit ${limit}`}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`flex cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 ${
        disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-bridge-800/60'
      }`}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={`mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-info bg-info/40' : 'border-bridge-600 bg-bridge-800'
        }`}
      >
        <span
          className={`block h-3.5 w-3.5 rounded-full bg-bridge-100 transition-transform ${
            checked ? 'translate-x-[1.15rem]' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm text-bridge-200">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-bridge-400">{description}</span>}
      </span>
    </label>
  );
}

export function Field({
  label,
  error,
  hint,
  required,
  children
}: {
  label: string;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="field-label">
        {label}
        {required && <span className="ml-1 text-critical">*</span>}
      </label>
      {children}
      {error && (
        <p className="field-error" role="alert">
          <span aria-hidden>✕</span>
          <span>{error}</span>
        </p>
      )}
      {!error && hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

export function Select({
  value,
  onChange,
  options,
  className = '',
  ariaLabel,
  disabled
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  className?: string;
  ariaLabel?: string;
  disabled?: boolean;
}) {
  return (
    <select
      className={`field-input ${className}`}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  className = ''
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={`relative ${className}`}>
      <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-bridge-500">
        ⌕
      </span>
      <input
        type="search"
        className="field-input pl-8"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md'
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog so keyboard users are not left behind it.
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' }[size];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-bridge-950/80 p-4 backdrop-blur-sm sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} tabIndex={-1} className={`panel w-full ${width} my-auto focus:outline-none`}>
        <header className="panel-header">
          <h2 className="text-sm font-semibold text-bridge-100">{title}</h2>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-bridge-700 px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** A confirmation dialog for actions that change the running system. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  destructive,
  onConfirm,
  onCancel,
  busy
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? 'btn-danger btn-sm' : 'btn-primary btn-sm'}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-bridge-200">{message}</div>
    </Modal>
  );
}

/** Small tab strip used inside panels. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange
}: {
  tabs: Array<{ id: T; label: string; badge?: number }>;
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1 border-b border-bridge-700">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          type="button"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
            value === tab.id
              ? 'border-info text-info'
              : 'border-transparent text-bridge-400 hover:border-bridge-600 hover:text-bridge-200'
          }`}
        >
          {tab.label}
          {tab.badge !== undefined && tab.badge > 0 && (
            <span className="rounded-full bg-bridge-700 px-1.5 text-[10px] tabular-nums text-bridge-200">{tab.badge}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/** Sortable table header cell. */
export function SortHeader<T extends string>({
  column,
  label,
  sort,
  onSort,
  align = 'left',
  className = ''
}: {
  column: T;
  label: ReactNode;
  sort: { column: T; direction: 'asc' | 'desc' };
  onSort: (column: T) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}) {
  const active = sort.column === column;
  return (
    <th
      scope="col"
      className={`${className} ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'}`}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={`inline-flex items-center gap-1 hover:text-bridge-100 ${active ? 'text-info' : ''}`}
        onClick={() => onSort(column)}
      >
        {label}
        <span aria-hidden className={active ? 'opacity-100' : 'opacity-25'}>
          {active && sort.direction === 'desc' ? '▾' : '▴'}
        </span>
      </button>
    </th>
  );
}

/** Generic client-side sorting hook for tables. */
export function useSort<T, C extends string>(
  rows: T[],
  initial: C,
  accessor: (row: T, column: C) => string | number | null | undefined,
  initialDirection: 'asc' | 'desc' = 'asc'
) {
  const [sort, setSort] = useState<{ column: C; direction: 'asc' | 'desc' }>({
    column: initial,
    direction: initialDirection
  });

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = accessor(a, sort.column);
      const bv = accessor(b, sort.column);
      // Missing values sort last regardless of direction: an unknown is not a
      // small number, and letting it sort as one hides gaps in the data.
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      return sort.direction === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort, accessor]);

  const onSort = (column: C) =>
    setSort((prev) => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc'
    }));

  return { sorted, sort, onSort };
}

/** A copy-to-clipboard button with feedback. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost btn-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
}

/** Inline explanatory note. Used to state limitations next to the thing they limit. */
export function Note({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'caution' | 'info' }) {
  const toneClass =
    tone === 'caution'
      ? 'border-caution/40 bg-caution/10 text-caution-light'
      : tone === 'info'
        ? 'border-info/40 bg-info/10 text-info-light'
        : 'border-bridge-700 bg-bridge-850 text-bridge-300';
  return <p className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${toneClass}`}>{children}</p>;
}
