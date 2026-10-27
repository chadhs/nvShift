import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePreferences, resolveTheme } from '../src/appearance.js';

test('nvShift appearance defaults match MarkupPreview', () => {
  assert.deepEqual(normalizePreferences(), { mode: 'system', light: 'light', dark: 'dark', sansSerifHeadings: false, contentWidth: 'reading' });
});

test('light and dark theme choices remain independent in each appearance mode', () => {
  for (const light of ['light', 'solarized-light']) {
    for (const dark of ['dark', 'solarized-dark']) {
      const preferences = { mode: 'system', light, dark };
      assert.deepEqual(resolveTheme(preferences, false), { theme: light, colorScheme: 'light' });
      assert.deepEqual(resolveTheme(preferences, true), { theme: dark, colorScheme: 'dark' });
      assert.deepEqual(resolveTheme({ ...preferences, mode: 'light' }, true), { theme: light, colorScheme: 'light' });
      assert.deepEqual(resolveTheme({ ...preferences, mode: 'dark' }, false), { theme: dark, colorScheme: 'dark' });
    }
  }
});

test('invalid appearance options fall back without losing independent valid preferences', () => {
  assert.deepEqual(normalizePreferences({ mode: 'invalid', light: 'solarized-dark', dark: 'solarized-dark', sansSerifHeadings: 'false', contentWidth: 'full' }), { mode: 'system', light: 'light', dark: 'solarized-dark', sansSerifHeadings: false, contentWidth: 'full' });
  assert.equal(normalizePreferences({ sansSerifHeadings: true }).sansSerifHeadings, true);
});
