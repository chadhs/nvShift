// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { EditorSelection } from '@codemirror/state';
import { orgLanguage } from './org-language.js';

function inLiteralBlock(doc, lineNumber) {
  let block = null;
  for (const line of doc.iterLines(1, lineNumber)) {
    if (block) {
      const end = /^[ \t]*#\+end_(\w+)\b/i.exec(line);
      if (end?.[1].toLowerCase() === block) block = null;
    } else {
      const begin = /^[ \t]*#\+begin_(src|example|export|comment)\b/i.exec(line);
      if (begin) block = begin[1].toLowerCase();
    }
  }
  return block !== null;
}

function incrementMarker(marker) {
  const digits = [...marker.slice(0, -1)];
  let index = digits.length - 1;
  while (index >= 0 && digits[index] === '9') digits[index--] = '0';
  if (index >= 0) digits[index] = String(Number(digits[index]) + 1);
  else digits.unshift('1');
  return digits.join('') + marker.at(-1);
}

/** Continue an Org list without changing surrounding items or literal blocks. */
export function insertOrgListItem({ state, dispatch }, { userEvent = 'input' } = {}) {
  if (state.readOnly || state.selection.ranges.some((range) => !range.empty)) return false;
  const handledLines = new Set();
  let refused = false;
  const changes = state.changeByRange((range) => {
    const position = range.from;
    const line = state.doc.lineAt(position);
    const marker = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)(?:\[([ Xx-])\]([ \t]+|$))?/.exec(line.text);
    if (!orgLanguage.isActiveAt(state, position) || !marker
      || (marker[2] === '*' && !marker[1]) || position < line.from + marker[0].length
      || handledLines.has(line.number) || inLiteralBlock(state.doc, line.number)) {
      refused = true;
      return { range };
    }
    handledLines.add(line.number);
    const indentation = marker[1];
    if (!line.text.slice(marker[0].length).trim()) {
      const cursor = line.from + indentation.length;
      return { changes: { from: cursor, to: line.to }, range: EditorSelection.cursor(cursor) };
    }
    const bullet = /^\d/.test(marker[2]) ? incrementMarker(marker[2]) : marker[2];
    const checkbox = marker[4] === undefined ? '' : '[ ] ';
    const prefix = indentation + bullet + marker[3] + checkbox;
    let from = position;
    while (from > line.from + marker[0].length && /[ \t]/.test(state.sliceDoc(from - 1, from))) from--;
    let to = position;
    while (to < line.to && /[ \t]/.test(state.sliceDoc(to, to + 1))) to++;
    const insert = state.lineBreak + prefix;
    // CodeMirror stores line boundaries as one position even with CRLF output.
    const cursor = from + 1 + prefix.length;
    return { changes: { from, to, insert }, range: EditorSelection.cursor(cursor) };
  });
  // A mixed selection must fall through as a whole, never partially edit lists.
  if (refused) return false;
  dispatch(state.update(changes, { scrollIntoView: true, userEvent }));
  return true;
}

/** Keep Vim's native newline path for normal mode and non-Org documents. */
export function orgVimNewline(cm, fallback) {
  if (cm.state.vim?.insertMode && insertOrgListItem({
    state: cm.cm6.state,
    dispatch: (transaction) => cm.cm6.dispatch(transaction),
  }, { userEvent: cm.curOp && !cm.curOp.lastChange ? 'input.type.compose.start' : 'input.type.compose' })) return;
  return fallback(cm);
}
