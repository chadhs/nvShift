// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { validate } = require('./settings.cjs');

/** Owns the saved global shortcut and keeps a working binding during replacement. */
function createShortcutController({ globalShortcut, settings, onChange = () => {}, onActivate = () => {}, wayland = false, now = Date.now }) {
  let state = { accelerator: '', registered: false, error: '', status: 'disabled', lastTriggeredAt: null, failedAttempt: null, recording: false };
  let queue = Promise.resolve(), disposed = false;
  const snapshot = () => ({ ...state, failedAttempt: state.failedAttempt ? { ...state.failedAttempt } : null });
  const publish = () => onChange(snapshot());
  const enqueue = (operation) => {
    const next = queue.catch(() => {}).then(() => {
      if (disposed) throw new Error('Shortcut handling has stopped.');
      return operation();
    });
    queue = next;
    return next;
  };
  function resume() {
    if (!state.recording) return;
    globalShortcut.setSuspended(false);
    state.recording = false;
    publish();
  }
  function register(accelerator) {
    try {
      const registered = globalShortcut.register(accelerator, () => {
        // A candidate can already receive events while its preference is saving.
        if (disposed || state.recording || state.accelerator !== accelerator || !state.registered) return;
        state.lastTriggeredAt = now();
        state.status = 'registered';
        publish();
        onActivate();
      });
      if (!registered) throw new Error('The quick-access shortcut could not be registered. It may be used by another application. Choose another shortcut or use the tray/menu-bar icon.');
    } catch (error) {
      if (/could not be registered/.test(error.message)) throw error;
      throw new Error('That shortcut could not be registered. Choose another shortcut in Settings.', { cause: error });
    }
  }
  function active(accelerator) {
    state = { ...state, accelerator, registered: Boolean(accelerator), error: '', status: accelerator ? wayland ? 'awaiting-verification' : 'registered' : 'disabled', lastTriggeredAt: null, failedAttempt: null };
    publish();
  }
  return {
    snapshot,
    initialize() {
      return enqueue(() => {
        const accelerator = settings.snapshot().globalShortcut;
        if (!accelerator) { active(''); return snapshot(); }
        try { register(accelerator); active(accelerator); }
        catch (error) {
          state = { ...state, accelerator, registered: false, status: 'unavailable', error: error.message };
          publish();
        }
        return snapshot();
      });
    },
    update(accelerator) {
      return enqueue(async () => {
        resume();
        let candidateRegistered = false;
        try {
          validate({ globalShortcut: accelerator });
          if (accelerator === state.accelerator && (state.registered || !accelerator)) {
            state.failedAttempt = null;
            publish();
            return settings.snapshot();
          }
          if (accelerator) { register(accelerator); candidateRegistered = true; }
          const updated = await settings.update({ globalShortcut: accelerator });
          if (disposed) {
            if (candidateRegistered) globalShortcut.unregister(accelerator);
            return updated;
          }
          const previous = state.registered ? state.accelerator : '';
          active(accelerator);
          if (previous && previous !== accelerator) globalShortcut.unregister(previous);
          return updated;
        } catch (error) {
          if (candidateRegistered) globalShortcut.unregister(accelerator);
          state.failedAttempt = { accelerator: typeof accelerator === 'string' ? accelerator : '', error: error.message };
          publish();
          throw error;
        }
      });
    },
    beginRecording() {
      return enqueue(() => {
        if (!state.recording) { globalShortcut.setSuspended(true); state.recording = true; publish(); }
        return snapshot();
      });
    },
    endRecording() { return enqueue(() => { resume(); return snapshot(); }); },
    dispose() {
      const finish = queue.catch(() => {}).then(() => {
        resume();
        if (state.registered) globalShortcut.unregister(state.accelerator);
        disposed = true;
        state.registered = false;
      });
      queue = finish;
      return finish;
    },
  };
}
module.exports = { createShortcutController };
