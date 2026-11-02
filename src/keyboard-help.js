// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import catalog from '../electron/shortcut-catalog.cjs';
const { SHORTCUTS, formatAccelerator } = catalog;

export function canOpenShortcutHelp(event, { recording = false, dialogOpen = false } = {}) {
  if (!event || recording || dialogOpen || event.defaultPrevented || event.key !== '?' || event.repeat || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.getModifierState?.('AltGraph')) return false;
  const targets = event.composedPath?.() || [event.target];
  return !targets.some((target) => target?.isContentEditable || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .cm-editor'));
}

export function createKeyboardHelp({ dialog, button, platform, captureFocus, restoreFocus, isRecording }) {
  let savedFocus = null, pendingFocus = null;
  const groups = dialog.querySelector('#shortcut-groups');
  for (const name of ['Search and notes', 'Tabs and panes', 'Editing and views']) {
    const section = document.createElement('section'), heading = document.createElement('h3'), table = document.createElement('table');
    heading.textContent = name; table.setAttribute('aria-label', name);
    const body = document.createElement('tbody');
    for (const entry of SHORTCUTS.filter((item) => item.group === name)) {
      const row = document.createElement('tr'), description = document.createElement('th'), binding = document.createElement('td'), keys = document.createElement('kbd');
      description.scope = 'row'; description.textContent = entry.label;
      if (entry.context) { const context = document.createElement('span'); context.className = 'shortcut-context'; context.textContent = entry.context; description.append(context); }
      keys.textContent = formatAccelerator(entry.accelerator, platform); binding.append(keys); row.append(description, binding); body.append(row);
    }
    table.append(body); section.append(heading, table); groups.append(section);
  }
  function rememberFocus() { pendingFocus = captureFocus(); }
  function open(usePending = false) {
    if (isRecording() || dialog.open || document.querySelector('dialog[open]')) { pendingFocus = null; return; }
    savedFocus = usePending && pendingFocus ? pendingFocus : captureFocus(); pendingFocus = null;
    dialog.showModal(); dialog.querySelector('#close-keyboard-help').focus();
  }
  function close() { if (dialog.open) dialog.close(); }
  button.addEventListener('pointerdown', rememberFocus);
  button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') rememberFocus(); });
  button.addEventListener('click', () => open(true));
  dialog.querySelector('#close-keyboard-help').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { const previous = savedFocus; savedFocus = null; if (previous) Promise.resolve(restoreFocus(previous)).catch(() => button.focus()); });
  return { open, close, rememberFocus, isOpen: () => dialog.open,
    updateShortcut(state, configured) {
      const accelerator = state?.accelerator ?? configured ?? '';
      dialog.querySelector('#help-global-shortcut').textContent = accelerator ? formatAccelerator(accelerator, platform) : 'Disabled';
      dialog.querySelector('#help-global-status').textContent = !accelerator ? 'No global shortcut assigned.' : state?.error || (state?.status === 'awaiting-verification' ? 'Awaiting desktop verification.' : state?.registered ? 'Available while nvShift is running, including from another app.' : 'Shortcut unavailable.');
    },
  };
}
