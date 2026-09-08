/**
 * Tailwind configuration.
 *
 * The palette is built for a bridge: a dark ground that does not destroy night
 * vision, and status colours chosen for contrast against it rather than for
 * decoration. Colour is never the only carrier of meaning in the interface -
 * every status also carries a label and an icon shape - but where colour is
 * used it has to be unambiguous at a distance on a large monitor.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Ground
        bridge: {
          950: '#05080f',
          900: '#0a0f1a',
          850: '#0e1626',
          800: '#131d31',
          750: '#18243c',
          700: '#1e2c48',
          600: '#2a3c5e',
          500: '#3b5178',
          400: '#5a739c',
          300: '#8ba1c4',
          200: '#b9c9e0',
          100: '#dde6f2'
        },
        // Status. Deliberately distinguishable for the most common forms of
        // colour vision deficiency: the greens are blue-shifted and the
        // warnings are amber rather than orange-red.
        assured: { DEFAULT: '#12b981', dark: '#0b7f5a', light: '#5eead4' },
        caution: { DEFAULT: '#f0b429', dark: '#a16207', light: '#fde68a' },
        alert: { DEFAULT: '#f2683c', dark: '#b4441f', light: '#fdba9a' },
        critical: { DEFAULT: '#ef3f5b', dark: '#a4123a', light: '#fda4b4' },
        info: { DEFAULT: '#38bdf8', dark: '#0369a1', light: '#bae6fd' },
        unknown: { DEFAULT: '#8ba1c4', dark: '#475569', light: '#cbd5e1' }
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
        panel: '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 24px -12px rgba(0,0,0,0.8)',
        'glow-critical': '0 0 0 1px rgba(239,63,91,0.5), 0 0 24px -4px rgba(239,63,91,0.45)',
        'glow-assured': '0 0 0 1px rgba(18,185,129,0.4), 0 0 20px -6px rgba(18,185,129,0.35)'
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
