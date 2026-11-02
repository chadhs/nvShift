import { version as appVersion } from '../package.json';
import { createDocumentPane } from './document-pane.js';
import { createAppearance } from './appearance.js';
import { createAssetCleanupUI } from './asset-cleanup-ui.js';
import { createShortcutRecorder, formatShortcut as displayShortcut } from './shortcut-recorder.js';
import { createKeyboardHelp, canOpenShortcutHelp } from './keyboard-help.js';
import shortcutCatalog from '../electron/shortcut-catalog.cjs';
import './style.css';
const { shortcut: binding, formatAccelerator, resolveCommand } = shortcutCatalog;

const api = window.nvShift;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const mac = api.platform === 'darwin';
document.documentElement.dataset.platform = api.platform;
$('#app-version').textContent = `v${appVersion}`;
$('#search-shortcut').textContent = mac ? '⌘ L' : 'Ctrl L';
const defaultSettings = { mode: 'system', light: 'light', dark: 'dark', sansSerifHeadings: false, contentWidth: 'reading', filenameHeadings: false, vimMode: false, viewMode: 'editor', defaultExtension: 'md', txtSyntax: 'plain', globalShortcut: 'Control+Alt+Space', sidebarWidth: 300, splitRatio: .5 };
let settings = { ...defaultSettings }, library = { root: null, count: 0, indexing: false, errors: [] };
let workspace = null, current = null, shortcut = null;
let shortcutCandidate = null, shortcutSaving = false;
let rows = [], selected = -1, querySequence = 0, lastSearchQuery = null, queryTimer;
let resultBrowseTimer, resultBrowseVersion = 0, resultMoveVersion = 0;
let navigationQueue = Promise.resolve(), settingsQueue = Promise.resolve();
let settingsVersion = 0, pendingSettings = 0, settingsBookmark = null, pendingSettingsBookmark = null;
const rendererNonce = crypto.randomUUID();
let workspaceRoot = null, workspaceGeneration = -1;
let menuContext = null, overflowFrame = null;
let switchingLibrary = false, historyError = null, tabsKey = '', dialogDocumentId = null;
const documents = new Map(), drafts = new Map(), historyWrites = new Set(), editorSessions = new Map(), panes = new Map();
const template = $('#note-workspace').cloneNode(true);
$('#note-workspace').remove();
const groupHost = document.createElement('div'); groupHost.id = 'document-groups'; $('#note-panel').append(groupHost);
function reportError(reason) { $('#message-text').textContent = typeof reason === 'string' ? reason : reason?.message || 'This action could not be completed.'; $('#message').hidden = false; }
function run(promise) { return Promise.resolve(promise).catch(reportError); }
function clearMessage() { $('#message').hidden = true; $('#message-text').textContent = ''; }
const focusedGroup = () => workspace?.groups.find((group) => group.id === workspace.focusedGroupId);
const activePane = () => panes.get(workspace?.focusedGroupId)?.view;
const paneFor = (id) => [...panes.values()].find((item) => item.view.document?.id === id)?.view;
const appearance = createAppearance({ windowTheme: (theme) => api.windowTheme(theme), onTheme: () => { for (const item of panes.values()) item.view.applySettings(settings, item.view.viewMode); } });
const assetCleanup = createAssetCleanupUI({ api, onError: reportError, beforeScan: async () => {
  cancelSearchNavigation(); await navigationQueue.catch(() => {}); await flushDrafts();
  if (!library.root) throw new Error('Choose a notes folder first.');
  if (historyError) throw new Error(`Undo protection could not be recorded. Restart nvShift before cleaning assets. ${historyError.message}`);
} });
const shortcutRecorder = createShortcutRecorder({
  api, input: $('#global-shortcut'), recordButton: $('#record-shortcut'), platform: api.platform,
  onChange: (accelerator) => { shortcutCandidate = accelerator; renderShortcutControls(); },
  onRecordingChange: () => renderShortcutControls(), onError: reportError,
});
const keyboardHelp = createKeyboardHelp({
  dialog: $('#keyboard-help-dialog'), button: $('#keyboard-help-button'), platform: api.platform,
  isRecording: () => shortcutRecorder.isRecording(),
  captureFocus: () => {
    const element = document.activeElement, groupId = element?.closest('.document-group')?.dataset.groupId ?? workspace?.focusedGroupId;
    return { element, groupId, generation: workspace?.generation, bookmark: panes.get(groupId)?.view.bookmark() };
  },
  restoreFocus: async (saved) => {
    if (saved.generation !== workspace?.generation) { $('#keyboard-help-button').focus(); return; }
    if (saved.groupId && workspace.groups.some((group) => group.id === saved.groupId) && workspace.focusedGroupId !== saved.groupId) await workspaceCommand('focusGroup', { groupId: saved.groupId });
    const pane = paneFor(saved.bookmark?.id);
    if (pane && saved.bookmark.focused) { pane.restoreSelection(saved.bookmark); pane.focus(); }
    else if (saved.element?.isConnected) saved.element.focus({ preventScroll: true });
    else $('#keyboard-help-button').focus();
  },
});
function formatShortcut(value) { return displayShortcut(value, api.platform); }
function renderShortcutControls() {
  const recording = shortcutRecorder.isRecording();
  if (!recording) $('#global-shortcut').value = formatShortcut(shortcutCandidate ?? settings.globalShortcut) || 'Disabled';
  $('#shortcut-saved').textContent = `Saved shortcut: ${formatShortcut(settings.globalShortcut) || 'Disabled'}`;
  $('#record-shortcut').disabled = shortcutSaving;
  $('#save-shortcut').disabled = recording || shortcutSaving || shortcutCandidate === null;
  $('#disable-shortcut').disabled = recording || shortcutSaving || !settings.globalShortcut;
  $('#reset-shortcut').disabled = recording || shortcutSaving;
}
async function applyShortcut(accelerator) {
  if (shortcutSaving) return;
  shortcutSaving = true;
  renderShortcutControls();
  try {
    await shortcutRecorder.stop();
    await updateSettings({ globalShortcut: accelerator });
    shortcutCandidate = null;
  } finally { shortcutSaving = false; renderShortcutControls(); }
}
async function openAssetCleanup() {
  if ($('#settings-dialog').open) await closeSettings();
  assetCleanup.open();
}

