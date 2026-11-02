// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
// App-owned bindings shared by native menus, renderer routing, and shortcut help.
const SHORTCUTS = Object.freeze([
  { id: 'focus-search', group: 'Search and notes', label: 'Search or create a note', accelerator: 'CmdOrCtrl+L', native: true },
  { id: 'new-note-search', group: 'Search and notes', label: 'Start a new note search', accelerator: 'CmdOrCtrl+N' },
  { id: 'edit-search-result', group: 'Search and notes', label: 'Edit the selected result or create the proposed note', accelerator: 'Enter', scope: 'reference', context: 'While library search has focus' },
  { id: 'previous-search-result', group: 'Search and notes', label: 'Browse the previous search result', accelerator: 'Up', scope: 'reference', context: 'While library search has focus' },
  { id: 'next-search-result', group: 'Search and notes', label: 'Browse the next search result', accelerator: 'Down', scope: 'reference', context: 'While library search has focus' },
  { id: 'create-note', group: 'Search and notes', label: 'Create a note from the search text', accelerator: 'CmdOrCtrl+Enter', scope: 'search', context: 'While library search has focus' },
  { id: 'choose-library', group: 'Search and notes', label: 'Choose notes folder', accelerator: 'CmdOrCtrl+O', native: true },
  { id: 'save', group: 'Search and notes', label: 'Save the focused document', accelerator: 'CmdOrCtrl+S', native: true },
  { id: 'quit', group: 'Search and notes', label: 'Quit nvShift', accelerator: 'CmdOrCtrl+Q', scope: 'reference', native: true },
  { id: 'new-tab', group: 'Tabs and panes', label: 'New blank tab, then search', accelerator: 'CmdOrCtrl+T', native: true },
  { id: 'open-new-tab', group: 'Tabs and panes', label: 'Open selected result in a new tab', accelerator: 'CmdOrCtrl+Shift+Enter', scope: 'search', context: 'While library search has focus' },
  { id: 'close-tab', group: 'Tabs and panes', label: 'Close the active tab', accelerator: 'CmdOrCtrl+W', native: true },
  { id: 'next-tab', group: 'Tabs and panes', label: 'Next tab in the focused pane', accelerator: 'Control+Tab', native: true },
  { id: 'previous-tab', group: 'Tabs and panes', label: 'Previous tab in the focused pane', accelerator: 'Control+Shift+Tab', native: true },
  { id: 'focus-left', group: 'Tabs and panes', label: 'Focus the left pane', accelerator: 'CmdOrCtrl+1', context: 'Two-document mode', native: true },
  { id: 'focus-right', group: 'Tabs and panes', label: 'Focus the right pane', accelerator: 'CmdOrCtrl+2', context: 'Two-document mode', native: true },
  { id: 'toggle-layout', group: 'Tabs and panes', label: 'Toggle two documents', accelerator: 'CmdOrCtrl+\\', native: true },
  { id: 'find', group: 'Editing and views', label: 'Find in the focused document', accelerator: 'CmdOrCtrl+F', native: true },
  { id: 'cycle-view', group: 'Editing and views', label: 'Cycle available view modes', accelerator: 'CmdOrCtrl+Shift+P', native: true },
  { id: 'settings', group: 'Editing and views', label: 'Open Settings', accelerator: 'CmdOrCtrl+,', native: true },
  { id: 'editor-tab', group: 'Editing and views', label: 'Fold a heading or indent', accelerator: 'Tab', scope: 'editor', context: 'Editor: fold a heading when possible; otherwise indent. Vim: fold in idle Normal mode, indent in Insert mode.' },
  { id: 'editor-outdent', group: 'Editing and views', label: 'Outdent', accelerator: 'Shift+Tab', scope: 'editor', context: 'Regular editing or Vim Insert mode' },
  { id: 'keyboard-shortcuts', group: 'Editing and views', label: 'Show keyboard shortcuts', accelerator: '?', scope: 'help', context: 'Outside editable controls; use the lifebuoy while editing' },
].map((entry) => Object.freeze({ scope: 'app', native: false, ...entry })));

const byId = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));
function shortcut(id) {
  const entry = byId.get(id);
  if (!entry) throw new Error(`Unknown shortcut: ${id}`);
  return entry;
}
function formatAccelerator(value = '', platform = '') {
  const mac = platform === 'darwin';
  const names = {
    cmdorctrl: mac ? 'Cmd' : 'Ctrl', commandorcontrol: mac ? 'Cmd' : 'Ctrl',
    cmd: 'Cmd', command: 'Cmd', ctrl: mac ? 'Control' : 'Ctrl', control: mac ? 'Control' : 'Ctrl',
    alt: mac ? 'Option' : 'Alt', option: mac ? 'Option' : 'Alt',
    super: mac ? 'Cmd' : platform === 'win32' ? 'Windows' : 'Super', meta: mac ? 'Cmd' : platform === 'win32' ? 'Windows' : 'Super',
    shift: 'Shift', return: 'Enter', enter: 'Enter', esc: 'Escape', escape: 'Escape',
    '\\': 'Backslash', space: 'Space', plus: 'Plus',
  };
  return String(value).split('+').map((part) => names[part.toLowerCase()] ?? part).join('+');
}
function matches(event, accelerator, platform) {
  const keys = accelerator.split('+'), key = keys.pop();
  const flags = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  for (const modifier of keys) {
    if (/^(?:CmdOrCtrl|CommandOrControl)$/i.test(modifier)) flags[platform === 'darwin' ? 'metaKey' : 'ctrlKey'] = true;
    else if (/^(?:Control|Ctrl)$/i.test(modifier)) flags.ctrlKey = true;
    else if (/^(?:Command|Cmd|Meta|Super)$/i.test(modifier)) flags.metaKey = true;
    else if (/^(?:Alt|Option)$/i.test(modifier)) flags.altKey = true;
    else if (/^Shift$/i.test(modifier)) flags.shiftKey = true;
    else return false;
  }
  if (Object.entries(flags).some(([name, value]) => Boolean(event[name]) !== value)) return false;
  if (key === '\\') return event.code === 'Backslash' || event.key === '\\';
  return String(event.key || '').toLowerCase() === (key === 'Return' ? 'Enter' : key).toLowerCase();
}
function resolveCommand(event, platform, { searchFocused = false } = {}) {
  if (!event || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.getModifierState?.('AltGraph')) return null;
  return SHORTCUTS.find((entry) => (entry.scope === 'app' || entry.scope === 'search' && searchFocused) && matches(event, entry.accelerator, platform))?.id ?? null;
}
module.exports = { SHORTCUTS, shortcut, formatAccelerator, resolveCommand };
