import DOMPurify from 'dompurify';
import { version as appVersion } from '../package.json';
import { createNoteEditor } from './editor.js';
import { createAppearance } from './appearance.js';
import { createDocumentRenderer } from './renderer.js';
import { loadImages } from './images.js';
import { loadDiagrams } from './diagrams.js';
import { showMetadata } from './metadata.js';
import { resolveAnchor } from './anchors.js';
import { createSearch } from './search.js';
import { createAssetCleanupUI } from './asset-cleanup-ui.js';
import './style.css';

const api = window.nvShift;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const mac = api.platform === 'darwin';
document.documentElement.dataset.platform = api.platform;
$('#app-version').textContent = `v${appVersion}`;
$('#search-shortcut').textContent = mac ? '⌘ L' : 'Ctrl L';

const defaultSettings = { mode: 'system', light: 'light', dark: 'dark', sansSerifHeadings: false, contentWidth: 'reading', filenameHeadings: false, vimMode: false, viewMode: 'editor', defaultExtension: 'md', txtSyntax: 'plain', globalShortcut: 'CommandOrControl+Shift+Space', sidebarWidth: 300, splitRatio: .5 };
let settings = { ...defaultSettings };
let library = { root: null, count: 0, indexing: false, errors: [] };
let current = null;
let parsed = null;
let shortcut = null;
let rows = [];
let selected = -1;
let querySequence = 0;
let lastSearchQuery = null;
let queryTimer;
let resultBrowseTimer;
let resultBrowseVersion = 0;
let resultMoveVersion = 0;
let navigationQueue = Promise.resolve();
let settingsQueue = Promise.resolve();
let settingsVersion = 0;
let pendingSettings = 0;
let settingsBookmark = null, pendingSettingsBookmark = null;
let switchingLibrary = false;
let previewTimer;
let previewGeneration = 0;
let previewKey = '';
let headingTimer;
let headingGeneration = 0;
let resolvedHeading = null;
let pendingFragment = null;
const drafts = new Map();
const previewScroll = new Map();
const historyWrites = new Set();
let historyError = null;
const documentRenderer = createDocumentRenderer();
const headingRenderer = createDocumentRenderer();
const previewFinder = createSearch(() => $('#document'), $('#preview-scroller'), (text) => { $('#preview-search-count').textContent = text; });

function reportError(reason) {
  const message = typeof reason === 'string' ? reason : reason?.message || 'This action could not be completed.';
  $('#message-text').textContent = message;
  $('#message').hidden = false;
}
function run(promise) { return Promise.resolve(promise).catch(reportError); }
function clearMessage() { $('#message').hidden = true; $('#message-text').textContent = ''; }
const appearance = createAppearance({
  windowTheme: (theme) => api.windowTheme(theme),
  onTheme: () => { previewKey = ''; if (current) schedulePreview(0); },
});
const editor = createNoteEditor($('#editor'), {
  onChange: changed,
  onHistory: (id, source) => {
    const operation = api.protectAssetHistory(id, source).catch((error) => { historyError = error; }).finally(() => historyWrites.delete(operation));
    historyWrites.add(operation);
  },
  onSave: () => run(saveCurrent()),
  onImage: (bytes, name, id) => run(insertImage(bytes, name, id)),
  onImageFiles: (files, id) => run(insertDroppedImages(files, id)),
  onError: reportError,
});
const assetCleanup = createAssetCleanupUI({
  api, onError: reportError,
  beforeScan: async () => {
    cancelSearchNavigation();
    await navigationQueue.catch(() => {});
    await flushDrafts();
    if (!library.root) throw new Error('Choose a notes folder first.');
    if (historyError) throw new Error(`Undo protection could not be recorded. Restart nvShift before cleaning assets. ${historyError.message}`);
  },
});

