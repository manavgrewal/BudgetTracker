/**
 * Theme preference: three states, not two.
 *
 * 'system' is the default and the reason the whole mechanism exists — the app
 * follows the device until someone says otherwise, and "otherwise" has to be
 * able to win, which is why the dark styles hang off a class on <html> rather
 * than a bare prefers-color-scheme media query.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'bt-theme';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system'];

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

/** Reads the stored choice; anything unrecognised (or unreadable) means "follow the device". */
export function readStoredTheme(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function prefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(preference: ThemePreference): 'light' | 'dark' {
  if (preference === 'system') return prefersDark() ? 'dark' : 'light';
  return preference;
}

/** Paints the choice: the `dark` class drives the tokens, color-scheme drives native widgets. */
export function applyTheme(preference: ThemePreference): void {
  const dark = resolveTheme(preference) === 'dark';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
}

export function storeTheme(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Private-mode / storage-disabled browsers still get a working toggle for
    // the current page; only the persistence is lost.
  }
}
