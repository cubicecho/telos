import { describe, expect, it } from 'vitest';
import { INK, readableTextColor } from './readable-text-color';

/** A palette of user-pickable colours — the case the function exists for. */
const ACTIVITY_COLORS = [
  '#ef4444',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
];

/**
 * WCAG 2.x luminance and contrast, written out again here so the test does not trust the module's
 * own maths. Shared by both spellings below rather than hand-rolled twice.
 */
const linear = (color: string): [number, number, number] =>
  [1, 3, 5]
    .map((at) => Number.parseInt(color.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];

function luminance(hex: string) {
  const [r, g, b] = linear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hex: string, ink: string) {
  const pair = [luminance(hex), luminance(ink)];
  return (Math.max(...pair) + 0.05) / (Math.min(...pair) + 0.05);
}

describe('readableTextColor', () => {
  it('picks the ink with more contrast, for every colour in the palette', () => {
    for (const color of ACTIVITY_COLORS) {
      const chosen = readableTextColor(color) as string;
      const other = chosen === INK.dark ? INK.light : INK.dark;
      expect(contrast(color, chosen)).toBeGreaterThanOrEqual(contrast(color, other));
    }
  });

  /**
   * The number in the survey. Hardcoded white drops to 2.2:1 on the amber swatch; picking per
   * colour never drops below AA across the palette.
   */
  it('clears AA on every colour in the palette, which hardcoded white does not', () => {
    const hardcoded = ACTIVITY_COLORS.map((c) => contrast(c, '#ffffff'));
    expect(Math.min(...hardcoded)).toBeLessThan(4.5);

    for (const color of ACTIVITY_COLORS) {
      expect(contrast(color, readableTextColor(color) as string)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('agrees with the luminance-threshold spelling of the same algorithm', () => {
    // `0.179` is `Math.sqrt(1.05 * 0.05) - 0.05` — the crossover, not an approximation of it.
    const threshold = Math.sqrt(1.05 * 0.05) - 0.05;

    for (const color of ACTIVITY_COLORS) {
      const byThreshold = luminance(color) > threshold ? INK.dark : INK.light;
      expect(readableTextColor(color)).toBe(byThreshold);
    }
  });

  it('reads shorthand hex as the colour it means', () => {
    // The bug in the fixed-offset version: `#f80` is `#ff8800`, a light amber wanting black ink,
    // not the near-black `#0f0800` that slicing byte pairs out of a four-character string yields.
    expect(readableTextColor('#f80')).toBe(readableTextColor('#ff8800'));
    expect(readableTextColor('#f80')).toBe(INK.dark);
  });

  it('takes a colour with or without the hash, and any case', () => {
    expect(readableTextColor('3B82F6')).toBe(readableTextColor('#3b82f6'));
  });

  it('ignores alpha rather than compositing against a backdrop it cannot see', () => {
    expect(readableTextColor('#ffffff00')).toBe(readableTextColor('#ffffff'));
  });

  it('returns nothing it cannot read, so the caller falls back instead of guessing', () => {
    for (const value of ['', 'rebeccapurple', 'rgb(0 0 0)', '#12345', '#gggggg', null, undefined]) {
      expect(readableTextColor(value)).toBeUndefined();
    }
  });

  it("takes a caller's own pair of inks", () => {
    // An app using a near-black rather than pure black should not be restyled by adopting this.
    expect(readableTextColor('#eab308', { dark: '#0b0b0f', light: '#ffffff' })).toBe('#0b0b0f');
  });
});