function applySettings(next) {
  const previousDefault = settings.defaultExtension;
  settings = { ...defaultSettings, ...next };
  appearance.apply(settings);
  editor.updateSettings(settings);
  $('#workspace').dataset.view = settings.viewMode;
  $('#workspace').style.setProperty('--sidebar-width', `${Math.max(220, Math.min(520, settings.sidebarWidth))}px`);
  $('#workspace').style.setProperty('--split-ratio', Math.max(.2, Math.min(.8, settings.splitRatio)));
  for (const button of $$('[data-view]')) {
    if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.view === settings.viewMode));
  }
  for (const control of $$('[data-setting]')) {
    const value = settings[control.dataset.setting];
    if (control.type === 'checkbox') control.checked = Boolean(value); else control.value = value;
  }
  if (document.activeElement !== $('#global-shortcut')) $('#global-shortcut').value = settings.globalShortcut;
  if (previousDefault !== settings.defaultExtension || !$('#create-extension').value) $('#create-extension').value = settings.defaultExtension;
  $('#vim-status').hidden = !settings.vimMode;
  $('#editor-mode').textContent = settings.vimMode ? 'Vim editing' : 'Editing';
  const fullWidth = settings.contentWidth === 'full';
  $('#toggle-content-width').setAttribute('aria-pressed', String(fullWidth));
  $('#toggle-content-width').textContent = fullWidth ? 'Reading width' : 'Full width';
  $('#toggle-content-width').title = fullWidth ? 'Use reading width' : 'Use full width';
  $('#toggle-content-width').setAttribute('aria-label', $('#toggle-content-width').title);
  updateHeadingChrome();
  scheduleHeading(0);
  if (current && settings.viewMode !== 'editor') schedulePreview(0);
  if (current && settings.viewMode !== 'preview') requestAnimationFrame(() => editor.view.requestMeasure());
}
function updateSettings(patch) {
  const version = ++settingsVersion;
  pendingSettings++;
  applySettings({ ...settings, ...patch });
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
  $('#shortcut-status').textContent = next.error ? 'Shortcut unavailable' : next.registered ? `${formatShortcut(next.accelerator)} to search` : 'Shortcut not assigned';
  $('#shortcut-status').dataset.error = String(Boolean(next.error));
  $('#shortcut-status').title = next.error || next.accelerator || '';
  $('#shortcut-error').textContent = next.error || '';
}
function formatShortcut(value = '') {
  return value.replace(/CommandOrControl|CmdOrCtrl/g, mac ? '⌘' : 'Ctrl').replace(/Command/g, '⌘').replace(/Control/g, 'Ctrl').replace(/Shift/g, mac ? '⇧' : 'Shift').replace(/Alt|Option/g, mac ? '⌥' : 'Alt').replace(/\+/g, mac ? '' : '+');
}
function acceptState(state) {
  if (!state) return;
  if (state.settings && !pendingSettings) applySettings(state.settings);
  acceptShortcut(state.shortcut);
  if (state.library) acceptLibrary(state.library);
  if (!switchingLibrary && Object.hasOwn(state, 'document')) {
    if (state.document) {
      if (!current || current.id !== state.document.id) activateDocument(state.document);
      else acceptDocument(state.document);
    } else if (current) {
      const entry = drafts.get(current.id);
      if (entry && entry.version > entry.ackVersion) {
        current = { ...current, status: 'conflict', error: 'The note or linked folder disappeared while you were typing. Your draft is preserved.' };
        updateDocumentChrome();
        void mirrorDraft(entry).catch(reportError);
      } else clearDocument();
    }
  }
  if (state.error) reportError(state.error);
}

