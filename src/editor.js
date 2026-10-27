import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { openSearchPanel } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { CodeMirror, vim, Vim } from '@replit/codemirror-vim';
import { orgLanguage } from './org-language.js';
import { insertOrgListItem, orgVimNewline } from './org-editing.js';

const defaultVimNewline = CodeMirror.commands.newlineAndIndent;
CodeMirror.commands.newlineAndIndent = (cm) => orgVimNewline(cm, defaultVimNewline);

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

/** Keep each note's CodeMirror state, including selection and undo history, across switches. */
export function createNoteEditor(parent, { onChange, onSave, onImage, onImageFiles, onHistory = () => {}, onError = () => {} }) {
  const language = new Compartment();
  const vimMode = new Compartment();
  const editable = new Compartment();
  const states = new Map();
  let currentId = null;
  let format = 'plain';
  let settings = { vimMode: false };
  let applying = false;
  const languageExtension = (syntax) => syntax === 'org'
    ? [orgLanguage, Prec.high(keymap.of([{ key: 'Enter', run: insertOrgListItem }]))]
    : syntax === 'markdown' ? markdown() : [];
  const state = (source = '') => EditorState.create({ doc: source, extensions: [
    vimMode.of(settings.vimMode ? vim() : []),
    basicSetup,
    language.of(languageExtension(format)),
    editable.of([EditorState.readOnly.of(false), EditorView.editable.of(true)]),
    EditorView.lineWrapping,
    editorTheme,
    syntaxHighlighting(noteHighlight),
    keymap.of([{ key: 'Mod-s', run: () => { onSave(); return true; } }]),
    EditorView.contentAttributes.of({ 'aria-label': 'Note contents', spellcheck: 'false' }),
    EditorView.updateListener.of((update) => {
      if (currentId) states.set(currentId, update.state);
      if (update.docChanged && !applying && currentId) {
        onHistory(currentId, update.startState.doc.toString());
        onChange(update.state.doc.toString());
      }
    }),
    EditorView.domEventHandlers({
      paste(event) {
        const item = [...(event.clipboardData?.items ?? [])].find((entry) => entry.kind === 'file' && entry.type.startsWith('image/'));
        if (!item || !currentId) return false;
        const file = item.getAsFile();
        if (!file) return false;
        event.preventDefault();
        const noteId = currentId;
        void file.arrayBuffer().then((bytes) => onImage(new Uint8Array(bytes), file.name || 'clipboard.png', noteId)).catch(onError);
        return true;
      },
      drop(event) {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length || !currentId) return false;
        event.preventDefault();
        onImageFiles(files, currentId);
        return true;
      },
    }),
  ] });
  const view = new EditorView({ state: state(), parent });
  Vim.defineEx('write', 'w', () => { onSave(); });

  function applySettings(next) {
    const changed = Boolean(next.vimMode) !== Boolean(settings.vimMode);
    settings = { ...settings, ...next };
    if (changed) view.dispatch({ effects: vimMode.reconfigure(settings.vimMode ? vim() : []) });
  }
  function openDocument(doc) {
    if (!doc) return;
    applying = true;
    try {
      if (currentId !== doc.id) {
        if (currentId) states.set(currentId, view.state);
        currentId = doc.id;
        format = doc.format;
        const cached = states.get(doc.id);
        view.setState(cached ?? state(doc.source));
        view.dispatch({ effects: [language.reconfigure(languageExtension(format)), vimMode.reconfigure(settings.vimMode ? vim() : [])] });
      }
      if (format !== doc.format) {
        format = doc.format;
        view.dispatch({ effects: language.reconfigure(languageExtension(format)) });
      }
      if (view.state.doc.toString() !== doc.source) {
        const anchor = Math.min(view.state.selection.main.anchor, doc.source.length);
        const head = Math.min(view.state.selection.main.head, doc.source.length);
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc.source }, selection: { anchor, head }, annotations: Transaction.addToHistory.of(false) });
      }
      states.set(doc.id, view.state);
    } finally { applying = false; }
  }
  function focusEditor() {
    view.focus();
    // macOS can clear the native range when an HTML dialog returns focus while
    // CodeMirror still has its cached range. Restore through public DOM mapping
    // so the next selectionchange cannot collapse the saved editor selection.
    const { anchor, head } = view.state.selection.main;
    const start = view.domAtPos(anchor), end = view.domAtPos(head);
    view.dom.ownerDocument.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset);
  }
  return {
    view,
    openDocument,
    selectionBookmark: () => ({ id: currentId, source: view.state.doc.toString(), selection: view.state.selection, focused: view.hasFocus }),
    restoreSelection(bookmark) {
      if (!bookmark || bookmark.id !== currentId || bookmark.source !== view.state.doc.toString()) return;
      view.dispatch({ selection: bookmark.selection, annotations: Transaction.addToHistory.of(false) });
      if (bookmark.focused) focusEditor();
    },
    updateSettings: applySettings,
    source: () => view.state.doc.toString(),
    focus: focusEditor,
    find: () => { openSearchPanel(view); view.dom.querySelector('.cm-search input')?.focus(); },
    insert: (text) => { view.dispatch(view.state.replaceSelection(text), { scrollIntoView: true }); view.focus(); },
    destroy: () => { view.destroy(); states.clear(); },
  };
}
