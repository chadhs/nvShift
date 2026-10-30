import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutController } from '../electron/shortcuts.cjs';

function fixture({ accelerator = 'Control+Alt+Space', wayland = false } = {}) {
  const bindings = new Map(), calls = [], changes = [];
  let saved = accelerator, persistenceError = false, registrationError = false, suspended = false, activations = 0, saves = 0;
  const globalShortcut = {
    register(value, callback) {
      calls.push(['register', value]);
      if (registrationError === 'throw') throw new Error('Invalid accelerator');
      if (registrationError || bindings.has(value) || suspended) return false;
      bindings.set(value, callback); return true;
    },
    unregister(value) { calls.push(['unregister', value]); bindings.delete(value); },
    setSuspended(value) { calls.push(['suspend', value]); suspended = value; },
  };
  const settings = {
    snapshot: () => ({ globalShortcut: saved }),
    async update(patch) {
      calls.push(['save', patch.globalShortcut]); saves++;
      if (persistenceError) throw new Error('Disk is full');
      saved = patch.globalShortcut;
      return this.snapshot();
    },
  };
  const controller = createShortcutController({ globalShortcut, settings, wayland, now: () => 1234, onChange: (value) => changes.push(value), onActivate: () => { activations++; } });
  return { controller, globalShortcut, bindings, calls, changes, settings,
    failRegistration(value = true) { registrationError = value; }, failPersistence(value = true) { persistenceError = value; },
    get saved() { return saved; }, get activations() { return activations; }, get suspended() { return suspended; }, get saves() { return saves; } };
}

test('initializes default, records activation and releases its binding on dispose', async () => {
  const f = fixture();
  await f.controller.initialize();
  assert.equal(f.controller.snapshot().status, 'registered');
  f.bindings.get(f.saved)();
  assert.equal(f.activations, 1);
  assert.equal(f.controller.snapshot().lastTriggeredAt, 1234);
  const copy = f.controller.snapshot(); copy.status = 'invalid';
  assert.equal(f.controller.snapshot().status, 'registered');
  await f.controller.dispose();
  assert.equal(f.bindings.size, 0);
});

test('registration failures preserve the saved working shortcut and show the attempt separately', async () => {
  for (const reason of [true, 'throw']) {
    const f = fixture(); await f.controller.initialize(); f.failRegistration(reason);
    await assert.rejects(f.controller.update('Control+Alt+K'), /could not be registered/);
    assert.equal(f.saved, 'Control+Alt+Space');
    assert.equal(f.controller.snapshot().status, 'registered');
    assert.equal(f.controller.snapshot().error, '');
    assert.equal(f.controller.snapshot().failedAttempt.accelerator, 'Control+Alt+K');
    f.bindings.get(f.saved)();
    assert.equal(f.activations, 1);
    assert.equal(f.saves, 0);
  }
});

test('registers then persists then releases old binding, and repeated Apply is a no-op', async () => {
  const f = fixture(); await f.controller.initialize(); f.calls.length = 0;
  await f.controller.update('Control+Alt+K');
  assert.deepEqual(f.calls, [['register', 'Control+Alt+K'], ['save', 'Control+Alt+K'], ['unregister', 'Control+Alt+Space']]);
  f.calls.length = 0;
  await f.controller.update('Control+Alt+K');
  assert.deepEqual(f.calls, []);
  assert.equal(f.bindings.size, 1);
});

test('persistence failure releases candidate and keeps previous setting and binding', async () => {
  const f = fixture(); await f.controller.initialize(); f.failPersistence();
  await assert.rejects(f.controller.update('Control+Alt+K'), /Disk is full/);
  assert.equal(f.saved, 'Control+Alt+Space');
  assert.deepEqual([...f.bindings.keys()], ['Control+Alt+Space']);
  assert.equal(f.controller.snapshot().failedAttempt.error, 'Disk is full');
  f.failPersistence(false);
  await f.controller.update('Control+Alt+K');
  assert.equal(f.controller.snapshot().failedAttempt, null);
});