function draftFor(doc) {
  let entry = drafts.get(doc.id);
  if (!entry) {
    const version = Number(doc.clientVersion) || 0;
    entry = { id: doc.id, source: doc.source, version, ackVersion: version, baseRevision: doc.revision, snapshot: doc, sending: null, error: null };
    drafts.set(doc.id, entry);
  }
  return entry;
}
function changed(source) {
  if (!current) return;
  const entry = draftFor(current);
  entry.source = source;
  entry.version++;
  entry.error = null;
  current = { ...current, source, status: current.status === 'conflict' ? 'conflict' : 'dirty' };
  updateDocumentChrome();
  scheduleHeading();
  void mirrorDraft(entry).catch(reportError);
  schedulePreview();
  scheduleSearch();
}
async function mirrorDraft(entry) {
  if (entry.sending) return entry.sending;
  if (entry.ackVersion >= entry.version) return entry.snapshot;
  entry.sending = (async () => {
    while (entry.ackVersion < entry.version) {
      const version = entry.version;
      const source = entry.source;
      const doc = await api.updateBuffer(entry.id, source, version, entry.baseRevision);
      if (!doc) throw new Error('The note could not be updated. Your current editor contents are still available.');
      entry.ackVersion = Math.max(entry.ackVersion, version);
      entry.baseRevision = doc.revision;
      entry.snapshot = doc;
      entry.error = null;
      if (current?.id === entry.id) acceptDocument(doc, { fromMirror: true });
    }
    return entry.snapshot;
  })().catch((reason) => {
    entry.error = reason;
    if (current?.id === entry.id) { current = { ...current, status: 'error', error: reason.message }; updateDocumentChrome(); }
    throw reason;
  }).finally(() => { entry.sending = null; });
  return entry.sending;
}
async function flushDrafts() {
  await settingsQueue.catch(() => {});
  await Promise.all([...historyWrites]);
  await Promise.all([...drafts.values()].filter((entry) => entry.ackVersion < entry.version || entry.sending).map(async (entry) => {
    await mirrorDraft(entry);
    if (entry.ackVersion < entry.version) await mirrorDraft(entry);
  }));
}
function acceptDocument(doc, { fromMirror = false } = {}) {
  if (!doc || current?.id !== doc.id) return;
  const entry = draftFor(doc);
  const serverVersion = Number(doc.clientVersion) || 0;
  const hasNewerLocal = entry.version > serverVersion;
  if (Number.isFinite(current.revision) && Number.isFinite(doc.revision) && doc.revision < current.revision && !fromMirror) return;
  if (hasNewerLocal) {
    current = { ...current, ...doc, source: entry.source, status: ['conflict', 'error'].includes(doc.status) ? doc.status : 'dirty' };
    updateDocumentChrome();
    scheduleHeading();
    return;
  }
  entry.version = Math.max(entry.version, serverVersion);
  entry.ackVersion = Math.max(entry.ackVersion, serverVersion);
  entry.baseRevision = doc.revision;
  entry.snapshot = doc;
  entry.source = doc.source;
  const changedSource = editor.source() !== doc.source;
  const changedFormat = current.format !== doc.format;
  current = doc;
  if (changedSource || changedFormat) editor.openDocument(doc);
  updateDocumentChrome();
  scheduleHeading();
  if (changedSource || changedFormat || previewKey !== previewIdentity(doc)) schedulePreview();
  markActiveResult();
}
function activateDocument(doc) {
  if (!doc) { clearDocument(); return; }
  if (current) previewScroll.set(current.id, $('#preview-scroller').scrollTop);
  const changedNote = current?.id !== doc.id;
  const entry = draftFor(doc);
  if (entry.version > (Number(doc.clientVersion) || 0)) doc = { ...doc, source: entry.source, status: doc.status === 'conflict' ? 'conflict' : 'dirty' };
  else {
    entry.source = doc.source;
    entry.version = Math.max(entry.version, Number(doc.clientVersion) || 0);
    entry.ackVersion = entry.version;
    entry.baseRevision = doc.revision;
    entry.snapshot = doc;
  }
  current = doc;
  editor.openDocument(doc);
  $('#welcome').hidden = true;
  $('#note-workspace').hidden = false;
  if (changedNote) {
    previewGeneration++;
    documentRenderer.cancel();
    parsed = null;
    previewKey = '';
    previewFinder.clear();
    $('#content').replaceChildren();
    $('#document-title').textContent = doc.title;
    $('#metadata').replaceChildren();
    $('#outline').replaceChildren();
    $('#preview-error').hidden = true;
    $('#preview-scroller').scrollTop = previewScroll.get(doc.id) ?? 0;
  }
  updateDocumentChrome();
  scheduleHeading(0);
  markActiveResult();
  schedulePreview(0);
  requestAnimationFrame(() => editor.view.requestMeasure());
}
function clearDocument() {
  clearTimeout(headingTimer);
  headingGeneration++;
  headingRenderer.cancel();
  resolvedHeading = null;
  previewGeneration++;
  documentRenderer.cancel();
  current = null;
  parsed = null;
  previewKey = '';
  $('#welcome').hidden = false;
  $('#note-workspace').hidden = true;
  $('#save-status').textContent = 'Ready when you are.';
  $('#save-status').removeAttribute('data-status');
  $('#note-stats').textContent = '';
  $('#preview-find').hidden = true;
  previewFinder.clear();
  markActiveResult();
}
function updateDocumentChrome() {
  if (!current) return;
  updateHeadingChrome();
  const folder = current.relativePath?.split(/[\\/]/).slice(0, -1).join(' / ');
  $('#note-folder').textContent = folder || 'NOTES';
  $('#note-path').textContent = current.name;
  $('#note-path').title = current.path;
  $('#syntax-label').textContent = current.format === 'org' ? 'ORG' : current.format === 'markdown' ? 'MARKDOWN' : 'PLAIN TEXT';
  $('#syntax-label').title = current.extension === 'txt' ? '.txt content syntax is set for this notes folder.' : `.${current.extension} file`;
  $('#conflict-banner').hidden = current.status !== 'conflict';
  const names = { saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved changes', conflict: 'External change · edits preserved', error: 'Save failed · edits preserved' };
  $('#save-status').textContent = names[current.status] || current.status || 'Ready';
  $('#save-status').dataset.status = current.status;
  $('#save-status').title = current.error || '';
  const words = current.source.trim() ? current.source.trim().split(/\s+/).length : 0;
  const lines = current.source.split('\n').length;
  $('#note-stats').textContent = `${words.toLocaleString()} words · ${lines.toLocaleString()} ${lines === 1 ? 'line' : 'lines'}`;
}

// Titles use the current buffer even in Editor view. Filename identity remains
// main-owned; this cache only controls presentation and never renames a note.
function headingMatches(doc, includeSource = true) {
  return resolvedHeading?.id === doc?.id && resolvedHeading?.name === doc?.name
    && resolvedHeading?.format === doc?.format && (!includeSource || resolvedHeading.source === doc.source);
}
function updateHeadingChrome() {
  if (!current) return;
  const fallback = current.title || current.name;
  const title = !settings.filenameHeadings && current.format !== 'plain' && headingMatches(current, false)
    ? resolvedHeading.title : fallback;
  $('#note-title').textContent = title;
  $('#document-title').textContent = title;
}
function scheduleHeading(delay = 180) {
  clearTimeout(headingTimer);
  const generation = ++headingGeneration;
  headingRenderer.cancel();
  if (!current || settings.filenameHeadings || current.format === 'plain' || headingMatches(current)) return;
  const doc = { ...current };
  headingTimer = setTimeout(async () => {
    try {
      const result = await headingRenderer.render(doc, { titleOnly: true });
      if (generation !== headingGeneration || current?.id !== doc.id || current?.name !== doc.name
        || current?.format !== doc.format || current?.source !== doc.source || settings.filenameHeadings) return;
      resolvedHeading = { id: doc.id, name: doc.name, format: doc.format, source: doc.source, title: result.title };
      updateHeadingChrome();
    } catch {
      // A parser failure cannot prevent writing or leave another note's title.
      if (generation !== headingGeneration || current?.id !== doc.id) return;
      resolvedHeading = null;
      updateHeadingChrome();
    }
  }, delay);
}
function previewIdentity(doc) {
  return `${doc.id}:${doc.name}:${doc.format}:${doc.revision}:${document.documentElement.dataset.theme}:${settings.filenameHeadings}`;
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
function cancelResultBrowse() {
  clearTimeout(resultBrowseTimer);
  resultBrowseVersion++;
}
function cancelSearchNavigation() {
  resultMoveVersion++;
  cancelResultBrowse();
}
async function moveResult(direction) {
  const version = ++resultMoveVersion;
  const query = $('#library-search').value;
  if (lastSearchQuery !== query) {
    clearTimeout(queryTimer);
    await searchLibrary();
  }
  if (version !== resultMoveVersion || query !== $('#library-search').value
    || lastSearchQuery !== query || document.activeElement !== $('#library-search')) return;
  const next = selected < 0 ? (direction > 0 ? 0 : rows.length - 1) : selected + direction;
  selectResult(next);
}
function browseResult(result) {
  cancelResultBrowse();
  if (!result || result.create) return;
  const version = resultBrowseVersion;
  const query = $('#library-search').value;
  const root = library.root;
  const isCurrent = () => version === resultBrowseVersion && library.root === root
    && query === $('#library-search').value && rows[selected]?.id === result.id
    && document.activeElement === $('#library-search');
  // Coalesce held arrow keys. Browsing uses the same save queue as opening a
  // note, but keeps the current view and never moves focus out of search.
  resultBrowseTimer = setTimeout(() => run(navigate(async () => {
    if (!isCurrent()) return;
    const doc = await api.open(result.id);
    if (isCurrent()) activateDocument(doc);
    else if (current) {
      // A blur, edited query, or newer navigation can supersede an IPC open.
      // Restore main-process selection to the note still displayed; a queued
      // Enter or newer arrow request will then open its own target normally.
      await api.open(current.id);
    }
  })), 60);
}
function navigate(operation) {
  const next = navigationQueue.catch(() => {}).then(async () => { await flushDrafts(); return operation(); });
  navigationQueue = next;
  return next;
}
async function chooseResult(result) {
  cancelSearchNavigation();
  return navigate(async () => {
    clearMessage();
    const doc = result.create ? await api.create(result.title, $('#create-extension').value) : await api.open(result.id);
    activateDocument(doc);
    if (result.create) { $('#library-search').value = ''; selected = -1; await searchLibrary(); }
    if (settings.viewMode === 'preview') await updateSettings({ viewMode: 'editor' });
    editor.focus();
  });
}
async function createFromSearch() {
  const title = $('#library-search').value.trim();
  if (!title) { focusSearch(); return; }
  return chooseResult({ create: true, title });
}
async function chooseLibrary() {
  cancelSearchNavigation();
  await navigate(async () => {
    if (current) previewScroll.set(current.id, $('#preview-scroller').scrollTop);
    switchingLibrary = true;
    clearDocument();
    try {
      const state = await api.chooseLibrary();
      if (state) drafts.clear();
      switchingLibrary = false;
      acceptState(state ?? await api.initial());
      focusSearch();
    } catch (reason) {
      switchingLibrary = false;
      acceptState(await api.initial());
      throw reason;
    }
  });
}
function focusSearch() { cancelSearchNavigation(); $('#library-search').focus(); $('#library-search').select(); }
async function saveCurrent() {
  if (!current) return;
  const id = current.id;
  await flushDrafts();
  const doc = await api.save(id);
  if (current?.id === id && doc) acceptDocument(doc);
}

function schedulePreview(delay = 220) {
  clearTimeout(previewTimer);
  if (!current || settings.viewMode === 'editor') return;
  previewTimer = setTimeout(() => run(renderPreview()), delay);
}
async function renderPreview() {
  const id = current?.id;
  if (!id || settings.viewMode === 'editor') return;
  const entry = drafts.get(id);
  if (entry) await mirrorDraft(entry);
  if (current?.id !== id) return;
  const doc = entry?.snapshot ?? current;
  if (entry && entry.version > entry.ackVersion) { schedulePreview(); return; }
  const key = previewIdentity(doc);
  const filenameHeadings = settings.filenameHeadings;
  if (previewKey === key && parsed) return;
  const generation = ++previewGeneration;
  documentRenderer.cancel();
  $('#preview-error').hidden = true;
  try {
    const result = await documentRenderer.render(doc, { filenameHeadings });
    if (generation !== previewGeneration || current?.id !== id || current.source !== doc.source
      || current.name !== doc.name || current.format !== doc.format || settings.filenameHeadings !== filenameHeadings) return;
    const top = $('#preview-scroller').scrollTop;
    parsed = result;
    previewKey = key;
    if (!filenameHeadings) resolvedHeading = { id: doc.id, name: doc.name, format: doc.format, source: doc.source, title: result.title };
    updateHeadingChrome();
    $('#subtitle').textContent = result.subtitle || '';
    $('#subtitle').hidden = !result.subtitle;
    showMetadata($('#metadata'), result);
    // Keep the copied reader's sanitization at the DOM boundary. Images are loaded only through verified resources.
    $('#content').innerHTML = DOMPurify.sanitize(result.html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'img', 'video', 'audio', 'iframe', 'form'], FORBID_ATTR: ['style'] });
    $('#outline').replaceChildren();
    for (const heading of result.outline ?? []) {
      const button = document.createElement('button'); button.textContent = heading.label || 'Untitled heading';
      button.style.paddingLeft = `${Math.min(heading.level - 1, 5) * 12 + 4}px`;
      button.addEventListener('click', () => document.getElementById(heading.id)?.scrollIntoView({ block: 'start' }));
      $('#outline').append(button);
    }
    if (!result.outline?.length) $('#outline').textContent = 'No headings in this note.';
    $('#preview-scroller').scrollTop = top;
    const isCurrent = () => generation === previewGeneration && current?.id === id;
    void loadImages($('#content'), result.images ?? [], id, (_id, reference) => api.image(doc.id, doc.revision, reference), isCurrent, () => {}).catch(reportError);
    void loadDiagrams($('#content'), result.diagrams ?? [], doc, (...args) => api.diagram(...args), isCurrent, () => {}).catch(reportError);
    if ($('#preview-search').value) previewFinder.search($('#preview-search').value, true, true, false);
    if (pendingFragment) {
      const target = resolveAnchor(result, pendingFragment);
      if (target) document.getElementById(target)?.scrollIntoView({ block: 'start' });
      else reportError(`Heading not found: ${pendingFragment.value || ''}`);
      pendingFragment = null;
    }
  } catch (reason) {
    if (generation !== previewGeneration || current?.id !== id || current.source !== doc.source
      || current.name !== doc.name || current.format !== doc.format || settings.filenameHeadings !== filenameHeadings) return;
    parsed = null;
    previewKey = '';
    $('#content').replaceChildren();
    $('#preview-error').textContent = `Preview unavailable: ${reason.message}\nYour source remains available in the editor.`;
    $('#preview-error').hidden = false;
  }
}
async function setView(mode) {
  if (!['editor', 'split', 'preview'].includes(mode)) return;
  const focused = document.activeElement, noteId = current?.id, searchVersion = resultMoveVersion;
  await updateSettings({ viewMode: mode });
  if (mode !== 'preview' && current?.id === noteId && document.activeElement === focused && resultMoveVersion === searchVersion) editor.focus();
}
function showFind() {
  if (!current) return;
  if (settings.viewMode !== 'preview') { editor.find(); return; }
  $('#preview-find').hidden = false;
  $('#preview-search').focus(); $('#preview-search').select();
}
function closePreviewFind() { $('#preview-find').hidden = true; $('#preview-search').value = ''; previewFinder.clear(); $('#preview-scroller').focus(); }
async function insertImage(bytes, name, targetId = current?.id) {
  if (!current) throw new Error('Open a note before inserting an image.');
  return navigate(async () => {
    if (current?.id !== targetId) throw new Error('Return to the original note and paste the image again.');
    const result = await api.insertImage(targetId, bytes, name);
    editor.insert(result.text);
  });
}
async function insertDroppedImages(files, targetId = current?.id) {
  if (!current) throw new Error('Open a note before dropping images.');
  const paths = files.map((file) => api.droppedPath(file)).filter(Boolean);
  if (!paths.length) throw new Error('The dropped image paths could not be read.');
  return navigate(async () => {
    if (current?.id !== targetId) throw new Error('Return to the original note and drop the images again.');
    const result = await api.insertImagePaths(targetId, paths);
    editor.insert(result.text);
  });
}
function openSettings(focus = '#appearance-mode') {
  if (!$('#settings-dialog').open) {
    settingsBookmark = pendingSettingsBookmark && performance.now() - pendingSettingsBookmark.at < 1000
      ? pendingSettingsBookmark.value : editor.selectionBookmark();
    pendingSettingsBookmark = null;
    $('#settings-dialog').showModal();
  }
  requestAnimationFrame(() => $(focus)?.focus());
}
async function closeSettings() {
  let pending;
  do { pending = settingsQueue; await pending.catch(() => {}); } while (pending !== settingsQueue);
  const bookmark = settingsBookmark; settingsBookmark = null;
  $('#settings-dialog').close();
  editor.restoreSelection(bookmark);
}

