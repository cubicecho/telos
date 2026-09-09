/** The two inks, as a pair. */
export interface Ink {
  /** Drawn on light backdrops. */
  dark: string;
  /** Drawn on dark backdrops. */
  light: string;
}

/**
 * Near-black and pure white.
 *
 * Deliberately not the theme's `--foreground` and `--background`: the backdrop here is a colour
 * the user picked, not a surface the theme owns, so the ink must not flip when the theme does. A
 * label that reads in light mode and vanishes in dark mode is the bug this exists to stop.
 */
export const INK: Ink = { dark: '#000000', light: '#ffffff' };

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, with or without the `#`. */
const HEX = /^#?(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * The three channels of a hex colour as 0–1, or nothing.
 *
 * Alpha is parsed and dropped. Compositing it would need the colour *behind* the swatch, which is
 * the one thing a function taking a single colour cannot know.
 */
function channels(hex: string): [number, number, number] | undefined {
  if (!HEX.test(hex)) return undefined;
  const digits = hex.replace('#', '');
  // Shorthand doubles each digit — `#f80` is `#ff8800`, not `#0f0800`.
  const full =
    digits.length <= 4
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits;
  return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number];
}

/** WCAG 2.x relative luminance. The piecewise curve is the standard sRGB transfer function. */
function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast between two relative luminances, 1 through 21. */
function contrast(a: number, b: number): number {
  const [lighter, darker] = a > b ? [a, b] : [b, a];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Ink for text sitting *on* a colour the user chose.
 *
 * Legibility cannot be baked into a Tailwind variant when the backdrop is a value out of the
 * database, so it is computed per colour. Returns `undefined` for anything that is not a hex
 * colour, so the caller falls back to the inherited foreground rather than painting black onto a
 * value it failed to read.
 *
 * Ported from cubeui's `readable-text-color`, which explains the choice of algorithm: comparing
 * the two contrast ratios is the same test as comparing luminance against `0.179`, but it needs
 * no constant to be believed.
 */
export function readableTextColor(color: string | null | undefined, ink: Ink = INK): string | undefined {
  if (!color) return undefined;
  const rgb = channels(color);
  if (!rgb) return undefined;
  const backdrop = luminance(rgb);
  return contrast(backdrop, 0) >= contrast(backdrop, 1) ? ink.dark : ink.light;
}
