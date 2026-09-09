/**
 * Theme control: dark, light, or follow the operating system.
 *
 * A three-way segmented control rather than a two-state switch, because the
 * third state is meaningfully different - a vessel that dims its displays on a
 * schedule wants the platform to follow, and an operator who has deliberately
 * chosen dark should not have it changed underneath them at sunrise.
 *
 * Each segment carries a glyph *and* an accessible label; the current state is
 * never conveyed by highlight colour alone.
 */

import { useAppDispatch, useAppSelector } from '../store';
import { themeChanged } from '../store/uiSlice';
import { useResolvedTheme } from '../theme/useTheme';
import type { ThemePreference } from '../theme/theme';

const OPTIONS: { value: ThemePreference; glyph: string; label: string; hint: string }[] = [
  { value: 'dark', glyph: '☾', label: 'Dark', hint: 'Bridge palette. Preserves night vision.' },
  { value: 'light', glyph: '☀', label: 'Light', hint: 'Daylight palette, briefings and print.' },
  { value: 'system', glyph: '◑', label: 'Auto', hint: 'Follow the operating system setting.' }
];

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const dispatch = useAppDispatch();
  const preference = useAppSelector((s) => s.ui.theme);
  const resolved = useResolvedTheme();

  return (
    <div
      role="radiogroup"
      aria-label="Interface theme"
      className="inline-flex items-center gap-0.5 rounded-md border border-bridge-700 bg-bridge-850 p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={
              option.value === 'system'
                ? `${option.hint} Currently ${resolved}.`
                : option.hint
            }
            onClick={() => dispatch(themeChanged(option.value))}
            className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors ${
              active
                ? 'bg-bridge-700 text-bridge-100 shadow-panel'
                : 'text-bridge-400 hover:bg-bridge-800 hover:text-bridge-200'
            }`}
          >
            <span aria-hidden className="text-sm leading-none">
              {option.glyph}
            </span>
            <span className={compact ? 'sr-only' : 'hidden sm:inline'}>{option.label}</span>
            {compact && <span className="sr-only">{option.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