$('#dismiss-message').addEventListener('click', clearMessage);
$('#choose-library').addEventListener('click', () => run(chooseLibrary()));
$('#welcome-choose').addEventListener('click', () => library.root ? focusSearch() : run(chooseLibrary()));
$('#library-search').addEventListener('input', () => { cancelSearchNavigation(); querySequence++; selected = -1; scheduleSearch(); });
$('#library-search').addEventListener('blur', cancelSearchNavigation);
$('#library-search').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); run(moveResult(event.key === 'ArrowDown' ? 1 : -1)); }
  if (event.key === 'Enter') {
    event.preventDefault();
    cancelSearchNavigation();
    const directCreate = event.metaKey || event.ctrlKey;
    run((async () => {
      if (directCreate) return createFromSearch();
      if (lastSearchQuery !== $('#library-search').value) await searchLibrary();
      if (rows[selected]) return chooseResult(rows[selected]);
      if ($('#library-search').value.trim()) return createFromSearch();
    })());
  }
});
$('#create-extension').addEventListener('change', () => { renderResults(); });
for (const button of $$('button[data-view]')) button.addEventListener('click', () => run(setView(button.dataset.view)));
$('#find-button').addEventListener('click', showFind);
$('#appearance-button').addEventListener('click', () => openSettings());
$('#settings-button').addEventListener('click', () => openSettings('#vim-mode'));
for (const control of [$('#appearance-button'), $('#settings-button')]) control.addEventListener('pointerdown', () => {
  pendingSettingsBookmark = { at: performance.now(), value: editor.selectionBookmark() };
});
$('#settings-dialog').addEventListener('close', () => {
  if ($('#settings-dialog').open) return;
  const bookmark = settingsBookmark; settingsBookmark = null;
  editor.restoreSelection(bookmark);
});
$('#settings-dialog').addEventListener('cancel', (event) => { event.preventDefault(); void closeSettings(); });
$('#close-settings').addEventListener('click', closeSettings);
$('#settings-done').addEventListener('click', closeSettings);
for (const control of $$('[data-setting]')) control.addEventListener('change', () => run(updateSettings({ [control.dataset.setting]: control.type === 'checkbox' ? control.checked : control.value })));
$('#save-shortcut').addEventListener('click', () => run(updateSettings({ globalShortcut: $('#global-shortcut').value.trim() })));
$('#global-shortcut').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#save-shortcut').click(); } });
$('#toggle-content-width').addEventListener('click', () => run(updateSettings({ contentWidth: settings.contentWidth === 'full' ? 'reading' : 'full' })));
$('#toggle-outline').addEventListener('click', () => { const hidden = !$('#outline').hidden; $('#outline').hidden = hidden; $('#toggle-outline').setAttribute('aria-expanded', String(!hidden)); });
$('#reveal-note').addEventListener('click', () => current && run(api.reveal(current.id)));
$('#rename-note').addEventListener('click', () => {
  if (!current) return;
  $('#rename-input').value = current.title;
  $('#rename-dialog').showModal();
  $('#rename-input').focus(); $('#rename-input').select();
});
$('#rename-cancel').addEventListener('click', () => $('#rename-dialog').close());
$('#rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!current) return;
  const id = current.id, title = $('#rename-input').value.trim();
  run(navigate(async () => { const doc = await api.rename(id, title); $('#rename-dialog').close(); activateDocument(doc); scheduleSearch(0); }));
});
$('#trash-note').addEventListener('click', () => { if (current) { $('#trash-description').textContent = `“${current.title}” will be moved to the system trash.`; $('#trash-dialog').showModal(); $('#trash-cancel').focus(); } });
$('#trash-cancel').addEventListener('click', () => $('#trash-dialog').close());
$('#trash-confirm').addEventListener('click', () => {
  if (!current) return;
  const id = current.id;
  run(navigate(async () => { const state = await api.trash(id); drafts.delete(id); $('#trash-dialog').close(); clearDocument(); acceptState(state); scheduleSearch(0); }));
});
for (const [selector, action] of [['#keep-both', 'keep-both'], ['#use-disk', 'use-disk']]) $(selector).addEventListener('click', () => {
  if (!current) return;
  const id = current.id;
  run(navigate(async () => { const doc = await api.resolveConflict(id, action); drafts.delete(id); if (doc) { drafts.delete(doc.id); activateDocument(doc); } else clearDocument(); scheduleSearch(0); }));
});
$('#content').addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || !current || !parsed) return;
  event.preventDefault();
  if (link.dataset.documentLink !== undefined) {
    const reference = parsed.links?.[Number(link.dataset.documentLink)];
    if (!reference) return;
    run(navigate(async () => {
      const response = await api.openLink(current.id, current.revision, reference);
      if (response?.document) activateDocument(response.document);
      if (response?.fragment) { pendingFragment = response.fragment; if (settings.viewMode === 'editor') await updateSettings({ viewMode: 'preview' }); previewKey = ''; schedulePreview(0); }
    }));
  } else {
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) document.getElementById(href.slice(1))?.scrollIntoView({ block: 'start' });
    else if (href) run(api.external(href));
  }
});
$('#preview-search').addEventListener('input', () => previewFinder.search($('#preview-search').value));
$('#preview-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); previewFinder.search($('#preview-search').value, !event.shiftKey); } else if (event.key === 'Escape') { event.preventDefault(); closePreviewFind(); } });
$('#preview-find-next').addEventListener('click', () => previewFinder.search($('#preview-search').value, true));
$('#preview-find-prev').addEventListener('click', () => previewFinder.search($('#preview-search').value, false));
$('#preview-find-close').addEventListener('click', closePreviewFind);

function commandAction(event) {
  const command = typeof event === 'string' ? event : event?.command;
  if (command === 'focus-search') focusSearch();
  else if (command === 'settings') openSettings('#vim-mode');
  else if (command === 'choose-library') run(chooseLibrary());
  else if (command === 'asset-cleanup') assetCleanup.open();
  else if (command === 'find') showFind();
  else if (command === 'save') run(saveCurrent());
  else if (command === 'cycle-view') run(setView(['editor', 'split', 'preview'][(['editor', 'split', 'preview'].indexOf(settings.viewMode) + 1) % 3]));
  else if (command === 'flush') {
    void flushDrafts().then(() => api.rendererFlushed?.(event.requestId)).catch((reason) => { reportError(reason); api.rendererFlushed?.(event.requestId, reason.message); });
  } else if (command === 'error' && event.message) reportError(event.message);
}
api.onCommand(commandAction);
api.onDocument((doc) => { if (doc?.id === current?.id) acceptDocument(doc); });
api.onLibrary((state) => acceptLibrary(state));
api.onState(acceptState);
document.addEventListener('keydown', (event) => {
  const modifier = mac ? event.metaKey : event.ctrlKey;
  if (!modifier || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'l') { event.preventDefault(); focusSearch(); }
  else if (key === 's' && !event.shiftKey) { event.preventDefault(); run(saveCurrent()); }
  else if (key === 'n' && !event.shiftKey) { event.preventDefault(); $('#library-search').value = ''; scheduleSearch(0); focusSearch(); }
  else if (key === ',' && !event.shiftKey) { event.preventDefault(); openSettings('#vim-mode'); }
  else if (key === 'f' && !event.shiftKey) { event.preventDefault(); showFind(); }
  else if (key === 'p' && event.shiftKey) { event.preventDefault(); commandAction('cycle-view'); }
}, { capture: true });
let dragDepth = 0;
document.addEventListener('dragenter', (event) => { if (current && event.dataTransfer?.types.includes('Files')) { event.preventDefault(); dragDepth++; $('#drop-overlay').hidden = false; } });
document.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragleave', (event) => { if (event.dataTransfer?.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; } });
document.addEventListener('drop', (event) => {
  dragDepth = 0; $('#drop-overlay').hidden = true;
  if (event.defaultPrevented) return;
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length) { event.preventDefault(); run(insertDroppedImages(files)); }
});

