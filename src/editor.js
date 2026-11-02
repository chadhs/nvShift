import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentMore, indentLess } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { CodeMirror, getCM, vim, Vim } from '@replit/codemirror-vim';
import { orgLanguage } from './org-language.js';
import { insertOrgListItem, orgVimNewline } from './org-editing.js';
import { headingFolding, toggleHeading, expandAllFolds } from './heading-folding.js';

const defaultVimNewline = CodeMirror.commands.newlineAndIndent;
CodeMirror.commands.newlineAndIndent = (cm) => orgVimNewline(cm, defaultVimNewline);

const editorTab = (event, view) => event.key === 'Tab' && event.target === view.contentDOM
  && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing && !view.composing;

const noteHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--syntax-title)', fontWeight: '650' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.keyword, tags.meta], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.monospace], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.atom, tags.bool], color: 'var(--syntax-number)' },
  { tag: [tags.link, tags.url], color: 'var(--syntax-title)', textDecoration: 'underline' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.list, tags.punctuation], color: 'var(--muted)' },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--paper)', color: 'var(--ink)', fontSize: '14px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace", lineHeight: '1.8' },
  '.cm-content': { padding: '22px 0 64px', minHeight: '100%', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 28px 0 14px' },
  '.cm-gutters': { backgroundColor: 'var(--paper)', color: 'var(--muted)', border: 'none', padding: '0 0 0 14px' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '24px', fontSize: '11px', opacity: '.65' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
  '&.cm-focused .cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--chrome) 55%, transparent)' },
  '.cm-fat-cursor': { backgroundColor: 'var(--accent)', color: 'var(--primary-ink)', outline: 'none' },
  '&:not(.cm-focused) .cm-fat-cursor': { backgroundColor: 'transparent', outline: '1px solid var(--accent)', color: 'var(--ink)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-wash)' },
  '.cm-panels': { backgroundColor: 'var(--chrome)', color: 'var(--ink)' },
  '.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--search-wash)', color: 'var(--search-ink)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--search-active-wash)', color: 'var(--search-active-ink)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-wash)' },
  '.cm-tooltip': { border: '1px solid var(--line-strong)', backgroundColor: 'var(--chrome)', color: 'var(--ink)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--inset)', border: '1px solid var(--line)', color: 'var(--muted)' },
  '.cm-vim-panel': { backgroundColor: 'var(--chrome)', color: 'var(--ink)', padding: '5px 12px', fontFamily: 'monospace' },
});

// Extensions route through the current view rather than the pane that created
// a cached state. A document can move panes without losing history or commands.
const editorContexts = new WeakMap();
Vim.defineEx('write', 'w', (cm) => {
  const owner = editorContexts.get(cm.cm6);
  if (owner?.id()) owner.onSave(owner.id());
});