test('Disable persists first, and persistence failure leaves binding active', async () => {
  const f = fixture(); await f.controller.initialize(); f.failPersistence();
  await assert.rejects(f.controller.update(''), /Disk is full/);
  assert.equal(f.bindings.size, 1);
  f.failPersistence(false); f.calls.length = 0;
  await f.controller.update('');
  assert.deepEqual(f.calls, [['save', ''], ['unregister', 'Control+Alt+Space']]);
  assert.equal(f.controller.snapshot().status, 'disabled');
  assert.equal(f.saved, '');
});

test('invalid settings do not touch registration or the saved shortcut', async () => {
  const f = fixture(); await f.controller.initialize(); f.calls.length = 0;
  await assert.rejects(f.controller.update('Control+\nSpace'), /Invalid global shortcut/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.saved, 'Control+Alt+Space');
});

test('serial changes retain the final saved binding', async () => {
  const f = fixture(); await f.controller.initialize();
  await Promise.all([f.controller.update('Control+Alt+K'), f.controller.update('Control+Alt+L'), f.controller.update('')]);
  assert.equal(f.saved, ''); assert.equal(f.bindings.size, 0);
  assert.equal(f.controller.snapshot().status, 'disabled');
});

test('recording suspends callbacks, cancellation resumes, Apply resumes before registering and disposal cleans up', async () => {
  const f = fixture(); await f.controller.initialize();
  await f.controller.beginRecording();
  assert.equal(f.suspended, true); assert.equal(f.controller.snapshot().recording, true);
  f.bindings.get(f.saved)(); assert.equal(f.activations, 0);
  await f.controller.endRecording(); assert.equal(f.suspended, false);
  await f.controller.beginRecording(); f.calls.length = 0;
  await f.controller.update('Control+Alt+K');
  assert.deepEqual(f.calls[0], ['suspend', false]);
  assert.equal(f.controller.snapshot().recording, false);
  await f.controller.beginRecording(); await f.controller.dispose();
  assert.equal(f.suspended, false); assert.equal(f.bindings.size, 0);
});

test('Wayland reports submitted binding as awaiting verification until the real callback', async () => {
  const f = fixture({ wayland: true }); await f.controller.initialize();
  assert.equal(f.controller.snapshot().status, 'awaiting-verification');
  assert.equal(f.controller.snapshot().lastTriggeredAt, null);
  f.bindings.get(f.saved)();
  assert.equal(f.controller.snapshot().status, 'registered');
  assert.equal(f.controller.snapshot().lastTriggeredAt, 1234);
});

test('startup failure is visible and can be retried without overwriting the preference', async () => {
  const f = fixture(); f.failRegistration();
  await f.controller.initialize();
  assert.equal(f.controller.snapshot().status, 'unavailable');
  assert.match(f.controller.snapshot().error, /could not be registered/);
  f.failRegistration(false);
  await f.controller.update(f.saved);
  assert.equal(f.controller.snapshot().status, 'registered');
});

test('old binding stays usable during persistence and stale callbacks cannot activate after replacement', async () => {
  const f = fixture(); await f.controller.initialize();
  let release, started;
  const pending = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const update = f.settings.update.bind(f.settings);
  f.settings.update = async (patch) => { started(); await pending; return update(patch); };
  const oldCallback = f.bindings.get(f.saved);
  const change = f.controller.update('Control+Alt+K');
  await began;
  oldCallback();
  assert.equal(f.activations, 1);
  f.bindings.get('Control+Alt+K')();
  assert.equal(f.activations, 1);
  assert.equal(f.controller.snapshot().accelerator, 'Control+Alt+Space');
  release(); await change;
  oldCallback();
  assert.equal(f.activations, 1);
  f.bindings.get('Control+Alt+K')();
  assert.equal(f.activations, 2);
});