function setupResizer(selector, getValue, render, persist, horizontal = () => false) {
  const handle = $(selector);
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = horizontal() ? event.clientY : event.clientX;
    const original = getValue();
    let latest = original;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const move = (next) => { const position = horizontal() ? next.clientY : next.clientX; latest = render(original, position - start); };
    const done = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done); handle.removeEventListener('pointercancel', done); document.body.classList.remove('resizing'); run(persist(latest)); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done); handle.addEventListener('pointercancel', done);
  });
  handle.addEventListener('keydown', (event) => {
    const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : 0;
    if (!direction) return;
    event.preventDefault(); const latest = render(getValue(), direction * 15); run(persist(latest));
  });
}
setupResizer('#sidebar-resizer', () => settings.sidebarWidth, (original, delta) => {
  const value = Math.round(Math.max(220, Math.min(520, window.innerWidth * .48, original + delta)));
  $('#workspace').style.setProperty('--sidebar-width', `${value}px`); return value;
}, (sidebarWidth) => updateSettings({ sidebarWidth }));
setupResizer('#split-resizer', () => settings.splitRatio, (original, delta) => {
  const stacked = window.innerWidth <= 1050;
  const size = stacked ? $('#panes').clientHeight : $('#panes').clientWidth;
  const value = Math.max(.2, Math.min(.8, original + delta / size));
  $('#workspace').style.setProperty('--split-ratio', value); if (stacked) $('#editor-pane').style.flexBasis = `${value * 100}%`; return value;
}, (splitRatio) => updateSettings({ splitRatio }), () => window.innerWidth <= 1050);

applySettings(settings);
run(api.initial().then((state) => { acceptState(state); if (library.root) focusSearch(); }));
