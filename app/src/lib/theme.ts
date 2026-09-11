import { Platform } from 'react-native';

/**
 * Which palette to paint. Stored per device rather than on the account: it
 * describes the screen you are looking at, not who you are, and the same person
 * may well want dark on a laptop at night and light on a desk monitor.
 *
 * Tailwind is configured `darkMode: ['class']`, so applying a theme means
 * putting `.dark` on <html> and letting the CSS variables in global.css do the
 * rest. `app/public/index.html` runs the same rule in a blocking script before
 * first paint, so a dark-theme user never sees a white flash on load; the key
 * below is duplicated there and the two must agree.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_KEY = 'telos_theme';

function isPreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function getThemePreference(): ThemePreference {
  if (Platform.OS !== 'web') return 'system';
  const stored = window.localStorage.getItem(THEME_KEY);
  return isPreference(stored) ? stored : 'system';
}

/** What `system` currently means, or the preference itself when it is explicit. */
export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  if (Platform.OS !== 'web') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function paint(preference: ThemePreference): void {
  if (Platform.OS !== 'web') return;
  document.documentElement.classList.toggle('dark', resolveTheme(preference) === 'dark');
}

export function setThemePreference(preference: ThemePreference): void {
  if (Platform.OS !== 'web') return;
  window.localStorage.setItem(THEME_KEY, preference);
  paint(preference);
}

/**
 * Apply the stored preference and keep it honest. Returns an unsubscribe, so
 * the caller is an effect: while the preference is `system`, changing the OS
 * theme repaints the app without a reload.
 */
export function syncTheme(): () => void {
  if (Platform.OS !== 'web') return () => {};
  paint(getThemePreference());
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getThemePreference() === 'system') paint('system');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