export function createNoteEditor(parent, {
  onChange = () => {}, onSave = () => {}, onImage = () => {}, onImageFiles = () => {},
  onHistory = () => {}, onError = () => {}, sessions = new Map(),
}) {
  let currentId = null, applying = false, settings = { vimMode: false };
  const languageExtension = (syntax) => [headingFolding(syntax), syntax === 'org'
    ? [orgLanguage, Prec.high(keymap.of([{ key: 'Enter', run: insertOrgListItem }]))]
    : syntax === 'markdown' ? markdown() : []];
  function state(source, format, session) {
    return EditorState.create({ doc: source, extensions: [
      Prec.highest(EditorView.domEventHandlers({ keydown: (event, target) => {
        if (!editorTab(event, target)) return false;
        const owner = editorContexts.get(target);
        if (owner?.settings().vimMode) {
          const mode = getCM(target)?.state.vim, input = mode?.inputState;
          if (!mode || mode.insertModeReturn || mode.visualMode || input?.operator || input?.keyBuffer?.length
            || input?.prefixRepeat?.length || input?.motionRepeat?.length || input?.registerName) return false;
          if (!mode.insertMode) { if (!event.shiftKey) toggleHeading(target); return true; }
        } else if (!event.shiftKey && toggleHeading(target)) return true;
        (event.shiftKey ? indentLess : indentMore)(target); return true;
      } })),
      Prec.lowest(EditorView.domEventHandlers({ keydown: (event, target) => editorTab(event, target) })),
      session.vimMode.of(settings.vimMode ? vim() : []), basicSetup,
      session.language.of(languageExtension(format)),
      EditorState.readOnly.of(false), EditorView.editable.of(true), EditorView.lineWrapping,
      editorTheme, syntaxHighlighting(noteHighlight),
      keymap.of([{ key: 'Mod-s', run: (target) => { const owner = editorContexts.get(target); owner?.onSave(owner.id()); return true; } }]),
      EditorView.contentAttributes.of({ 'aria-label': 'Note contents', spellcheck: 'false' }),
      EditorView.updateListener.of((update) => {
        const owner = editorContexts.get(update.view), id = owner?.id();
        if (!id) return;
        const entry = sessions.get(id);
        if (entry?.owner && entry.owner !== owner) return;
        if (entry) entry.state = update.state;
        if (update.docChanged && !owner.applying()) {
          owner.onHistory(id, update.startState.doc.toString());
          owner.onChange(update.state.doc.toString(), id);
        }
      }),
      EditorView.domEventHandlers({
        paste(event, target) {
          const owner = editorContexts.get(target), id = owner?.id();
          const item = [...(event.clipboardData?.items ?? [])].find((value) => value.kind === 'file' && value.type.startsWith('image/'));
          if (!item || !id) return false;
          const file = item.getAsFile(); if (!file) return false;
          event.preventDefault();
          const bookmark = owner.bookmark();
          void file.arrayBuffer().then((bytes) => owner.onImage(new Uint8Array(bytes), file.name || 'clipboard.png', id, bookmark)).catch(owner.onError);
          return true;
        },
        drop(event, target) {
          const owner = editorContexts.get(target), id = owner?.id();
          const files = [...(event.dataTransfer?.files ?? [])];
          if (!files.length || !id) return false;
          event.preventDefault(); owner.onImageFiles(files, id, owner.bookmark()); return true;
        },
      }),
    ] });
  }
  const empty = { language: new Compartment(), vimMode: new Compartment() };
  const view = new EditorView({ state: state('', 'plain', empty), parent });
  function bookmark() { return { id: currentId, source: view.state.doc.toString(), selection: view.state.selection, focused: view.hasFocus }; }
  const context = { id: () => currentId, settings: () => settings, applying: () => applying, bookmark, onChange, onSave, onImage, onImageFiles, onHistory, onError };
  editorContexts.set(view, context);
  function remember() {
    if (!currentId) return;
    const session = sessions.get(currentId);
    if (session && (!session.owner || session.owner === context)) { session.state = view.state; session.scrollTop = view.scrollDOM.scrollTop; session.scrollLeft = view.scrollDOM.scrollLeft; if (session.owner === context) session.owner = null; }
  }
  function configure(session) {
    view.dispatch({ effects: [session.language.reconfigure(languageExtension(session.format)), session.vimMode.reconfigure(settings.vimMode ? vim() : [])] });
  }
  function openDocument(doc) {
    if (!doc) return detach();
    applying = true;
    try {
      if (currentId !== doc.id) {
        remember(); currentId = doc.id;
        let session = sessions.get(doc.id);
        if (!session) {
          session = { language: new Compartment(), vimMode: new Compartment(), format: doc.format, scrollTop: 0, scrollLeft: 0 };
          session.state = state(doc.source, doc.format, session); sessions.set(doc.id, session);
        }
        session.owner = context;
        const previousFormat = session.format; session.format = doc.format;
        view.setState(session.state);
        if (previousFormat !== doc.format) expandAllFolds(view);
        configure(session);
        view.scrollDOM.scrollTop = session.scrollTop || 0; view.scrollDOM.scrollLeft = session.scrollLeft || 0;
      }
      const session = sessions.get(doc.id);
      if (session.format !== doc.format) { expandAllFolds(view); session.format = doc.format; configure(session); }
      if (view.state.doc.toString() !== doc.source) {
        expandAllFolds(view);
        const anchor = Math.min(view.state.selection.main.anchor, doc.source.length), head = Math.min(view.state.selection.main.head, doc.source.length);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc.source }, selection: { anchor, head }, annotations: Transaction.addToHistory.of(false) });
      }
      session.state = view.state;
    } finally { applying = false; }
  }
  function detach() {
    remember(); currentId = null;
    applying = true; try { view.setState(state('', 'plain', empty)); } finally { applying = false; }
  }
  function focusEditor() {
    view.focus();
    const { anchor, head } = view.state.selection.main;
    const start = view.domAtPos(anchor), end = view.domAtPos(head);
    view.dom.ownerDocument.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  }
  return {
    view, openDocument, detach,
    selectionBookmark: bookmark,
    restoreSelection(saved) {
      if (!saved || saved.id !== currentId || saved.source !== view.state.doc.toString()) return false;
      view.dispatch({ selection: saved.selection, annotations: Transaction.addToHistory.of(false) });
      if (saved.focused) focusEditor(); return true;
    },
    updateSettings(next) {
      const changed = Boolean(next.vimMode) !== Boolean(settings.vimMode); settings = { ...settings, ...next };
      if (changed && currentId) view.dispatch({ effects: sessions.get(currentId).vimMode.reconfigure(settings.vimMode ? vim() : []) });
    },
    toggleHeading: () => toggleHeading(view, { containing: true }), expandFolds: () => expandAllFolds(view),
    source: () => view.state.doc.toString(), focus: focusEditor,
    find: () => { openSearchPanel(view); view.dom.querySelector('.cm-search input')?.focus(); },
    insert(text, saved) {
      if (saved && !this.restoreSelection({ ...saved, focused: false })) throw new Error('The insertion location changed. Paste the image again.');
      view.dispatch({ ...view.state.replaceSelection(text), scrollIntoView: true }); view.focus();
    },
    destroy: () => { remember(); editorContexts.delete(view); view.destroy(); },
  };
}
