export const light = {
  background: '#ffffff',
  foreground: '#0a0a0a',
  card: '#ffffff',
  cardForeground: '#0a0a0a',
  popover: '#ffffff',
  popoverForeground: '#0a0a0a',
  primary: '#171717',
  primaryForeground: '#fafafa',
  secondary: '#f5f5f5',
  secondaryForeground: '#171717',
  muted: '#f5f5f5',
  mutedForeground: '#737373',
  accent: '#f5f5f5',
  accentForeground: '#171717',
  destructive: '#e7000b',
  destructiveForeground: '#ffffff',
  border: '#e5e5e5',
  input: '#e5e5e5',
  ring: '#a1a1a1',
  sidebar: '#fafafa',
  sidebarForeground: '#0a0a0a',
  sidebarPrimary: '#171717',
  sidebarPrimaryForeground: '#fafafa',
  sidebarAccent: '#f5f5f5',
  sidebarAccentForeground: '#171717',
  sidebarBorder: '#e5e5e5',
  sidebarRing: '#a1a1a1',
} as const;

export const dark = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  card: '#171717',
  cardForeground: '#fafafa',
  popover: '#262626',
  popoverForeground: '#fafafa',
  primary: '#e5e5e5',
  primaryForeground: '#171717',
  secondary: '#262626',
  secondaryForeground: '#fafafa',
  muted: '#262626',
  mutedForeground: '#a1a1a1',
  accent: '#404040',
  accentForeground: '#fafafa',
  destructive: '#ff6467',
  destructiveForeground: '#0a0a0a',
  border: 'rgba(255, 255, 255, 0.1)',
  input: 'rgba(255, 255, 255, 0.15)',
  ring: '#737373',
  sidebar: '#171717',
  sidebarForeground: '#fafafa',
  sidebarPrimary: '#1447e6',
  sidebarPrimaryForeground: '#fafafa',
  sidebarAccent: '#262626',
  sidebarAccentForeground: '#fafafa',
  sidebarBorder: 'rgba(255, 255, 255, 0.1)',
  sidebarRing: '#737373',
} as const;

export type ColorName = keyof typeof light;
export type Palette = Record<ColorName, string>;

/**
 * Pick a palette from RN's `useColorScheme()`, which returns null before it resolves.
 *
 * Which scheme that hook reports follows the **system** appearance, because the
 * stylesheet beside this file keys its dark palette off
 * `@media (prefers-color-scheme: dark)` — the only form react-native-css honours on
 * device. An in-app theme toggle is therefore
 * `Appearance.setColorScheme("dark")` from react-native, which moves both this and
 * the stylesheet together. It is *not* a `.dark` class on a wrapper: that is the web
 * mechanism, and on native it silently styles nothing.
 */
export const paletteFor = (scheme: 'light' | 'dark' | null | undefined): Palette => (scheme === 'dark' ? dark : light);
