import test from 'node:test';
import assert from 'node:assert/strict';
import { keyboardEventToAccelerator, formatShortcut, createShortcutRecorder } from '../src/shortcut-recorder.js';

test('shortcut chords preserve actual modifier keys and normalize keyboard keys', () => {
  const examples = [
    [{ key: ' ', code: 'Space', ctrlKey: true, altKey: true }, 'Control+Alt+Space'],
    [{ key: 's', code: 'KeyS', metaKey: true }, 'Super+S'],
    [{ key: 'π', code: 'KeyP', altKey: true }, 'Alt+P'],
    [{ key: '?', code: 'Slash', ctrlKey: true, shiftKey: true }, 'Control+Shift+/'],
    [{ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }, 'Control+Shift+1'],
    [{ key: '+', code: 'NumpadAdd', altKey: true }, 'Alt+numadd'],
    [{ key: '+', altKey: true }, 'Alt+Plus'],
    [{ key: 'ArrowLeft', ctrlKey: true }, 'Control+Left'],
    [{ key: 'PageDown', altKey: true }, 'Alt+PageDown'],
    [{ key: 'F24' }, 'F24'],
    [{ key: 'Enter', ctrlKey: true }, 'Control+Return'],
    [{ key: '1', code: 'Numpad1', ctrlKey: true }, 'Control+num1'],
    [{ key: ';', code: 'Semicolon', ctrlKey: true }, 'Control+;'],
  ];
  for (const [event, expected] of examples) assert.equal(keyboardEventToAccelerator(event), expected);
});

test('shortcut capture ignores incomplete, repeating, composing and unsupported keys', () => {
  for (const event of [
    { key: 'Control' }, { key: 'AltGraph' }, { key: 'Dead', code: 'KeyE', altKey: true },
    { key: 'Escape' }, { key: 'a', repeat: true }, { key: 'a', isComposing: true },
    { key: 'a', keyCode: 229 }, { key: 'a', getModifierState: (key) => key === 'AltGraph' },
    { key: 'F25' }, { key: 'Unidentified' }, { key: '猫' },
  ]) assert.equal(keyboardEventToAccelerator(event), null);
});

test('shortcut labels describe Control and Option accurately on macOS', () => {
  assert.equal(formatShortcut('Control+Alt+Space', 'darwin'), 'Control+Option+Space');
  assert.equal(formatShortcut('Control+Alt+Space', 'linux'), 'Ctrl+Alt+Space');
  assert.equal(formatShortcut('CmdOrCtrl+Shift+Space', 'darwin'), 'Command+Shift+Space');
  assert.equal(formatShortcut('Super+Return', 'darwin'), 'Command+Enter');
  assert.equal(formatShortcut('Super+F12', 'win32'), 'Super+F12');
  assert.equal(formatShortcut('CommandOrControl+MediaPlayPause', 'win32'), 'Ctrl+MediaPlayPause');
});

class Target {
  listeners = new Map();
  textContent = 'Record';
  value = 'Ctrl+Alt+Space';
  dataset = {};
  attributes = {};
  addEventListener(type, callback) { const callbacks = this.listeners.get(type) ?? new Set(); callbacks.add(callback); this.listeners.set(type, callbacks); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  setAttribute(key, value) { this.attributes[key] = value; }
  focus() { this.focused = true; }
  dispatch(type, properties = {}) {
    const event = { ...properties, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    for (const callback of this.listeners.get(type) ?? []) callback(event);
    return event;
  }
}
function fixture(api = {}) {
  const target = new Target(), input = new Target(), recordButton = new Target(), calls = [], changes = [], errors = [];
  const recorder = createShortcutRecorder({
    api: { beginShortcutRecording: async () => { calls.push('begin'); }, endShortcutRecording: async () => { calls.push('end'); }, ...api },
    input, recordButton, platform: 'darwin', eventTarget: target,
    onChange: (value) => { calls.push('change'); changes.push(value); }, onError: (error) => errors.push(error),
  });
  return { recorder, target, input, recordButton, calls, changes, errors };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('recording suppresses commands and resumes handling before publishing a captured shortcut', async () => {
  const f = fixture();
  await f.recorder.start();
  assert.equal(f.recorder.isRecording(), true);
  assert.equal(f.input.value, 'Press shortcut…');
  const modifiers = f.target.dispatch('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true });
  assert.ok(modifiers.prevented && modifiers.stopped);
  assert.deepEqual(f.changes, []);
  const chord = f.target.dispatch('keydown', { key: ' ', code: 'Space', ctrlKey: true, altKey: true });
  assert.ok(chord.prevented && chord.stopped);
  await settled();
  assert.deepEqual(f.calls, ['begin', 'end', 'change']);
  assert.deepEqual(f.changes, ['Control+Alt+Space']);
  assert.equal(f.input.value, 'Control+Option+Space');
  assert.equal(f.recorder.isRecording(), false);
  assert.ok(f.target.dispatch('keyup', { key: ' ', code: 'Space' }).prevented);
  assert.equal(f.target.dispatch('keydown', { key: 'a' }).prevented, undefined);
  await f.recorder.dispose();
});

test('Escape cancels without changing the pending shortcut or dismissing the dialog', async () => {
  const f = fixture();
  await f.recorder.start();
  const event = f.target.dispatch('keydown', { key: 'Escape', code: 'Escape' });
  await settled();
  assert.ok(event.prevented && event.stopped);
  assert.equal(f.input.value, 'Ctrl+Alt+Space');
  assert.deepEqual(f.changes, []);
  assert.deepEqual(f.calls, ['begin', 'end']);
  await f.recorder.dispose();
});

test('blur, pagehide and disposal all resume shortcut handling', async () => {
  for (const type of ['blur', 'pagehide', 'dispose']) {
    const f = fixture();
    await f.recorder.start();
    if (type === 'dispose') await f.recorder.dispose();
    else { f.target.dispatch(type); await settled(); }
    assert.deepEqual(f.calls, ['begin', 'end']);
    assert.equal(f.recorder.isRecording(), false);
    assert.deepEqual(f.changes, []);
    await f.recorder.dispose();
  }
});

test('cancelling while suspension is pending still resumes it in order', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const f = fixture({ beginShortcutRecording: async () => { calls.push('begin'); await gate; }, endShortcutRecording: async () => { calls.push('end'); } });
  const starting = f.recorder.start();
  await settled();
  assert.equal(f.target.dispatch('keydown', { key: 's', ctrlKey: true }).prevented, true);
  assert.deepEqual(f.changes, []);
  const cancelling = f.recorder.cancel();
  release();
  await Promise.all([starting, cancelling]);
  assert.deepEqual(calls, ['begin', 'end']);
  assert.equal(f.input.value, 'Ctrl+Alt+Space');
  await f.recorder.dispose();
});

test('failed suspension restores controls and attempts cleanup without recording a chord', async () => {
  const failure = new Error('Cannot suspend');
  const f = fixture({ beginShortcutRecording: async () => { throw failure; } });
  await f.recorder.start();
  assert.equal(f.recorder.isRecording(), false);
  assert.equal(f.input.value, 'Ctrl+Alt+Space');
  assert.deepEqual(f.calls, ['end']);
  assert.deepEqual(f.errors, [failure]);
  await f.recorder.dispose();
});
