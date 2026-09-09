import { describe, expect, it } from 'vitest';
import { INK, readableTextColor } from '../readable-text-color';

/** The palette `LabelFormDialog` offers. Every colour a label can have goes through this. */
const PALETTE = ['#0f766e', '#0369a1', '#4f46e5', '#7c3aed', '#be185d', '#b91c1c', '#c2410c', '#4d7c0f'];

/** WCAG 2.x contrast, written out again so the test does not trust the module's own maths. */
function contrast(hex: string, ink: string): number {
  const luminance = (color: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((at) => Number.parseInt(color.slice(at, at + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(hex), luminance(ink)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('readableTextColor', () => {
  it('picks the ink with more contrast, for every colour in the palette', () => {
    for (const color of PALETTE) {
      const chosen = readableTextColor(color) as string;
      const other = chosen === INK.dark ? INK.light : INK.dark;
      expect(contrast(color, chosen)).toBeGreaterThanOrEqual(contrast(color, other));
    }
  });

  it('clears AA on every colour in the palette', () => {
    for (const color of PALETTE) {
      expect(contrast(color, readableTextColor(color) as string)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('picks black on a light colour and white on a dark one', () => {
    expect(readableTextColor('#ffffff')).toBe(INK.dark);
    expect(readableTextColor('#000000')).toBe(INK.light);
    // Amber is the case that motivates the whole function: hardcoded white is 2.2:1 on it.
    expect(readableTextColor('#f59e0b')).toBe(INK.dark);
  });

  it('doubles the digits of a shorthand colour rather than slicing the string', () => {
    expect(readableTextColor('#f80')).toBe(readableTextColor('#ff8800'));
    expect(readableTextColor('fff')).toBe(INK.dark);
  });

  it('returns nothing for a colour it cannot read, so the caller keeps the inherited ink', () => {
    expect(readableTextColor(null)).toBeUndefined();
    expect(readableTextColor('')).toBeUndefined();
    expect(readableTextColor('rebeccapurple')).toBeUndefined();
    expect(readableTextColor('rgb(0 0 0)')).toBeUndefined();
  });

  it('ignores alpha rather than compositing it against a guess', () => {
    expect(readableTextColor('#000000ff')).toBe(readableTextColor('#000000'));
    expect(readableTextColor('#00000000')).toBe(readableTextColor('#000000'));
  });
});
