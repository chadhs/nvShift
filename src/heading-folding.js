// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { EditorState, Facet, Prec, Transaction } from '@codemirror/state';
import { DocInput, foldable, foldedRanges, foldEffect, foldService, language, syntaxTree, syntaxTreeAvailable, unfoldAll, unfoldEffect } from '@codemirror/language';

const formatFacet = Facet.define({ combine: (values) => values.at(-1) ?? 'plain' });
// Text objects are immutable and shared by selection-only states. One outline
// serves all gutter lines and commands until the document changes.
const outlines = new WeakMap();

function orgHeadings(doc) {
  const headings = [], stack = [];
  let offset = 0, block = null, contentEnd = 0;
  for (const text of doc.iterLines()) {
    const end = offset + text.length;
    let match;
    if (block) {
      match = /^[ \t]*#\+end_([\w-]+)\b/iu.exec(text);
      if (match?.[1].toLowerCase() === block) block = null;
    } else if ((match = /^[ \t]*#\+begin_([\w-]+)\b/iu.exec(text))) block = match[1].toLowerCase();
    else if ((match = /^(\*+)[ \t]+/u.exec(text))) {
      const level = match[1].length;
      while (stack.length && stack.at(-1).level >= level) {
        const previous = stack.pop(); previous.to = contentEnd; previous.extent = offset - 1;
      }
      const heading = { start: offset, headerEnd: end, from: end, to: end, extent: end, level, parent: stack.at(-1) ?? null };
      headings.push(heading); stack.push(heading);
    }
    if (/\S/u.test(text)) contentEnd = end;
    offset = end + 1;
  }
  while (stack.length) { const previous = stack.pop(); previous.to = contentEnd; previous.extent = doc.length; }
  return headings;
}

function markdownHeadings(state) {
  // Reuse CodeMirror's grammar and complete tree whenever available. A detached
  // complete parse prevents a fold from ending at a partial parser viewport.
  const tree = syntaxTreeAvailable(state) ? syntaxTree(state) : state.facet(language)?.parser.parse(new DocInput(state.doc));
  if (!tree) return [];
  const headings = [], parents = [];
  tree.iterate({ enter(node) {
    const match = /^(?:ATX|Setext)Heading([1-6])$/u.exec(node.name);
    if (!match) return;
    const level = Number(match[1]);
    let last = node.node, boundary = null;
    for (;;) {
      const next = last.nextSibling;
      const following = next && /^(?:ATX|Setext)Heading([1-6])$/u.exec(next.name);
      if (!next || (following && Number(following[1]) <= level)) { boundary = next; break; }
      last = next;
    }
    const line = state.doc.lineAt(node.from);
    while (parents.length && (parents.at(-1).level >= level || parents.at(-1).to < node.from)) parents.pop();
    const extent = boundary ? state.doc.lineAt(boundary.from).from - 1 : node.node.parent?.to ?? state.doc.length;
    const heading = { start: line.from, headerEnd: node.to, from: line.to, to: last.to, extent, level, parent: parents.at(-1) ?? null };
    headings.push(heading); parents.push(heading);
    return false;
  } });
  return headings;
}

function outline(state) {
  const format = state.facet(formatFacet);
  if (format === 'plain') return null;
  let cache = outlines.get(state.doc);
  if (!cache) outlines.set(state.doc, cache = new Map());
  if (cache.has(format)) return cache.get(format);
  const headings = format === 'org' ? orgHeadings(state.doc) : markdownHeadings(state);
  const result = { headings, byFrom: new Map(headings.map((heading) => [heading.from, heading])) };
  cache.set(format, result);
  return result;
}

function atPosition(state, position, containing) {
  const headings = outline(state)?.headings;
  if (!headings?.length) return null;
  let low = 0, high = headings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (headings[middle].start <= position) low = middle + 1; else high = middle;
  }
  let heading = headings[low - 1];
  if (!containing) return heading && position <= heading.headerEnd ? heading : null;
  while (heading && position > heading.extent) heading = heading.parent;
  return heading ?? null;
}

const service = foldService.of((state, start) => {
  const heading = atPosition(state, start, false);
  return heading && heading.start === start && heading.to > heading.from ? { from: heading.from, to: heading.to } : null;
});

const invalidateStructuralFolds = EditorState.transactionExtender.of((transaction) => {
  if (!transaction.docChanged || !foldedRanges(transaction.startState).size) return null;
  const old = outline(transaction.startState);
  if (!old) return null;
  const next = outline(transaction.state);
  const effects = [];
  foldedRanges(transaction.startState).between(0, transaction.startState.doc.length, (from, to) => {
    const heading = old.byFrom.get(from);
    if (!heading || heading.to !== to) return; // Preserve ordinary code folds.
    const mapped = { from: transaction.changes.mapPos(from, 1), to: transaction.changes.mapPos(to, -1) };
    const current = next?.byFrom.get(mapped.from);
    if (!current || current.to !== mapped.to || current.level !== heading.level) effects.push(unfoldEffect.of(mapped));
  });
  return effects.length ? { effects } : null;
});

/** Install beside the matching language support in the language compartment. */
export function headingFolding(format) {
  return [formatFacet.of(format), Prec.high(service), invalidateStructuralFolds];
}

/** Toggle just a heading, optionally finding the enclosing section for menus. */
export function toggleHeading(view, { containing = false } = {}) {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const heading = atPosition(state, state.selection.main.head, containing);
  if (!heading || heading.to <= heading.from) return false;
  const range = foldable(state, heading.start, state.doc.lineAt(heading.start).to);
  if (!range) return false;
  let closed = false;
  foldedRanges(state).between(range.from, range.from, (from, to) => { if (from === range.from && to === range.to) closed = true; });
  const selection = !closed && state.selection.main.head > range.from ? { anchor: heading.start } : undefined;
  view.dispatch(state.update({
    effects: (closed ? unfoldEffect : foldEffect).of(range),
    ...(selection ? { selection, scrollIntoView: true } : {}),
    annotations: Transaction.addToHistory.of(false),
  }));
  return true;
}

/** Expand both heading and pre-existing code folds without editing source. */
export function expandAllFolds(view) { return unfoldAll(view); }
