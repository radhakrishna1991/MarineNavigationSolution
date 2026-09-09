/**
 * Tailwind configuration.
 *
 * Every colour resolves through a CSS custom property rather than a literal, so
 * one variable block in `index.css` re-themes the whole interface. That is what
 * lets the same `bg-bridge-900` / `text-bridge-100` classes used throughout the
 * pages render correctly in both the dark bridge palette and the light one,
 * without a `dark:` variant on every element.
 *
 * The scale is named by *role*, not by lightness: `bridge-950` is always the
 * furthest-back ground and `bridge-100` is always the strongest text, whichever
 * theme is active. Dark inverts the ramp; light does not reverse the meaning.
 *
 * Status colours are chosen for contrast against their own theme's ground and
 * remain distinguishable for the most common forms of colour vision deficiency:
 * the greens are blue-shifted and the warnings amber rather than orange-red.
 * Colour is never the only carrier of meaning - every status also renders a
 * glyph and a label - but where colour is used it must be unambiguous at a
 * distance on a large monitor.
 */

/** Build a colour that honours Tailwind's opacity modifiers (`bg-x/15`). */
const token = (name) => `rgb(var(--${name}) / <alpha-value>)`;

const ramp = (prefix, steps) =>
  Object.fromEntries(steps.map((step) => [step, token(`${prefix}-${step}`)]));

const status = (name) => ({
  DEFAULT: token(name),
  light: token(`${name}-light`),
  dark: token(`${name}-dark`)
});

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bridge: ramp('bridge', [950, 900, 850, 800, 750, 700, 600, 500, 400, 300, 200, 100]),
        assured: status('assured'),
        caution: status('caution'),
        alert: status('alert'),
        critical: status('critical'),
        info: status('info'),
        unknown: status('unknown')
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Consolas', '"Liberation Mono"', 'monospace']
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
        readout: ['2.5rem', { lineHeight: '1', letterSpacing: '-0.02em' }],
        'readout-lg': ['3.5rem', { lineHeight: '1', letterSpacing: '-0.03em' }]
      },
      boxShadow: {
        // Elevation differs by theme: a dark interface separates surfaces with
        // a light inner edge, a light one with a real cast shadow.
        panel: 'var(--shadow-panel)',
        raised: 'var(--shadow-raised)',
        'glow-critical': 'var(--shadow-glow-critical)',
        'glow-assured': 'var(--shadow-glow-assured)'
      },
      animation: {
        // The only motion in the interface: a slow pulse reserved for
        // unacknowledged critical alarms. Nothing else animates.
        'pulse-critical': 'pulse-critical 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
      },
      keyframes: {
        'pulse-critical': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.55' }
        }
      },
      gridTemplateColumns: {
        dashboard: 'minmax(0, 1fr) 22rem',
        'dashboard-wide': 'minmax(0, 1fr) 26rem'
      }
    }
  },
  plugins: []
};
