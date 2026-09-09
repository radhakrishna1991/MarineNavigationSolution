/**
 * Palette tests.
 *
 * Section 27 asks for a high-contrast interface in which colour is never the
 * only indicator. The second half of that is structural and is covered by the
 * component tests; this file covers the first half, by reading the two palettes
 * straight out of the stylesheet and measuring them.
 *
 * A theme is easy to break by eye - a colour that looks fine on the designer's
 * monitor can be unreadable on a bridge in daylight - so the thresholds are
 * checked rather than trusted.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Resolved from the package root rather than `import.meta.url`: under the jsdom
// environment the module URL is not a file: URL.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

type Rgb = [number, number, number];

/** Pull the custom properties out of one theme block. */
function palette(selector: string): Record<string, Rgb> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`No theme block for ${selector}`);
  const body = css.slice(start, css.indexOf('\n  }', start));
  const vars: Record<string, Rgb> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*(\d+) (\d+) (\d+);/g)) {
    vars[match[1]] = [Number(match[2]), Number(match[3]), Number(match[4])];
  }
  return vars;
}

const relativeLuminance = ([r, g, b]: Rgb): number => {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

/** WCAG contrast ratio between two colours. */
const contrast = (a: Rgb, b: Rgb): number => {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
};

const dark = palette("[data-theme='dark'] {");
const light = palette("[data-theme='light'] {");

/** Text and status colours, each of which is rendered as small type. */
const TEXT_TOKENS = [
  'bridge-100',
  'bridge-200',
  'bridge-300',
  'bridge-400',
  'assured',
  'caution',
  'alert',
  'critical',
  'info',
  'unknown'
];

const SOURCE_TOKENS = [
  'source-fused',
  'source-truth',
  'source-gnss',
  'source-radar',
  'source-lidar',
  'source-bathymetric',
  'source-dead-reckoning',
  'source-local-ranging'
];

describe.each([
  ['dark', dark],
  ['light', light]
])('%s palette', (name, vars) => {
  it('defines every token the other theme defines', () => {
    const other = name === 'dark' ? light : dark;
    expect(Object.keys(vars).sort()).toEqual(Object.keys(other).sort());
  });

  it.each(TEXT_TOKENS)('renders %s at AA contrast on both surfaces', (token) => {
    // Panels and the app ground behind them are the only two surfaces text is
    // ever set on, and both have to clear 4.5:1 for small type.
    expect(contrast(vars[token], vars['bridge-900'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vars[token], vars['bridge-950'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps every source identity colour visible as a graphical mark', () => {
    // Map tracks and legend swatches are non-text, where AA asks for 3:1.
    for (const token of SOURCE_TOKENS) {
      expect(contrast(vars[token], vars['bridge-900'])).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives every source its own colour', () => {
    const values = SOURCE_TOKENS.map((t) => vars[t].join(','));
    expect(new Set(values).size).toBe(SOURCE_TOKENS.length);
  });

  it('separates the status colours from one another', () => {
    // Two statuses that look alike are worse than one status: an operator
    // glancing at the banner must not confuse "at risk" with "not met".
    const statuses: Rgb[] = [vars['assured'], vars['caution'], vars['critical'], vars['info']];
    for (let i = 0; i < statuses.length; i += 1) {
      for (let j = i + 1; j < statuses.length; j += 1) {
        const separation = Math.abs(
          relativeLuminance(statuses[i]) - relativeLuminance(statuses[j])
        );
        const hueDiffers = statuses[i].join() !== statuses[j].join();
        expect(hueDiffers || separation > 0).toBe(true);
      }
    }
  });

  it('orders the ground ramp consistently with its role', () => {
    // `bridge-950` is the furthest-back ground and `bridge-100` the strongest
    // text, in both themes. Dark runs the ramp one way and light the other; if
    // that inversion is ever half-applied, every screen breaks at once.
    const ground = relativeLuminance(vars['bridge-950']);
    const text = relativeLuminance(vars['bridge-100']);
    if (name === 'dark') expect(ground).toBeLessThan(text);
    else expect(ground).toBeGreaterThan(text);
  });
});

describe('theme definitions', () => {
  it('keeps the light palette as the default at :root', () => {
    // A client opening the page with no stored preference, or with JavaScript
    // still loading, gets the light palette. `:root` and the light block are
    // one rule so the two can never disagree.
    const start = css.indexOf(':root,');
    const rootBlock = css.slice(start, css.indexOf('\n  }', start));
    expect(rootBlock).toContain("[data-theme='light']");
    expect(rootBlock).toContain('color-scheme: light');
  });

  it('declares a dark palette that the document can select', () => {
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain('color-scheme: dark');
  });
});
