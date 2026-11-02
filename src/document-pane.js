import DOMPurify from 'dompurify';
import { createNoteEditor } from './editor.js';
import { createDocumentRenderer } from './renderer.js';
import { loadImages } from './images.js';
import { loadDiagrams } from './diagrams.js';
import { showMetadata } from './metadata.js';
import { resolveAnchor } from './anchors.js';

// CSS highlights belong to a document, so combine independently owned pane
// ranges instead of clearing another pane's Find results.
const searches = new Map();
function publishSearches() {
  const values = [...searches.values()];
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
  CSS.highlights.set('search-results', new Highlight(...values.flatMap((item) => item.ranges)));
  CSS.highlights.set('search-active', new Highlight(...values.flatMap((item) => item.active ? [item.active] : [])));
}
function createPaneSearch(root, scroller, report) {
  const key = Symbol('pane-search');
  let ranges = [], query = '', active = -1;
  function clear() { ranges = []; query = ''; active = -1; searches.delete(key); publishSearches(); report(''); }
  function search(value, forward = true, rebuild = false, scroll = true) {
    if (!value) { clear(); return; }
    const previous = value === query ? active : -1;
    if (value !== query || rebuild) {
      clear(); query = value;
      const walker = document.createTreeWalker(root(), NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => node.parentElement.closest('.eyebrow, [data-role="metadata"], #metadata, .document-end, details:not([open]) pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      const nodes = []; let text = '', node;
      while ((node = walker.nextNode())) { nodes.push({ node, start: text.length }); text += node.textContent; }
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'giu'); let match;
      while ((match = pattern.exec(text)) && ranges.length < 1000) {
        const first = nodes.findLast((item) => item.start <= match.index), last = nodes.findLast((item) => item.start < match.index + match[0].length);
        if (!first || !last) continue;
        const range = new Range(); range.setStart(first.node, match.index - first.start); range.setEnd(last.node, match.index + match[0].length - last.start); ranges.push(range);
      }
    }
    if (!ranges.length) { searches.set(key, { ranges, active: null }); publishSearches(); report('0 matches'); return; }
    active = rebuild && previous >= 0 ? Math.min(previous, ranges.length - 1) : (active + (forward ? 1 : -1) + ranges.length) % ranges.length;
    searches.set(key, { ranges, active: ranges[active] }); publishSearches();
    if (scroll) { const rect = ranges[active].getBoundingClientRect(); scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3; }
    report(`${active + 1} / ${ranges.length}${ranges.length === 1000 ? '+' : ''}`);
  }
  return { clear, search, snapshot: () => ({ query, active }), restore(saved) { if (!saved?.query) { clear(); return; } search(saved.query, true, true, false); active = Math.max(0, Math.min(saved.active ?? 0, ranges.length - 1)); searches.set(key, { ranges, active: ranges[active] }); publishSearches(); } };
}

/** A document's visible editor/preview. Storage and workspace navigation stay in the shell. */
export function createDocumentPane(root, {
  api, editorSessions = new Map(), onChange = () => {}, onSave = () => {}, onImage = () => {}, onImageFiles = () => {},
  onHistory = () => {}, onError = () => {}, onFocus = () => {}, onOpenLink = () => {}, onSyntax = () => {}, onAction = () => {},
  beforeRender = async () => {}, getDocument = () => null,
}) {
  const $ = (role) => root.querySelector(`[data-role="${role}"], #${role}`);
  const groupId = () => root.dataset.groupId || root.dataset.group || root.id;
  const docRenderer = createDocumentRenderer(), headingRenderer = createDocumentRenderer();
  let current = null, settings = {}, viewMode = 'editor', parsed = null, previewKey = '', generation = 0, headingGeneration = 0;
  let previewTimer, headingTimer, resolvedHeading = null, pendingFragment = null, syntaxPending = false, disposed = false, syntaxBookmark = null;
  let renderedTheme = document.documentElement.dataset.theme;
  const editor = createNoteEditor($('editor'), {
    sessions: editorSessions, onChange: (source, id) => {
      if (current?.id === id) { current = { ...current, source, status: current.status === 'conflict' ? 'conflict' : 'dirty' }; chrome(); scheduleHeading(); schedulePreview(); }
      onChange(id, source);
    }, onSave, onImage, onImageFiles, onHistory, onError,
  });
  const finder = createPaneSearch(() => $('document'), $('preview-scroller'), (text) => { $('preview-search-count').textContent = text; });
  const listen = (role, event, callback) => $(role)?.addEventListener(event, callback);
  const run = (value) => Promise.resolve(value).catch(onError);
  function scrollTo(id) { root.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' }); }
  function remember() {
    if (!current) return;
    const session = editorSessions.get(current.id);
    if (session) { session.previewScroll = $('preview-scroller').scrollTop; session.previewFind = finder.snapshot(); session.previewFindOpen = !$('preview-find').hidden; }
  }
  function matches(doc, includeSource = true) { return resolvedHeading?.id === doc?.id && resolvedHeading?.name === doc?.name && resolvedHeading?.format === doc?.format && (!includeSource || resolvedHeading.source === doc.source); }
  function headingChrome() {
    if (!current) return;
    const title = !settings.filenameHeadings && current.format !== 'plain' && matches(current, false) ? resolvedHeading.title : current.title || current.name;
    if ($('note-title').textContent !== title) $('note-title').textContent = title;
    if ($('document-title').textContent !== title) $('document-title').textContent = title;
  }
  function chrome() {
    if (!current) return;
    headingChrome();
    $('note-folder').textContent = current.relativePath?.split(/[\\/]/).slice(0, -1).join(' / ') || 'NOTES';
    $('note-path').textContent = current.name; $('note-path').title = current.path;
    const name = current.format === 'org' ? 'Org' : current.format === 'markdown' ? 'Markdown' : 'Plain text';
    const text = current.extension === 'txt', syntax = $('syntax-select');
    $('syntax-label').hidden = text; $('syntax-label').textContent = name.toUpperCase(); $('syntax-label').title = `.${current.extension} file`;
    syntax.hidden = !text; syntax.disabled = syntaxPending;
    const mode = current.syntaxMode === 'fixed' ? 'auto' : current.syntaxMode || 'auto';
    if (syntax.value !== mode) syntax.value = mode;
    const option = syntax.querySelector('[value="auto"]'), label = `Automatic · ${name}`;
    if (option.textContent !== label) option.textContent = label;
    syntax.title = current.syntaxWarning || (mode !== 'auto' ? 'Syntax selected for this note. Choose Automatic to detect its contents.' : 'Automatically detected syntax. Reopen this note to detect changes, or choose a syntax.');
    $('conflict-banner').hidden = current.status !== 'conflict';
  }
  async function latest() {
    const id = current?.id; if (!id) return null;
    await beforeRender(id);
    if (disposed || current?.id !== id) return null;
    const doc = getDocument(id) || current;
    return doc.source === current.source ? doc : null;
  }
  function scheduleHeading(delay = 180) {
    clearTimeout(headingTimer); const token = ++headingGeneration; headingRenderer.cancel();
    if (!current || settings.filenameHeadings) return;
    headingTimer = setTimeout(() => run((async () => {
      const doc = await latest(); if (!doc || token !== headingGeneration) return;
      if (doc.format === 'plain' || matches(doc)) { headingChrome(); return; }
      const result = await headingRenderer.render(doc, { titleOnly: true });
      if (token !== headingGeneration || current?.id !== doc.id || current.source !== doc.source || current.format !== doc.format || settings.filenameHeadings) return;
      resolvedHeading = { id: doc.id, name: doc.name, format: doc.format, source: doc.source, title: result.title }; headingChrome();
    })().catch(() => { /* A title parser cannot stop editing or replace another note's title. */ })), delay);
  }
  function identity(doc) { return `${doc.id}:${doc.name}:${doc.format}:${doc.revision}:${document.documentElement.dataset.theme}:${settings.filenameHeadings}`; }
  function schedulePreview(delay = 220) { clearTimeout(previewTimer); if (current && viewMode !== 'editor') previewTimer = setTimeout(() => run(render()), delay); }
  async function render() {
    const doc = await latest(); if (!doc || viewMode === 'editor') return;
    const key = identity(doc), filenameHeadings = settings.filenameHeadings;
    if (key === previewKey && parsed) return;
    const token = ++generation; docRenderer.cancel(); $('preview-error').hidden = true;
    const isCurrent = () => !disposed && generation === token && current?.id === doc.id && current.source === doc.source && current.format === doc.format && settings.filenameHeadings === filenameHeadings;
    try {
      const result = await docRenderer.render(doc, { filenameHeadings }); if (!isCurrent()) return;
      const top = $('preview-scroller').scrollTop; parsed = result; previewKey = key;
      if (!filenameHeadings) resolvedHeading = { id: doc.id, name: doc.name, format: doc.format, source: doc.source, title: result.title };
      headingChrome(); $('subtitle').textContent = result.subtitle || ''; $('subtitle').hidden = !result.subtitle; showMetadata($('metadata'), result);
      $('content').innerHTML = DOMPurify.sanitize(result.html, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'img', 'video', 'audio', 'iframe', 'form'], FORBID_ATTR: ['style'] });
      $('outline').replaceChildren();
      for (const heading of result.outline ?? []) {
        const button = document.createElement('button'); button.textContent = heading.label || 'Untitled heading'; button.style.paddingLeft = `${Math.min(heading.level - 1, 5) * 12 + 4}px`;
        button.addEventListener('click', () => scrollTo(heading.id)); $('outline').append(button);
      }
      if (!result.outline?.length) $('outline').textContent = 'No headings in this note.';
      $('preview-scroller').scrollTop = top;
      void loadImages($('content'), result.images ?? [], doc.id, (_id, reference) => api.image(doc.id, doc.revision, reference), isCurrent, () => {}).catch(onError);
      void loadDiagrams($('content'), result.diagrams ?? [], doc, (...args) => api.diagram(...args), isCurrent, () => {}).catch(onError);
      if ($('preview-search').value) finder.search($('preview-search').value, true, true, false);
      if (pendingFragment) { const target = resolveAnchor(result, pendingFragment); if (target) scrollTo(target); else onError(new Error(`Heading not found: ${pendingFragment.value || ''}`)); pendingFragment = null; }
    } catch (error) {
      if (!isCurrent()) return;
      parsed = null; previewKey = ''; $('content').replaceChildren(); $('preview-error').textContent = `Preview unavailable: ${error.message}\nYour source remains available in the editor.`; $('preview-error').hidden = false;
    }
  }
  function setDocument(doc) {
    if (current?.id === doc?.id && doc) return updateDocument(doc);
    remember(); current = doc; ++generation; ++headingGeneration; clearTimeout(previewTimer); clearTimeout(headingTimer); docRenderer.cancel(); headingRenderer.cancel(); finder.clear(); parsed = null; previewKey = ''; resolvedHeading = null; pendingFragment = null;
    root.classList.toggle('is-empty', !doc);
    if (!doc) { editor.detach(); $('content').replaceChildren(); return; }
    editor.openDocument(doc); $('content').replaceChildren(); $('outline').replaceChildren(); $('metadata').replaceChildren(); $('preview-error').hidden = true;
    const session = editorSessions.get(doc.id); $('preview-scroller').scrollTop = session?.previewScroll || 0;
    $('preview-search').value = session?.previewFind?.query || ''; $('preview-find').hidden = !session?.previewFindOpen;
    chrome(); scheduleHeading(0); schedulePreview(0); requestAnimationFrame(() => editor.view.requestMeasure());
  }
  function updateDocument(doc) {
    if (!doc || current?.id !== doc.id) return;
    const changed = current.source !== doc.source || current.format !== doc.format || current.name !== doc.name;
    current = doc;
    if (editor.source() !== doc.source || changed) editor.openDocument(doc);
    chrome(); if (changed) scheduleHeading();
    if (changed || previewKey !== identity(doc)) schedulePreview();
  }
  function applySettings(next, mode = next.viewMode || viewMode) {
    const previous = settings, previousMode = viewMode; settings = { ...settings, ...next }; viewMode = mode; root.dataset.view = mode;
    $('editor-pane').hidden = mode === 'preview'; $('preview-pane').hidden = mode === 'editor'; $('split-resizer').hidden = mode !== 'split';
    editor.updateSettings(settings); $('editor-mode').textContent = settings.vimMode ? 'Vim editing' : 'Editing';
    const full = settings.contentWidth === 'full'; $('toggle-content-width').textContent = full ? 'Reading width' : 'Full width'; $('toggle-content-width').setAttribute('aria-pressed', String(full));
    const theme = document.documentElement.dataset.theme;
    const changedPresentation = previous.filenameHeadings !== settings.filenameHeadings || renderedTheme !== theme;
    renderedTheme = theme;
    if (changedPresentation) { previewKey = ''; scheduleHeading(0); }
    headingChrome(); if (previousMode !== mode || changedPresentation) schedulePreview(0);
    if (previousMode !== mode || previous.vimMode !== settings.vimMode || previous.contentWidth !== settings.contentWidth) requestAnimationFrame(() => editor.view.requestMeasure());
  }
  function focus() { if (!current) return; if (viewMode === 'preview') $('preview-scroller').focus(); else editor.focus(); }
  function closeFind() { $('preview-find').hidden = true; $('preview-search').value = ''; finder.clear(); $('preview-scroller').focus(); }
  root.addEventListener('focusin', () => run(onFocus(groupId())));
  root.addEventListener('pointerdown', () => run(onFocus(groupId())));
  listen('syntax-select', 'pointerdown', () => { syntaxBookmark = editor.selectionBookmark(); });
  listen('syntax-select', 'change', () => { if (current) run(onSyntax(current.id, $('syntax-select').value, syntaxBookmark || editor.selectionBookmark())); syntaxBookmark = null; });
  for (const [role, action] of [['rename-note', 'rename'], ['reveal-note', 'reveal'], ['trash-note', 'trash'], ['keep-both', 'keep-both'], ['use-disk', 'use-disk']]) listen(role, 'click', () => { if (current) run(onAction(action, current.id)); });
  listen('toggle-content-width', 'click', () => run(onAction('toggle-content-width', current?.id)));
  listen('toggle-outline', 'click', () => { const hidden = !$('outline').hidden; $('outline').hidden = hidden; $('toggle-outline').setAttribute('aria-expanded', String(!hidden)); });
  listen('content', 'click', (event) => {
    const link = event.target.closest('a'); if (!link || !current || !parsed) return; event.preventDefault();
    if (link.dataset.documentLink !== undefined) {
      const reference = parsed.links?.[Number(link.dataset.documentLink)]; if (!reference) return;
      const doc = current; run(api.openLink(doc.id, doc.revision, reference).then((response) => onOpenLink(response, groupId())));
    } else { const href = link.getAttribute('href'); if (href?.startsWith('#')) scrollTo(href.slice(1)); else if (href) run(api.external(href)); }
  });
  listen('preview-search', 'input', () => finder.search($('preview-search').value));
  listen('preview-search', 'keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); finder.search($('preview-search').value, !event.shiftKey); } else if (event.key === 'Escape') { event.preventDefault(); closeFind(); } });
  listen('preview-find-next', 'click', () => finder.search($('preview-search').value, true));
  listen('preview-find-prev', 'click', () => finder.search($('preview-search').value, false));
  listen('preview-find-close', 'click', closeFind);
  return {
    setDocument, updateDocument, applySettings, focus, render,
    get editor() { return editor; }, get document() { return current; }, get viewMode() { return viewMode; },
    find() { if (!current) return; if (viewMode !== 'preview') editor.find(); else { $('preview-find').hidden = false; $('preview-search').focus(); $('preview-search').select(); } },
    toggleHeading: () => editor.toggleHeading(), expandFolds: () => editor.expandFolds(), bookmark: () => editor.selectionBookmark(), restoreSelection: (saved) => editor.restoreSelection(saved),
    source: () => editor.source(), insert(id, text, saved) { if (current?.id !== id) throw new Error('Return to the original note and paste the image again.'); editor.insert(text, saved); },
    setSyntaxPending(value) { syntaxPending = Boolean(value); chrome(); },
    setFragment(fragment) { pendingFragment = fragment; previewKey = ''; schedulePreview(0); },
    dispose() { remember(); disposed = true; ++generation; ++headingGeneration; clearTimeout(previewTimer); clearTimeout(headingTimer); docRenderer.cancel(); headingRenderer.cancel(); finder.clear(); editor.destroy(); },
  };
}