function applySettings(next) {
  const previousDefault = settings.defaultExtension;
  settings = { ...defaultSettings, ...next }; appearance.apply(settings);
  for (const control of $$('[data-setting]')) { const value = settings[control.dataset.setting]; if (control.type === 'checkbox') control.checked = Boolean(value); else control.value = value; }
  if (previousDefault !== settings.defaultExtension || !$('#create-extension').value) $('#create-extension').value = settings.defaultExtension;
  $('#vim-status').hidden = !settings.vimMode;
  renderShortcutControls(); keyboardHelp.updateShortcut(shortcut, settings.globalShortcut); renderWorkspace();
}
function updateSettings(patch) {
  const version = ++settingsVersion;
  pendingSettings++;
  if (!Object.hasOwn(patch, 'globalShortcut')) applySettings({ ...settings, ...patch });
  const operation = settingsQueue.catch(() => {}).then(() => api.updateSettings(patch)).then((saved) => {
    if (version === settingsVersion && saved) applySettings(saved);
    return saved;
  }).finally(() => { pendingSettings--; });
  settingsQueue = operation;
  return operation;
}

function acceptLibrary(next) {
  if (!next) return;
  const changedRoot = library.root !== next.root;
  library = { ...library, ...next };
  if (changedRoot) $('#create-extension').value = settings.defaultExtension;
  const rootName = library.root?.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  $('#library-name').textContent = rootName || 'Choose notes folder';
  $('#choose-library').title = library.root ? `${library.root}\nChoose another notes folder` : 'Choose notes folder';
  $('#library-summary').textContent = library.root ? `${library.count.toLocaleString()} ${library.count === 1 ? 'note' : 'notes'}${library.indexing ? ' · Indexing…' : ''}` : 'Your notes, on your computer.';
  $('#library-status').textContent = library.indexing ? 'Indexing your notes…' : library.root ? 'Watching for changes' : 'Local files. Always yours.';
  $('#library-search').disabled = !library.root;
  $('#create-extension').disabled = !library.root;
  $('#default-extension').disabled = !library.root;
  $('#txt-syntax').disabled = !library.root;
  $('#settings-cleanup').disabled = !library.root;
  $('#settings-cleanup-help').textContent = library.root ? 'Review unused images in this notes folder before moving selected files to Trash.' : 'Choose a notes folder first.';
  $('#welcome-choose').textContent = library.root ? 'Create your first note' : 'Choose notes folder';
  $('#library-empty').hidden = Boolean(library.root);
  if (library.errors?.length) {
    $('#library-status').textContent = `${library.errors.length} ${library.errors.length === 1 ? 'file needs' : 'files need'} attention`;
    $('#library-status').title = library.errors.join('\n');
  } else $('#library-status').title = '';
  scheduleSearch();
}
function acceptShortcut(next) {
  if (!next) return;
  shortcut = next;
  keyboardHelp.updateShortcut(next, settings.globalShortcut);
  const label = formatShortcut(next.accelerator);
  const status = next.status === 'awaiting-verification' ? 'Shortcut awaiting verification' : next.registered ? `${label} to search` : next.accelerator ? 'Shortcut unavailable' : 'Shortcut not assigned';
  $('#shortcut-status').textContent = status;
  $('#shortcut-status').dataset.error = String(Boolean(next.error));
  $('#shortcut-status').title = next.error || label || '';
  $('#shortcut-registration').textContent = next.status === 'awaiting-verification'
    ? 'Shortcut requested. Your desktop may require approval or a binding in its shortcut settings. Press it from another app to verify it.'
    : next.registered ? `Registered: ${label}. Press it while another app has focus to verify quick access.`
    : next.accelerator ? 'Shortcut unavailable. Record another shortcut or use the tray icon.' : 'Quick-access shortcut disabled.';
  $('#shortcut-last-triggered').textContent = next.lastTriggeredAt ? `Last received: ${new Date(next.lastTriggeredAt).toLocaleString()}` : 'No shortcut activation received in this session.';
  $('#shortcut-error').textContent = next.failedAttempt ? `${formatShortcut(next.failedAttempt.accelerator) || 'Disable'}: ${next.failedAttempt.error}` : next.error || '';
}
function acceptState(state) {
  if (!state) return;
  if (state.workspace && state.workspace.generation < workspaceGeneration) return;
  if (state.workspace && state.workspace.generation !== workspaceGeneration) closeMenu();
  if (state.workspace) workspaceGeneration = state.workspace.generation;
  if (state.settings && !pendingSettings) applySettings(state.settings);
  acceptShortcut(state.shortcut);
  if (state.library) {
    if (workspaceRoot !== state.library.root) { documents.clear(); drafts.clear(); editorSessions.clear(); tabsKey = ''; workspaceRoot = state.library.root; }
    acceptLibrary(state.library);
  }
  if (switchingLibrary) return;
  for (const doc of Object.values(state.documents || {})) acceptDocument(doc, false);
  if (state.document) acceptDocument(state.document, false);
  if (state.workspace && (!workspace || state.workspace.generation !== workspace.generation || state.workspace.revision >= workspace.revision)) workspace = state.workspace;
  renderWorkspace();
  if (state.error) reportError(state.error);
}
function draftFor(doc) {
  let entry = drafts.get(doc.id);
  if (!entry) { const version = Number(doc.clientVersion) || 0; entry = { id: doc.id, source: doc.source, version, ackVersion: version, baseRevision: doc.revision, snapshot: doc, sending: null, error: null }; drafts.set(doc.id, entry); }
  return entry;
}
function displayed(id) {
  const doc = documents.get(id), entry = drafts.get(id);
  if (!doc) return null;
  return entry && entry.version > (Number(doc.clientVersion) || 0) ? { ...doc, source: entry.source, status: ['conflict', 'error'].includes(doc.status) ? doc.status : 'dirty' } : doc;
}
function acceptDocument(doc, render = true) {
  if (!doc) return;
  const previous = documents.get(doc.id);
  if (previous && previous.revision > doc.revision) return;
  documents.set(doc.id, doc);
  const entry = draftFor(doc), version = Number(doc.clientVersion) || 0;
  if (version >= entry.version) { entry.source = doc.source; entry.version = version; entry.ackVersion = version; entry.baseRevision = doc.revision; entry.snapshot = doc; }
  if (render) renderWorkspace();
}
function scheduleDraft(entry, delay = 120) { clearTimeout(entry.timer); entry.timer = setTimeout(() => { entry.timer = null; run(mirrorDraft(entry)); }, delay); }
function changed(id, source) {
  const doc = documents.get(id); if (!doc) return;
  const entry = draftFor(doc); entry.source = source; entry.version++; entry.error = null;
  renderWorkspace(); scheduleDraft(entry, doc.extension === 'txt' ? 120 : 0); scheduleSearch();
}
async function mirrorDraft(entry) {
  clearTimeout(entry.timer); entry.timer = null;
  if (entry.sending) { await entry.sending; if (entry.version > entry.ackVersion) return mirrorDraft(entry); return entry.snapshot; }
  if (entry.ackVersion >= entry.version) return entry.snapshot;
  entry.sending = (async () => {
    while (entry.ackVersion < entry.version) {
      const version = entry.version, source = entry.source;
      const doc = await api.updateBuffer(entry.id, source, version, entry.baseRevision);
      if (!doc) throw new Error('The note could not be updated. Your editor contents remain available.');
      entry.ackVersion = Math.max(entry.ackVersion, version); entry.baseRevision = doc.revision; entry.snapshot = doc; entry.error = null;
      acceptDocument(doc);
    }
    return entry.snapshot;
  })().catch((error) => { entry.error = error; reportError(error); throw error; }).finally(() => { entry.sending = null; });
  return entry.sending;
}
async function flushDrafts() { await settingsQueue.catch(() => {}); await Promise.all([...historyWrites]); await Promise.all([...drafts.values()].map((entry) => mirrorDraft(entry))); }
function protectHistory(id, source) {
  const write = api.protectAssetHistory(id, source).catch((error) => { historyError = error; }).finally(() => historyWrites.delete(write)); historyWrites.add(write);
}
function navigate(operation) { const next = navigationQueue.catch(() => {}).then(async () => { await flushDrafts(); return operation(); }); navigationQueue = next; return next; }
async function workspaceCommand(type, extra = {}) {
  const generation = workspace?.generation, groupId = extra.groupId ?? workspace?.focusedGroupId;
  return navigate(async () => { const state = await api.workspace({ type, generation, groupId, ...extra }); acceptState(state); return state; });
}
function normalizePaneIds(root, primary, groupId) {
  const namespace = primary ? 'primary' : groupId; if (root.dataset.idNamespace === namespace) return; root.dataset.idNamespace = namespace;
  const ids = new Map();
  for (const node of [root, ...root.querySelectorAll('[data-role]')]) if (node.dataset.role) { const role = node.dataset.role; node.id = primary ? role : `${groupId}-${role}`; ids.set(role, node.id); }
  for (const node of [root, ...root.querySelectorAll('*')]) for (const attr of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
    const original = node.getAttribute(`data-original-${attr}`); if (original) node.setAttribute(attr, original.split(/\s+/).map((id) => ids.get(id) || id).join(' '));
  }
}
function createPane(group, index) {
  const element = document.createElement('section'); element.className = 'document-group'; element.dataset.groupId = group.id; element.setAttribute('aria-label', index ? 'Right document pane' : 'Left document pane');
  const root = template.cloneNode(true); root.hidden = true; root.classList.add('document-pane'); root.dataset.groupId = group.id;
  for (const node of [root, ...root.querySelectorAll('[id]')]) if (node.id) node.dataset.role = node.id;
  for (const node of [root, ...root.querySelectorAll('*')]) for (const attr of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) if (node.hasAttribute(attr)) node.setAttribute(`data-original-${attr}`, node.getAttribute(attr));
  normalizePaneIds(root, index === 0, group.id);
  element.append(root);
  const more = document.createElement('button'); more.className = 'note-more icon-button'; more.textContent = '⋯'; more.setAttribute('aria-label', 'Note actions');
  root.querySelector('.note-actions').append(more);
  more.addEventListener('click', (event) => { const doc = panes.get(group.id)?.view.document; if (!doc) return; const actions = ['rename', 'reveal', 'trash'].map((action) => ({ label: action === 'trash' ? 'Move note to Trash' : `${action[0].toUpperCase()}${action.slice(1)} note`, action: () => noteAction(action, doc.id) })); if (doc.extension === 'txt') for (const [mode, label] of [['auto', 'Automatic'], ['plain', 'Plain text'], ['markdown', 'Markdown'], ['org', 'Org']]) actions.push({ label: `Syntax: ${label}`, action: () => setNoteSyntax(doc.id, mode, panes.get(group.id)?.view.bookmark()) }); showMenu(event, actions); });
  const empty = document.createElement('button'); empty.className = 'pane-empty'; const emptyTitle = document.createElement('span'); emptyTitle.textContent = index ? 'Search for a reference note' : 'Search for a note'; const emptyHint = document.createElement('small'); emptyHint.textContent = `Switch panes with ${formatAccelerator(binding('focus-left').accelerator, api.platform)} and ${formatAccelerator(binding('focus-right').accelerator, api.platform)}`; empty.append(emptyTitle, emptyHint); empty.addEventListener('click', () => run(workspaceCommand('focusGroup', { groupId: group.id }).then(focusSearch))); element.append(empty);
  const view = createDocumentPane(root, { api, editorSessions, onChange: changed, onHistory: protectHistory, onError: reportError,
    onSave: (id) => run(saveDocument(id)), onImage: (bytes, name, id, bookmark) => run(insertImages(id, bookmark, () => api.insertImage(id, bytes, name))),
    onImageFiles: (files, id, bookmark) => { const paths = files.map((file) => api.droppedPath(file)).filter(Boolean); run(insertImages(id, bookmark, () => api.insertImagePaths(id, paths))); },
    onFocus: () => { if (workspace?.focusedGroupId !== group.id || workspace?.groups.find((g) => g.id === group.id)?.browsing) run(workspaceCommand('commitBrowse', { groupId: group.id }).then(() => workspaceCommand('focusGroup', { groupId: group.id }))); },
    onOpenLink: (state) => { acceptState(state); if (state.fragment) { activePane()?.setFragment(state.fragment); if (activePane()?.viewMode === 'editor') run(setView('preview')); } },
    onSyntax: (id, mode, bookmark) => run(setNoteSyntax(id, mode, bookmark)), onAction: noteAction,
    beforeRender: async (id) => { const entry = drafts.get(id); if (entry) await mirrorDraft(entry); }, getDocument: displayed,
  });
  const split = root.querySelector('[data-role=split-resizer], #split-resizer');
  resizer(split, () => settings.splitRatio, (value, delta) => { const stacked = window.innerWidth <= 1050; const size = stacked ? root.clientHeight : root.clientWidth; const next = Math.max(.2, Math.min(.8, value + delta / size)); root.style.setProperty('--split-ratio', next); return next; }, (splitRatio) => updateSettings({ splitRatio }), () => window.innerWidth <= 1050);
  groupHost.append(element);
  return { element, root, empty, view };
}
function renderWorkspace() {
  if (!workspace) return;
  const ids = new Set(workspace.groups.map((group) => group.id));
  for (const [id, pane] of panes) if (!ids.has(id)) { pane.view.dispose(); pane.element.remove(); panes.delete(id); }
  for (const [index, group] of workspace.groups.entries()) if (!panes.has(group.id)) panes.set(group.id, createPane(group, index));
  // Release ownership before attaching a document to its destination pane.
  for (const group of workspace.groups) { const pane = panes.get(group.id); if ((pane.view.document?.id ?? null) !== (group.displayedDocumentId ?? null)) pane.view.setDocument(null); }
  for (const group of workspace.groups) {
    const pane = panes.get(group.id), doc = displayed(group.displayedDocumentId);
    pane.element.dataset.focused = String(group.id === workspace.focusedGroupId);
    normalizePaneIds(pane.root, workspace.groups.indexOf(group) === 0, group.id);
    pane.root.style.setProperty('--split-ratio', settings.splitRatio);
    pane.view.applySettings(settings, group.viewMode); pane.view.setDocument(doc);
    pane.root.setAttribute('role', 'tabpanel');
    if (group.activeTabId) pane.root.setAttribute('aria-labelledby', `tab-${group.activeTabId}`); else pane.root.removeAttribute('aria-labelledby');
    pane.empty.querySelector('span').textContent = workspace.groups.indexOf(group) === 1 ? 'Search for a reference note' : 'Search for a note';
    pane.empty.querySelector('small').hidden = workspace.layout !== 'columns';
    pane.root.hidden = !doc; pane.empty.hidden = Boolean(doc);
    const expected = workspace.groups.indexOf(group);
    const ordered = [...groupHost.querySelectorAll('.document-group')];
    if (ordered[expected] !== pane.element) groupHost.append(pane.element);
  }
  current = displayed(focusedGroup()?.displayedDocumentId);
  const empty = workspace.groups.length === 1 && !current;
  $('#welcome').hidden = !empty; groupHost.hidden = empty;
  $('#workspace').dataset.layout = workspace.layout;
  $('#workspace').dataset.view = focusedGroup()?.viewMode || settings.viewMode;
  $('#toggle-documents').setAttribute('aria-pressed', String(workspace.layout === 'columns'));
  $('#toggle-documents').classList.toggle('is-dual', workspace.layout === 'columns');
  $('#toggle-documents').title = `${workspace.layout === 'columns' ? 'Return to one document' : 'Two documents'} (${formatAccelerator(binding('toggle-layout').accelerator, api.platform)})`;
  for (const button of $$('button[data-view]')) { button.setAttribute('aria-pressed', String(button.dataset.view === focusedGroup()?.viewMode)); button.disabled = workspace.layout === 'columns' && button.dataset.view === 'split'; }
  $('#compact-view').value = focusedGroup()?.viewMode || settings.viewMode;
  $('#compact-view option[value=split]').disabled = workspace.layout === 'columns';
  layoutWidths(); renderTabs(); updateStatus(); markActiveResult();
}
function updateStatus() {
  const names = { saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved changes', conflict: 'External change · edits preserved', error: 'Save failed · edits preserved' };
  $('#save-status').textContent = current ? names[current.status] || current.status : 'Ready'; $('#save-status').dataset.status = current?.status || ''; $('#save-status').title = current?.error || '';
  const words = current?.source.trim() ? current.source.trim().split(/\s+/).length : 0;
  $('#note-stats').textContent = current ? `${words.toLocaleString()} words · ${current.source.split('\n').length.toLocaleString()} lines` : '';
}
function renderTabs() {
  const key = JSON.stringify([workspace.focusedGroupId, workspace.groups.map((g) => [g.id, g.activeTabId, g.tabs.map((t) => [t.id, t.documentId, documents.get(t.documentId)?.name, displayed(t.documentId)?.status])])]);
  if (key === tabsKey) return; tabsKey = key;
  tabOverflowObserver.disconnect();
  const host = $('#document-tabs'); host.hidden = workspace.groups.length === 1 && workspace.groups[0].tabs.length <= 1; host.replaceChildren();
  workspace.groups.forEach((group, index) => {
    const block = document.createElement('div'); block.className = 'tab-group'; block.dataset.focused = String(group.id === workspace.focusedGroupId);
    const list = document.createElement('div'); list.className = 'tab-list'; list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', index ? 'Right tabs' : 'Left tabs');
    for (const tab of group.tabs) {
      const doc = displayed(tab.documentId), wrapper = document.createElement('div'); wrapper.className = 'document-tab'; wrapper.dataset.selected = String(tab.id === group.activeTabId);
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'tab'); button.id = `tab-${tab.id}`; button.setAttribute('aria-controls', panes.get(group.id).root.id); button.setAttribute('aria-selected', String(tab.id === group.activeTabId)); button.tabIndex = tab.id === group.activeTabId ? 0 : -1; button.dataset.tabId = tab.id;
      button.textContent = `${doc && ['dirty', 'saving'].includes(doc.status) ? '• ' : ''}${doc?.name || 'New tab'}`; button.title = doc?.relativePath || 'New tab'; button.addEventListener('click', () => run(workspaceCommand('selectTab', { tabId: tab.id, groupId: group.id }).then(() => activePane()?.focus())));
      button.addEventListener('contextmenu', (event) => { event.preventDefault(); showMenu(event, [{ label: 'Close tab', action: () => workspaceCommand('closeTab', { tabId: tab.id, groupId: group.id }) }, { label: 'Move to other pane', action: () => workspaceCommand('moveTab', { tabId: tab.id, groupId: group.id }) }]); });
      button.addEventListener('keydown', (event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); run(cycleTab(event.key === 'ArrowLeft' ? -1 : 1, group.id)); } });
      const close = document.createElement('button'); close.className = 'tab-close'; close.tabIndex = tab.id === group.activeTabId ? 0 : -1; close.textContent = '×'; close.setAttribute('aria-label', `Close ${doc?.name || 'new tab'}`); close.addEventListener('click', () => run(workspaceCommand('closeTab', { tabId: tab.id, groupId: group.id })));
      wrapper.append(button, close); list.append(wrapper);
    }
    const overflow = document.createElement('button'); overflow.className = 'tab-overflow'; overflow.textContent = '⋯'; overflow.hidden = true; overflow.setAttribute('aria-label', index ? 'All right tabs' : 'All left tabs'); overflow.addEventListener('click', (event) => showMenu(event, group.tabs.map((tab) => ({ label: documents.get(tab.documentId)?.relativePath || 'New tab', action: () => workspaceCommand('selectTab', { tabId: tab.id, groupId: group.id }) }))));
    block.append(list, overflow); host.append(block); tabOverflowObserver.observe(block);
  });
  tabOverflowObserver.observe(host); scheduleTabOverflow();
}
function scheduleTabOverflow() {
  if (overflowFrame !== null) return;
  overflowFrame = requestAnimationFrame(() => {
    overflowFrame = null;
    for (const block of $$('#document-tabs .tab-group')) {
      const list = block.querySelector('.tab-list'), overflow = block.querySelector('.tab-overflow');
      const needed = block.clientWidth > 0 && list.scrollWidth > block.clientWidth + 1;
      if (overflow.hidden === needed) overflow.hidden = !needed;
    }
    ensureSelectedTabs();
  });
}
const tabOverflowObserver = new ResizeObserver(scheduleTabOverflow);
document.fonts?.ready.then(scheduleTabOverflow);
function ensureSelectedTabs() { for (const tab of $$('#document-tabs [aria-selected=true]')) tab.parentElement.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
function closeMenu(restoreFocus = false) {
  const menu = $('#workspace-menu'), context = menuContext;
  menuContext = null;
  if (menu.matches(':popover-open')) menu.hidePopover();
  if (restoreFocus && context) {
    const target = context.previousFocus?.isConnected ? context.previousFocus : context.owner?.isConnected ? context.owner : $('#library-search');
    target?.focus({ preventScroll: true });
  }
}
function showMenu(event, actions) {
  const previousFocus = document.activeElement;
  closeMenu(); cancelResultBrowse();
  const menu = $('#workspace-menu'); menu.replaceChildren();
  const context = { groupId: workspace?.focusedGroupId, generation: workspace?.generation, owner: event.currentTarget, previousFocus };
  menuContext = context;
  for (const item of actions) {
    const button = document.createElement('button'); button.setAttribute('role', 'menuitem'); button.textContent = item.label;
    button.addEventListener('click', () => { closeMenu(); if (context.generation === workspace?.generation) run(item.action(context)); });
    menu.append(button);
  }
  const rect = context.owner?.getBoundingClientRect();
  const pointer = event.clientX !== 0 || event.clientY !== 0;
  menu.style.left = '0px'; menu.style.top = '0px'; menu.showPopover();
  const bounds = menu.getBoundingClientRect();
  const x = pointer ? event.clientX : rect?.left ?? 8, y = pointer ? event.clientY : rect?.bottom ?? 8;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8))}px`;
  menu.firstElementChild?.focus({ preventScroll: true });
}
function layoutWidths() {
  const columns = workspace?.layout === 'columns', total = $('#workspace').clientWidth;
  const sidebar = Math.max(220, Math.min(settings.sidebarWidth, total * .48, columns ? total - 490 : 600));
  $('#workspace').style.setProperty('--sidebar-width', `${sidebar}px`);
  const available = Math.max(480, total - sidebar - 10), ratio = Math.max(240 / available, Math.min(1 - 240 / available, workspace?.ratio || .5));
  groupHost.style.setProperty('--document-ratio', ratio);
}
function scheduleSearch(delay = 55) {
  clearTimeout(queryTimer);
  if (!library.root) { rows = []; renderResults(); return; }
  queryTimer = setTimeout(() => run(searchLibrary()), delay);
}
async function searchLibrary() {
  const sequence = ++querySequence;
  const query = $('#library-search').value;
  const response = await api.search(query);
  if (sequence !== querySequence || query !== $('#library-search').value) return;
  lastSearchQuery = query;
  const previous = rows[selected]?.id;
  rows = (response?.results ?? []).map((result) => ({ ...result, create: false }));
  const title = query.trim();
  const exact = rows.some((result) => result.title.toLocaleLowerCase() === title.toLocaleLowerCase() || result.name?.toLocaleLowerCase() === title.toLocaleLowerCase());
  if (title && !exact) rows.push({ id: '__create__', title, create: true });
  const preserved = rows.findIndex((result) => result.id === previous);
  selected = preserved >= 0 ? preserved : rows.length ? 0 : -1;
  renderResults();
  $('#library-empty').hidden = rows.length > 0;
  if (!rows.length) {
    $('#library-empty').replaceChildren();
    const heading = document.createElement('p'); heading.textContent = library.indexing ? 'Finding your notes…' : 'Start with a thought.';
    const text = document.createElement('span'); text.textContent = library.indexing ? 'You can keep writing while the library indexes.' : 'Type a title above and press Enter to create a note.';
    $('#library-empty').append(heading, text);
  }
}
function renderResults() {
  const fragment = document.createDocumentFragment();
  rows.forEach((result, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `result-${index}`;
    button.className = `result-item${result.create ? ' create-result' : ''}`;
    button.dataset.id = result.id;
    button.dataset.active = String(current?.id === result.id);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === selected));
    button.tabIndex = -1;
    const top = document.createElement('span'); top.className = 'result-top';
    const title = document.createElement('span'); title.className = 'result-title';
    if (result.create) {
      const mark = document.createElement('span'); mark.className = 'create-mark'; mark.textContent = '+';
      title.textContent = `Create “${result.title}”`;
      const hint = document.createElement('kbd'); hint.textContent = mac ? '⌘ ↵' : 'Ctrl ↵';
      top.append(mark, title, hint);
      button.title = `Create ${result.title}.${$('#create-extension').value}`;
    } else {
      title.textContent = result.title;
      const extension = document.createElement('span'); extension.className = 'result-extension'; extension.textContent = `.${result.extension}`;
      top.append(title, extension);
      button.title = result.relativePath;
    }
    button.append(top);
    if (!result.create) {
      const snippet = document.createElement('span'); snippet.className = 'result-snippet'; snippet.textContent = result.snippet || 'Empty note'; button.append(snippet);
      const folder = result.relativePath?.split(/[\\/]/).slice(0, -1).join(' / ');
      if (folder) { const path = document.createElement('span'); path.className = 'result-folder'; path.textContent = folder; button.append(path); }
    }
    button.addEventListener('click', () => { selected = index; run(chooseResult(result)); });
    button.addEventListener('contextmenu', (event) => { if (!result.create) { event.preventDefault(); showMenu(event, [{ label: 'Open in new tab', action: ({ groupId, generation }) => chooseResult(result, 'new-tab', { groupId, generation }) }]); } });
    fragment.append(button);
  });
  $('#results').replaceChildren(fragment);
  if (selected >= 0) $('#library-search').setAttribute('aria-activedescendant', `result-${selected}`); else $('#library-search').removeAttribute('aria-activedescendant');
}
function markActiveResult() {
  for (const button of $$('#results .result-item')) button.dataset.active = String(button.dataset.id === current?.id);
}
function selectResult(index) {
  if (!rows.length) return;
  selected = (index + rows.length) % rows.length;
  for (const [position, button] of $$('#results .result-item').entries()) button.setAttribute('aria-selected', String(position === selected));
  $('#library-search').setAttribute('aria-activedescendant', `result-${selected}`);
  $(`#result-${selected}`)?.scrollIntoView({ block: 'nearest' });
  browseResult(rows[selected]);
}
function cancelResultBrowse() { clearTimeout(resultBrowseTimer); resultBrowseVersion++; if (workspace) api.invalidateBrowse(workspace.focusedGroupId, workspace.generation, `${rendererNonce}:${resultBrowseVersion}`); }
function cancelSearchNavigation() { resultMoveVersion++; cancelResultBrowse(); }
async function moveResult(direction) {
  const version = ++resultMoveVersion, query = $('#library-search').value;
  if (lastSearchQuery !== query) { clearTimeout(queryTimer); await searchLibrary(); }
  if (version !== resultMoveVersion || document.activeElement !== $('#library-search') || query !== $('#library-search').value) return;
  selectResult(selected < 0 ? direction > 0 ? 0 : rows.length - 1 : selected + direction);
}
function browseResult(result) {
  cancelResultBrowse(); if (!result || result.create) return;
  const version = resultBrowseVersion, groupId = workspace?.focusedGroupId, query = $('#library-search').value;
  resultBrowseTimer = setTimeout(() => { if (version === resultBrowseVersion && query === $('#library-search').value && document.activeElement === $('#library-search')) run(workspaceCommand('open', { id: result.id, groupId, disposition: 'browse', browseToken: `${rendererNonce}:${version}` })); }, 60);
}
async function chooseResult(result, disposition = 'replace', target = {}) {
  cancelSearchNavigation(); clearMessage();
  if (result.create) await workspaceCommand('create', { title: result.title, extension: $('#create-extension').value, ...target });
  else await workspaceCommand('open', { id: result.id, disposition, ...target });
  if (result.create) { $('#library-search').value = ''; await searchLibrary(); }
  if (workspace.layout === 'single' && focusedGroup()?.viewMode === 'preview') await setView('editor');
  activePane()?.focus();
}
async function createFromSearch() { const title = $('#library-search').value.trim(); if (title) await chooseResult({ create: true, title }); else focusSearch(); }
async function chooseLibrary() {
  cancelSearchNavigation(); await flushDrafts();
  const state = await api.chooseLibrary();
  if (state) { documents.clear(); drafts.clear(); editorSessions.clear(); tabsKey = ''; workspace = null; for (const pane of panes.values()) { pane.view.dispose(); pane.element.remove(); } panes.clear(); acceptState(state); }
  focusSearch();
}
function focusSearch() { cancelSearchNavigation(); $('#library-search').focus(); $('#library-search').select(); }
async function saveDocument(id = current?.id) { if (!id) return; await flushDrafts(); acceptDocument(await api.save(id)); }
async function setNoteSyntax(id, mode, bookmark) {
  const pane = paneFor(id); pane?.setSyntaxPending(true);
  try { await navigate(async () => { acceptDocument(await api.setSyntax(id, mode)); paneFor(id)?.restoreSelection(bookmark); }); }
  finally { paneFor(id)?.setSyntaxPending(false); }
}
async function setView(mode) {
  if (!workspace) return;
  const pane = activePane(), focused = pane?.editor?.view.hasFocus, focusTarget = document.activeElement;
  if (workspace.layout === 'single') await updateSettings({ viewMode: mode });
  await workspaceCommand('setView', { mode });
  if (focused && mode !== 'preview' && activePane() === pane && document.activeElement === focusTarget) pane.focus();
}
async function insertImages(id, bookmark, operation) {
  await navigate(async () => { const result = await operation(); const pane = paneFor(id); if (!pane) throw new Error('The image was imported, but the original note is no longer displayed. Reopen it before inserting another image.'); pane.insert(id, result.text, bookmark); });
}
function noteAction(action, id) {
  dialogDocumentId = id; const doc = displayed(id); if (!doc) return;
  if (action === 'toggle-content-width') { run(updateSettings({ contentWidth: settings.contentWidth === 'full' ? 'reading' : 'full' })); return; }
  if (action === 'reveal') run(api.reveal(id));
  else if (action === 'rename') { $('#rename-input').value = doc.title; $('#rename-dialog').showModal(); $('#rename-input').focus(); $('#rename-input').select(); }
  else if (action === 'trash') { $('#trash-description').textContent = `“${doc.title}” will be moved to the system trash.`; $('#trash-dialog').showModal(); $('#trash-cancel').focus(); }
  else if (action === 'keep-both' || action === 'use-disk') run(navigate(async () => { const next = await api.resolveConflict(id, action); drafts.delete(id); if (next) { drafts.delete(next.id); acceptDocument(next); if (next.id !== id) acceptState(await api.workspace({ type: 'open', id: next.id, disposition: 'new-tab' })); } else acceptState(await api.initial()); }));
}
async function cycleTab(direction, groupId = workspace?.focusedGroupId) { const group = workspace?.groups.find((g) => g.id === groupId); if (!group?.tabs.length) return; const at = group.tabs.findIndex((t) => t.id === group.activeTabId); await workspaceCommand('selectTab', { groupId, tabId: group.tabs[(at + direction + group.tabs.length) % group.tabs.length].id }); activePane()?.focus(); }
function rememberSettingsFocus() { pendingSettingsBookmark = { at: performance.now(), value: activePane()?.bookmark() }; }
function takeSettingsBookmark() {
  const bookmark = pendingSettingsBookmark && performance.now() - pendingSettingsBookmark.at < 1000 ? pendingSettingsBookmark.value : activePane()?.bookmark();
  pendingSettingsBookmark = null; return bookmark;
}
function openSettings(focus = '#appearance-mode', bookmark = takeSettingsBookmark()) {
  if (!$('#settings-dialog').open) { settingsBookmark = bookmark; $('#settings-dialog').showModal(); }
  requestAnimationFrame(() => $(focus)?.focus());
}
async function closeSettings() { await shortcutRecorder.cancel(); let pending; do { pending = settingsQueue; await pending.catch(() => {}); } while (pending !== settingsQueue); const bookmark = settingsBookmark; settingsBookmark = null; $('#settings-dialog').close(); paneFor(bookmark?.id)?.restoreSelection(bookmark); }
$('#workspace-menu').addEventListener('keydown', (event) => {
  const buttons = [...$('#workspace-menu').querySelectorAll('button')]; const at = buttons.indexOf(document.activeElement);
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length; buttons[next]?.focus(); }
});
document.addEventListener('pointerdown', (event) => { if (menuContext && !$('#workspace-menu').contains(event.target)) closeMenu(); }, { capture: true });
document.addEventListener('focusin', (event) => { if (menuContext && !$('#workspace-menu').contains(event.target)) closeMenu(); });
window.addEventListener('blur', () => closeMenu());
document.addEventListener('keydown', (event) => {
  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    const target = event.target.closest('.result-item, [role=tab]') || (event.target === $('#library-search') ? $(`#result-${selected}:not(.create-result)`) : null);
    if (target) { event.preventDefault(); target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); }
  }
}, { capture: true });
$('#dismiss-message').addEventListener('click', clearMessage);
$('#choose-library').addEventListener('click', () => run(chooseLibrary()));
$('#welcome-choose').addEventListener('click', () => library.root ? focusSearch() : run(chooseLibrary()));
$('#library-search').addEventListener('input', () => { cancelSearchNavigation(); querySequence++; selected = -1; scheduleSearch(); });
$('#library-search').addEventListener('blur', cancelSearchNavigation);
$('#library-search').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); run(moveResult(event.key === 'ArrowDown' ? 1 : -1)); }
  if (event.key === 'Escape') { event.preventDefault(); cancelSearchNavigation(); run(workspaceCommand('cancelBrowse')); }
  if (event.key === 'Enter') {
    event.preventDefault(); cancelSearchNavigation();
    run((async () => {
      const searchCommand = resolveCommand({ key: event.key, code: event.code, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, repeat: event.repeat, isComposing: event.isComposing }, api.platform, { searchFocused: true });
      if (searchCommand === 'create-note') return createFromSearch();
      if (lastSearchQuery !== $('#library-search').value) await searchLibrary();
      if (rows[selected]) return chooseResult(rows[selected], searchCommand === 'open-new-tab' ? 'new-tab' : 'replace');
      if ($('#library-search').value.trim()) return createFromSearch();
    })());
  }
});
$('#create-extension').addEventListener('change', renderResults);
for (const button of $$('button[data-view]')) button.addEventListener('click', () => run(setView(button.dataset.view)));
$('#compact-view').addEventListener('change', (event) => run(setView(event.target.value)));
$('#toggle-documents').addEventListener('click', () => run(workspaceCommand('toggleLayout').then(() => workspace.layout === 'columns' ? focusSearch() : activePane()?.focus())));
$('#find-button').addEventListener('click', () => activePane()?.find());
$('#appearance-button').addEventListener('click', () => openSettings());
$('#settings-button').addEventListener('click', () => openSettings('#vim-mode'));
$('#toolbar-more').addEventListener('click', (event) => {
  const bookmark = takeSettingsBookmark();
  showMenu(event, [{ label: 'New tab', action: () => workspaceCommand('newTab').then(focusSearch) }, { label: 'Appearance', action: () => openSettings('#appearance-mode', bookmark) }, { label: 'Two documents', action: () => workspaceCommand('toggleLayout').then(focusSearch) }, { label: 'Keyboard shortcuts', action: () => keyboardHelp.open(true) }]);
});
$('#toolbar-more').addEventListener('pointerdown', () => { keyboardHelp.rememberFocus(); rememberSettingsFocus(); });
$('#toolbar-more').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { keyboardHelp.rememberFocus(); rememberSettingsFocus(); } });
for (const control of [$('#appearance-button'), $('#settings-button')]) control.addEventListener('pointerdown', rememberSettingsFocus);
$('#settings-dialog').addEventListener('close', () => { if ($('#settings-dialog').open) return; run(shortcutRecorder.cancel()); const bookmark = settingsBookmark; settingsBookmark = null; paneFor(bookmark?.id)?.restoreSelection(bookmark); });
$('#settings-dialog').addEventListener('cancel', (event) => { event.preventDefault(); run(closeSettings()); });
$('#close-settings').addEventListener('click', () => run(closeSettings()));
$('#settings-done').addEventListener('click', () => run(closeSettings()));
for (const control of $$('[data-setting]')) control.addEventListener('change', () => run(updateSettings({ [control.dataset.setting]: control.type === 'checkbox' ? control.checked : control.value })));
$('#save-shortcut').addEventListener('click', () => { if (shortcutCandidate !== null) run(applyShortcut(shortcutCandidate)); });
$('#disable-shortcut').addEventListener('click', () => run(applyShortcut('')));
$('#reset-shortcut').addEventListener('click', () => { shortcutCandidate = defaultSettings.globalShortcut; renderShortcutControls(); });
$('#settings-cleanup').addEventListener('click', () => run(openAssetCleanup()));
$('#rename-cancel').addEventListener('click', () => $('#rename-dialog').close());
$('#rename-form').addEventListener('submit', (event) => { event.preventDefault(); const id = dialogDocumentId, title = $('#rename-input').value.trim(); run(navigate(async () => { acceptDocument(await api.rename(id, title)); $('#rename-dialog').close(); scheduleSearch(0); })); });
$('#trash-cancel').addEventListener('click', () => $('#trash-dialog').close());
$('#trash-confirm').addEventListener('click', () => { const id = dialogDocumentId; run(navigate(async () => { const state = await api.trash(id); drafts.delete(id); documents.delete(id); $('#trash-dialog').close(); acceptState(state); scheduleSearch(0); })); });
function commandAction(event) {
  const command = typeof event === 'string' ? event : event?.command;
  if (keyboardHelp.isOpen() && !['flush', 'error'].includes(command)) return;
  if (!['flush', 'error'].includes(command)) closeMenu();
  if (shortcutRecorder.isRecording() && !['flush', 'error'].includes(command)) return;
  if (command === 'focus-search') run((async () => { if ($('#settings-dialog').open) await closeSettings(); focusSearch(); })());
  else if (command === 'new-note-search') { $('#library-search').value = ''; scheduleSearch(0); focusSearch(); }
  else if (command === 'keyboard-shortcuts') keyboardHelp.open();
  else if (command === 'settings') openSettings('#vim-mode');
  else if (command === 'choose-library') run(chooseLibrary());
  else if (command === 'asset-cleanup') run(openAssetCleanup());
  else if (command === 'find') activePane()?.find();
  else if (command === 'save') run(saveDocument());
  else if (command === 'toggle-heading') { if (activePane()?.toggleHeading()) activePane()?.focus(); }
  else if (command === 'expand-folds') { activePane()?.expandFolds(); activePane()?.focus(); }
  else if (command === 'new-tab') run(workspaceCommand('newTab').then(focusSearch));
  else if (command === 'open-new-tab' && rows[selected]) run(chooseResult(rows[selected], 'new-tab'));
  else if (command === 'close-tab') run(workspaceCommand('closeTab').then(() => current ? activePane()?.focus() : focusSearch()));
  else if (command === 'toggle-layout') run(workspaceCommand('toggleLayout').then(focusSearch));
  else if (command === 'focus-left' || command === 'focus-right') { const group = workspace?.groups[command === 'focus-left' ? 0 : 1]; if (group) run(workspaceCommand('focusGroup', { groupId: group.id }).then(() => activePane()?.focus())); }
  else if (command === 'next-tab' || command === 'previous-tab') run(cycleTab(command === 'next-tab' ? 1 : -1));
  else if (command === 'move-tab') run(workspaceCommand('moveTab').then(() => activePane()?.focus()));
  else if (command === 'cycle-view') { const modes = workspace?.layout === 'columns' ? ['editor', 'preview'] : ['editor', 'split', 'preview']; run(setView(modes[(modes.indexOf(focusedGroup()?.viewMode) + 1) % modes.length])); }
  else if (command === 'flush') void flushDrafts().then(() => api.rendererFlushed?.(event.requestId)).catch((error) => { reportError(error); api.rendererFlushed?.(event.requestId, error.message); });
  else if (command === 'error' && event.message) reportError(event.message);
}
api.onCommand(commandAction); api.onState(acceptState); api.onLibrary(acceptLibrary); api.onDocument(acceptDocument);
api.onRemoved((id) => { const entry = drafts.get(id); if (entry && entry.version > entry.ackVersion) { reportError('The note disappeared while you were editing. Your draft is preserved.'); run(mirrorDraft(entry)); } else { documents.delete(id); drafts.delete(id); } });
document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || shortcutRecorder.isRecording() || keyboardHelp.isOpen()) return;
  if (canOpenShortcutHelp(event, { recording: shortcutRecorder.isRecording(), dialogOpen: Boolean(document.querySelector('dialog[open]')) })) {
    event.preventDefault(); closeMenu(); keyboardHelp.open(); return;
  }
  const command = resolveCommand(event, api.platform);
  if (command) { event.preventDefault(); commandAction(command); }
}, { capture: true });
let dragDepth = 0;
document.addEventListener('dragenter', (event) => { if (current && event.dataTransfer?.types.includes('Files')) { dragDepth++; $('#drop-overlay').hidden = false; } });
document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', (event) => { if (event.dataTransfer?.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
document.addEventListener('drop', (event) => {
  dragDepth = 0; $('#drop-overlay').hidden = true; if (event.defaultPrevented) return;
  const files = [...(event.dataTransfer?.files ?? [])]; if (!files.length || !current) return; event.preventDefault();
  const groupId = event.target.closest('.document-group')?.dataset.groupId || workspace?.focusedGroupId;
  const pane = panes.get(groupId)?.view, id = pane?.document?.id; if (!id) return;
  const paths = files.map((file) => api.droppedPath(file)).filter(Boolean); run(insertImages(id, pane.bookmark(), () => api.insertImagePaths(id, paths)));
});
window.addEventListener('resize', () => { closeMenu(); layoutWidths(); scheduleTabOverflow(); });
function resizer(handle, get, render, persist, horizontal = () => false) {
  handle.addEventListener('pointerdown', (event) => { if (event.button !== 0) return; event.preventDefault(); const start = horizontal() ? event.clientY : event.clientX, value = get(); let latest = value; handle.setPointerCapture(event.pointerId); document.body.classList.add('resizing');
    const move = (next) => { latest = render(value, (horizontal() ? next.clientY : next.clientX) - start); };
    const done = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done); handle.removeEventListener('pointercancel', done); document.body.classList.remove('resizing'); run(persist(latest)); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done); handle.addEventListener('pointercancel', done);
  });
  handle.addEventListener('keydown', (event) => { const delta = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -15 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? 15 : 0; if (!delta) return; event.preventDefault(); run(persist(render(get(), delta))); });
}
resizer($('#sidebar-resizer'), () => settings.sidebarWidth, (value, delta) => { const next = Math.max(220, Math.min(600, value + delta)); $('#workspace').style.setProperty('--sidebar-width', `${next}px`); return next; }, (sidebarWidth) => updateSettings({ sidebarWidth }));
const divider = document.createElement('div'); divider.id = 'document-resizer'; divider.className = 'resizer'; divider.role = 'separator'; divider.tabIndex = 0; divider.setAttribute('aria-label', 'Resize documents'); divider.setAttribute('aria-orientation', 'vertical');
groupHost.append(divider);
resizer(divider, () => workspace?.ratio || .5, (value, delta) => { const width = Math.max(480, groupHost.clientWidth - 5); const next = Math.max(240 / width, Math.min(1 - 240 / width, value + delta / width)); groupHost.style.setProperty('--document-ratio', next); return next; }, (ratio) => workspaceCommand('setRatio', { ratio }));
const groupObserver = new MutationObserver(() => { const first = groupHost.querySelector('.document-group'); if (first && first.nextSibling !== divider) first.after(divider); divider.hidden = workspace?.layout !== 'columns'; });
groupObserver.observe(groupHost, { childList: true });
applySettings(settings);
run(api.initial().then(async (state) => { acceptState(state); if (library.root) focusSearch(); await api.rendererReady(); }));
