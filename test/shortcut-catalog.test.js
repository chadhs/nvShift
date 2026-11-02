import test from 'node:test';
import assert from 'node:assert/strict';
import { SHORTCUTS, shortcut, formatAccelerator, resolveCommand } from '../electron/shortcut-catalog.cjs';

test('the catalog gives every app binding one stable ID and context-aware description', () => {
  assert.equal(new Set(SHORTCUTS.map(({ id }) => id)).size, SHORTCUTS.length);
  assert.ok(Object.isFrozen(SHORTCUTS));
  assert.ok(SHORTCUTS.every(Object.isFrozen));
  assert.equal(shortcut('toggle-layout').accelerator, 'CmdOrCtrl+\\');
  assert.equal(shortcut('open-new-tab').scope, 'search');
  assert.match(shortcut('keyboard-shortcuts').context, /Outside editable/);
  assert.throws(() => shortcut('missing'), /Unknown shortcut/);
});

test('platform labels distinguish Command from Control and Option from Alt', () => {
  assert.equal(formatAccelerator('CmdOrCtrl+Shift+Enter', 'darwin'), 'Cmd+Shift+Enter');
  assert.equal(formatAccelerator('Control+Alt+Space', 'darwin'), 'Control+Option+Space');
  assert.equal(formatAccelerator('CmdOrCtrl+\\', 'linux'), 'Ctrl+Backslash');
  assert.equal(formatAccelerator('Control+Shift+Tab', 'darwin'), 'Control+Shift+Tab');
  assert.equal(formatAccelerator('Super+F12', 'win32'), 'Windows+F12');
});

test('binding resolution uses each platform modifier without stealing editor chords', () => {
  for (const [platform, modifier] of [['darwin', 'metaKey'], ['win32', 'ctrlKey'], ['linux', 'ctrlKey']]) {
    assert.equal(resolveCommand({ key: 't', [modifier]: true }, platform), 'new-tab');
    assert.equal(resolveCommand({ key: 'P', [modifier]: true, shiftKey: true }, platform), 'cycle-view');
    assert.equal(resolveCommand({ key: '\\', code: 'Backslash', [modifier]: true }, platform), 'toggle-layout');
    assert.equal(resolveCommand({ key: '1', [modifier]: true }, platform), 'focus-left');
    assert.equal(resolveCommand({ key: '!', code: 'Digit1', [modifier]: true, shiftKey: true }, platform), null);
    assert.equal(resolveCommand({ key: '/', [modifier]: true }, platform), null);
    assert.equal(resolveCommand({ key: '?', code: 'Slash', [modifier]: true, shiftKey: true }, platform), null);
    assert.equal(resolveCommand({ key: 'n', [modifier]: true, altKey: true }, platform), null);
  }
  assert.equal(resolveCommand({ key: 't', ctrlKey: true }, 'darwin'), null);
  assert.equal(resolveCommand({ key: 'Tab', ctrlKey: true }, 'darwin'), 'next-tab');
  assert.equal(resolveCommand({ key: 'Tab', ctrlKey: true, shiftKey: true }, 'darwin'), 'previous-tab');
  assert.equal(resolveCommand({ key: 'Tab', ctrlKey: true, metaKey: true }, 'darwin'), null);
});

test('search-only actions resolve only in search; plain editing and help keys remain local', () => {
  assert.equal(resolveCommand({ key: 'Enter', metaKey: true }, 'darwin'), null);
  assert.equal(resolveCommand({ key: 'Enter', metaKey: true }, 'darwin', { searchFocused: true }), 'create-note');
  assert.equal(resolveCommand({ key: 'Enter', ctrlKey: true, shiftKey: true }, 'win32', { searchFocused: true }), 'open-new-tab');
  assert.equal(resolveCommand({ key: '?' }, 'darwin'), null);
  assert.equal(resolveCommand({ key: 'Tab' }, 'darwin'), null);
  assert.equal(resolveCommand({ key: 'Enter' }, 'darwin', { searchFocused: true }), null);
  assert.equal(resolveCommand({ key: 'q', metaKey: true }, 'darwin'), null);
  assert.equal(shortcut('quit').native, true);
  assert.equal(resolveCommand({ key: 'Tab', shiftKey: true }, 'darwin'), null);
});

test('already handled, repeated, and composing events never dispatch app commands', () => {
  for (const extra of [{ defaultPrevented: true }, { repeat: true }, { isComposing: true }, { keyCode: 229 }, { getModifierState: (key) => key === 'AltGraph' }]) {
    assert.equal(resolveCommand({ key: 't', metaKey: true, ...extra }, 'darwin'), null);
  }
});
