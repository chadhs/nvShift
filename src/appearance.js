/** Appearance options match MarkupPreview v0.12.0; settings are owned by nvShift's main process. */
export function normalizePreferences(preferences = {}) {
  return {
    mode: ['system', 'light', 'dark'].includes(preferences.mode) ? preferences.mode : 'system',
    light: ['light', 'solarized-light'].includes(preferences.light) ? preferences.light : 'light',
    dark: ['dark', 'solarized-dark'].includes(preferences.dark) ? preferences.dark : 'dark',
    sansSerifHeadings: preferences.sansSerifHeadings === true,
    contentWidth: ['reading', 'full'].includes(preferences.contentWidth) ? preferences.contentWidth : 'reading',
  };
}

export function resolveTheme(preferences, systemDark) {
  const normalized = normalizePreferences(preferences);
  const colorScheme = normalized.mode === 'system' ? (systemDark ? 'dark' : 'light') : normalized.mode;
  return { theme: normalized[colorScheme], colorScheme };
}

export function createAppearance({ windowTheme, onTheme = () => {} }) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preferences = normalizePreferences();
  let theme = '';
  function apply(next = preferences) {
    preferences = normalizePreferences(next);
    const resolved = resolveTheme(preferences, media.matches);
    document.documentElement.dataset.theme = resolved.theme;
    document.documentElement.style.colorScheme = resolved.colorScheme;
    document.documentElement.dataset.headingFont = preferences.sansSerifHeadings ? 'sans-serif' : 'default';
    document.documentElement.dataset.contentWidth = preferences.contentWidth;
    void windowTheme?.(resolved.theme).catch(() => {});
    if (theme !== resolved.theme) { theme = resolved.theme; onTheme(theme); }
    return resolved;
  }
  const listener = () => apply();
  media.addEventListener('change', listener);
  return { apply, destroy: () => media.removeEventListener('change', listener) };
}
