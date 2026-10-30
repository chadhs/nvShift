// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const namedKeys = {
  ' ': 'Space', Spacebar: 'Space', Enter: 'Return', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock', PrintScreen: 'PrintScreen',
};
const punctuationCodes = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};
const numpadKeys = { NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv' };
const punctuation = new Set(")!@#$%^&*(:;=<> ,_-?.~`{}][|\\\"'".replaceAll(' ', ''));

/** Use the unshifted key with explicit modifiers, including Option-produced text. */
export function keyboardEventToAccelerator(event) {
  if (!event || event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null;
  if (['Escape', 'Esc', 'Shift', 'Control', 'Alt', 'Meta', 'OS', 'AltGraph', 'Dead', 'Unidentified', 'Process'].includes(event.key)) return null;
  let key = namedKeys[event.key] ?? numpadKeys[event.code];
  if (!key && /^Numpad[0-9]$/u.test(event.code || '')) key = `num${event.code.slice(-1)}`;
  if (!key && /^[a-z0-9]$/iu.test(event.key || '')) key = event.key.toUpperCase();
  if (!key && /^Digit[0-9]$/u.test(event.code || '')) key = event.code.slice(-1);
  if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(event.key || '')) key = event.key;
  if (!key && punctuationCodes[event.code]) key = punctuationCodes[event.code];
  if (!key && event.key === '+') key = 'Plus';
  if (!key && punctuation.has(event.key)) key = event.key;
  // Option can turn a letter into a symbol, such as Option+P producing π.
  if (!key && /^(?:Key[A-Z]|Digit[0-9])$/u.test(event.code || '')) key = event.code.slice(-1);
  if (!key) return null;
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Control');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  return [...modifiers, key].join('+');
}

export function formatShortcut(value = '', platform = '') {
  const mac = platform === 'darwin';
  const names = {
    commandorcontrol: mac ? 'Command' : 'Ctrl', cmdorctrl: mac ? 'Command' : 'Ctrl',
    control: mac ? 'Control' : 'Ctrl', ctrl: mac ? 'Control' : 'Ctrl', command: 'Command', cmd: 'Command',
    alt: mac ? 'Option' : 'Alt', option: mac ? 'Option' : 'Alt', super: mac ? 'Command' : 'Super', meta: mac ? 'Command' : 'Super',
    shift: 'Shift', plus: '+', return: 'Enter', esc: 'Escape', space: 'Space',
  };
  return String(value).split('+').map((part) => names[part.toLowerCase()] ?? part).join('+');
}

/** Capture on the window before document/editor handlers, with main-owned suspension. */
export function createShortcutRecorder({ api, input, recordButton, platform = '', onChange = () => {}, onError = () => {}, onRecordingChange = () => {}, eventTarget = window }) {
  let active = false, accepting = false, disposed = false, generation = 0;
  let previousValue = '', operations = Promise.resolve(), starting;
  const released = new Set();
  const enqueue = (operation) => (operations = operations.catch(() => {}).then(operation));
  const suppress = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  const identity = (event) => event.code || event.key;
  function render() {
    recordButton.textContent = active ? 'Cancel recording' : 'Record';
    recordButton.setAttribute('aria-pressed', String(active));
    input.dataset.recording = String(active);
    onRecordingChange(active);
  }
  async function stop() {
    if (!active) { await operations; return; }
    active = false; accepting = false; generation++;
    input.value = previousValue;
    render();
    await enqueue(() => api.endShortcutRecording());
  }
  async function start() {
    if (disposed) return;
    if (active) return starting;
    active = true; accepting = false;
    const token = ++generation;
    previousValue = input.value;
    input.value = 'Preparing recorder…';
    render();
    starting = enqueue(() => api.beginShortcutRecording());
    try {
      await starting;
      if (!active || token !== generation || disposed) return;
      accepting = true;
      input.value = 'Press shortcut…';
      input.focus();
    } catch (error) {
      if (token === generation) {
        try { await stop(); } catch { /* Main also resumes on blur or destruction. */ }
        onError(error);
      }
    }
  }
  async function capture(accelerator) {
    const token = generation + 1;
    try {
      await stop();
      if (generation !== token || disposed) return;
      input.value = formatShortcut(accelerator, platform);
      onChange(accelerator);
    } catch (error) { onError(error); }
  }
  function keydown(event) {
    if (!active) return;
    suppress(event);
    released.add(identity(event));
    if (event.key === 'Escape' || event.key === 'Esc') { void stop().catch(onError); return; }
    if (!accepting) return;
    const accelerator = keyboardEventToAccelerator(event);
    if (accelerator) void capture(accelerator);
  }
  function keyup(event) {
    if (active || released.has(identity(event))) suppress(event);
    released.delete(identity(event));
  }
  const cancel = () => stop();
  const cancelFromEvent = () => { void stop().catch(onError); };
  const click = () => { if (active) cancelFromEvent(); else void start(); };
  eventTarget.addEventListener('keydown', keydown, true);
  eventTarget.addEventListener('keyup', keyup, true);
  eventTarget.addEventListener('blur', cancelFromEvent);
  eventTarget.addEventListener('pagehide', cancelFromEvent);
  recordButton.addEventListener('click', click);
  return {
    start, stop, cancel, isRecording: () => active,
    async dispose() {
      disposed = true;
      eventTarget.removeEventListener('keydown', keydown, true);
      eventTarget.removeEventListener('keyup', keyup, true);
      eventTarget.removeEventListener('blur', cancelFromEvent);
      eventTarget.removeEventListener('pagehide', cancelFromEvent);
      recordButton.removeEventListener('click', click);
      await stop();
    },
  };
}
