import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenShortcutHelp } from '../src/keyboard-help.js';

test('plain question mark opens help outside editable controls, including shifted layouts', () => {
  assert.equal(canOpenShortcutHelp({ key: '?', shiftKey: true, target: { closest: () => null } }), true);
  assert.equal(canOpenShortcutHelp({ key: '?', target: { closest: () => null }, composedPath: () => [{ closest: () => null }] }), true);
});

test('question marks in text fields, contenteditable regions, and Vim editors remain input', () => {
  for (const selector of ['input', 'textarea', 'select', '[role="textbox"]', '.cm-editor']) {
    const target = { closest: (query) => query.includes(selector) ? {} : null };
    assert.equal(canOpenShortcutHelp({ key: '?', target }), false, selector);
  }
  assert.equal(canOpenShortcutHelp({ key: '?', target: { isContentEditable: true } }), false);
  assert.equal(canOpenShortcutHelp({ key: '?', composedPath: () => [{}, { isContentEditable: true }] }), false);
});

test('help ignores recording, other dialogs, composition, repeat, modifiers and handled events', () => {
  for (const patch of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { defaultPrevented: true }, { key: '/' }, { getModifierState: () => true }]) {
    assert.equal(canOpenShortcutHelp({ key: '?', ...patch }), false);
  }
  assert.equal(canOpenShortcutHelp({ key: '?' }, { recording: true }), false);
  assert.equal(canOpenShortcutHelp({ key: '?' }, { dialogOpen: true }), false);
});
