import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { codeFolding, foldable, foldedRanges, foldEffect, unfoldEffect } from '@codemirror/language';
import { history, undo } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { orgLanguage } from '../src/org-language.js';
import { headingFolding, toggleHeading, expandAllFolds } from '../src/heading-folding.js';

function editor(source, format = 'org', extensions = []) {
  let state = EditorState.create({ doc: source, extensions: [
    format === 'markdown' ? markdown() : format === 'org' ? orgLanguage : [],
    headingFolding(format), codeFolding(), history(), EditorState.allowMultipleSelections.of(true), extensions,
  ] });
  const view = {
    get state() { return state; },
    dispatch(...specs) { state = specs[0]?.state ?? state.update(...specs).state; },
    cursor(position) { view.dispatch({ selection: { anchor: position } }); },
    line(number) { view.cursor(state.doc.line(number).from); },
  };
  return view;
}
function folds(state) {
  const result = [];
  foldedRanges(state).between(0, state.doc.length, (from, to) => result.push({ from, to }));
  return result;
}
function region(state, line) { const value = state.doc.line(line); return foldable(state, value.from, value.to); }

test('Org sections use nested/skipped levels, Unicode, and nearest peer boundaries', () => {
  const source = '#+TITLE: Metadata\nIntro\n* 世界\nBody\n*** Child\nNested body\n** Next child\nChild body\n* Peer\nLast\n';
  const view = editor(source);
  assert.equal(region(view.state, 1), null);
  assert.equal(region(view.state, 2), null);
  assert.deepEqual(region(view.state, 3), { from: source.indexOf('\nBody'), to: source.indexOf('\n* Peer') });
  assert.deepEqual(region(view.state, 5), { from: source.indexOf('\nNested'), to: source.indexOf('\n** Next') });
  assert.deepEqual(region(view.state, 9), { from: source.indexOf('\nLast'), to: source.indexOf('\nLast') + 5 });
});

test('Org literal blocks hide fake headings, with case-insensitive matching end delimiters', () => {
  for (const name of ['src', 'example', 'export', 'comment', 'quote']) {
    const source = `* Real\n#+BEGIN_${name}\n* Fake\n#+END_unrelated\n** Also fake\n#+eNd_${name}\n** Child\nBody\n* Peer\nLast`;
    const view = editor(source);
    assert.equal(region(view.state, 3), null);
    assert.equal(region(view.state, 5), null);
    assert.ok(region(view.state, 7));
    assert.equal(region(view.state, 1).to, source.indexOf('\n* Peer'));
  }
});

test('an Org heading with an empty title can fold its nonempty body', () => {
  const view = editor('* \nBody\n* Peer\nLast');
  assert.ok(region(view.state, 1));
  assert.equal(toggleHeading(view), true);
  assert.deepEqual(folds(view.state), [region(view.state, 1)]);
});

test('Markdown uses native ATX and Setext structure and excludes fenced/indented examples', () => {
  const source = '# Parent\nBody\n\nTitle 世界\n---------\nChild body\n\n```md\n# Fake\n```\n\n    # Indented example\n\n# Peer\nLast';
  const view = editor(source, 'markdown');
  assert.equal(region(view.state, 1).to, source.indexOf('\n\n# Peer'));
  assert.equal(region(view.state, 4).from, source.indexOf('\n---------'));
  assert.equal(region(view.state, 9), null);
  assert.equal(region(view.state, 12), null);
  view.line(5); // The Setext underline belongs to the same heading.
  assert.equal(toggleHeading(view), true);
  assert.equal(view.state.selection.main.head, view.state.doc.line(4).from);
});

test('Tab-style toggles use the same exact range as gutters and preserve child folds', () => {
  for (const [format, source] of [['org', '* Parent\nBody\n** Child\nChild body\n* Peer\nLast'], ['markdown', '# Parent\nBody\n## Child\nChild body\n# Peer\nLast']]) {
    const view = editor(source, format);
    view.line(3); toggleHeading(view);
    const child = region(view.state, 3);
    assert.deepEqual(folds(view.state), [child]);
    view.line(1); assert.equal(toggleHeading(view), true);
    assert.deepEqual(folds(view.state), [region(view.state, 1), child]);
    assert.equal(toggleHeading(view), true);
    assert.deepEqual(folds(view.state), [child]);
    // A gutter fold effect is opened by exactly the same toggle command.
    view.dispatch({ effects: foldEffect.of(region(view.state, 1)) });
    toggleHeading(view);
    assert.deepEqual(folds(view.state), [child]);
  }
});

test('menu toggles target containing sections and move hidden cursors to the heading', () => {
  const view = editor('* Parent\nBody\n** Child\nChild body\n* Peer\nLast');
  view.line(4);
  assert.equal(toggleHeading(view), false);
  assert.equal(toggleHeading(view, { containing: true }), true);
  assert.equal(view.state.selection.main.head, view.state.doc.line(3).from);
  assert.deepEqual(folds(view.state), [region(view.state, 3)]);
  assert.equal(toggleHeading(view, { containing: true }), true);
  assert.deepEqual(folds(view.state), []);
});

test('menu containment includes trailing blank body lines without extending native fold ranges', () => {
  for (const [format, marker] of [['org', '*'], ['markdown', '#']]) {
    for (const suffix of ['', `${marker} Peer\nLast`]) {
      const source = `${marker} Heading\nBody\n\n${suffix}`;
      const view = editor(source, format);
      const expected = region(view.state, 1);
      view.cursor(source.indexOf('Body') + 'Body\n'.length);
      assert.equal(toggleHeading(view, { containing: true }), true);
      assert.deepEqual(folds(view.state), [expected]);
      // Closing on whitespace within the logical section still returns to
      // its heading even if native folding trims that whitespace from the range.
      assert.equal(view.state.selection.main.head, 0);
    }
  }
});

test('plain text, preambles, empty sections, nonempty and multiple selections do not toggle', () => {
  const plain = editor('* Heading\nBody', 'plain');
  assert.equal(toggleHeading(plain), false);
  assert.equal(region(plain.state, 1), null);
  const view = editor('Intro\n* Empty\n\n* Body\nWords\n* Final');
  assert.equal(toggleHeading(view), false);
  view.line(2); assert.equal(toggleHeading(view), false);
  view.line(6); assert.equal(toggleHeading(view), false);
  view.dispatch({ selection: { anchor: view.state.doc.line(4).from, head: view.state.doc.line(4).to } });
  assert.equal(toggleHeading(view), false);
  view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(view.state.doc.line(4).from)]) });
  assert.equal(toggleHeading(view, { containing: true }), false);
});

test('fold-only actions never edit source or consume text undo history', () => {
  const view = editor('* Heading\nOriginal');
  view.dispatch({ changes: { from: view.state.doc.length, insert: ' edit' }, userEvent: 'input' });
  view.line(1); const source = view.state.doc.toString();
  toggleHeading(view); toggleHeading(view); toggleHeading(view); expandAllFolds(view);
  assert.equal(view.state.doc.toString(), source);
  assert.equal(folds(view.state).length, 0);
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), '* Heading\nOriginal');
});

test('ordinary edits map folds; changed heading structure invalidates obsolete ranges', () => {
  for (const format of ['org', 'markdown']) {
    const marker = format === 'org' ? '*' : '#';
    const view = editor(`${marker} Heading\nBody\n${marker} Peer\nLast`, format);
    toggleHeading(view);
    view.dispatch({ changes: { from: 0, insert: 'Intro\n' } });
    assert.deepEqual(folds(view.state), [region(view.state, 2)]);
    // Changing the owning heading to body text must not keep hiding that text.
    const headingStart = view.state.doc.line(2).from;
    view.dispatch({ changes: { from: headingStart, to: headingStart + 2, insert: 'Ordinary ' } });
    assert.deepEqual(folds(view.state), []);
  }
});

test('new peer headings inside a folded section invalidate the old section extent', () => {
  const view = editor('* Heading\nBody\nMore body\n* Peer\nLast');
  toggleHeading(view);
  const position = view.state.doc.line(3).from;
  view.dispatch({ changes: { from: position, insert: '* Inserted peer\n' } });
  assert.deepEqual(folds(view.state), []);
});

test('selection navigation reveals hidden destinations', () => {
  const view = editor('* Heading\nFind hidden words\n* Peer\nLast');
  toggleHeading(view); assert.equal(folds(view.state).length, 1);
  view.cursor(view.state.doc.toString().indexOf('hidden'));
  assert.deepEqual(folds(view.state), []);
});

test('language compartment replacement removes heading services cleanly', () => {
  const compartment = new Compartment();
  const view = editor('* Heading\nBody', 'plain', [compartment.of([orgLanguage, headingFolding('org')])]);
  assert.ok(region(view.state, 1));
  expandAllFolds(view);
  view.dispatch({ effects: compartment.reconfigure(headingFolding('plain')), annotations: Transaction.addToHistory.of(false) });
  assert.equal(toggleHeading(view), false);
  assert.equal(region(view.state, 1), null);
});

test('large outlines build once and gutter lookups remain bounded', (t) => {
  for (const format of ['org', 'markdown']) {
    const marker = format === 'org' ? '*' : '#';
    const source = Array.from({ length: 10000 }, (_, index) => `${marker} Heading ${index}\nBody ${index}`).join('\n');
    const started = performance.now();
    const view = editor(source, format);
    for (let line = 1; line < view.state.doc.lines; line += 2) assert.ok(region(view.state, line));
    const elapsed = performance.now() - started;
    t.diagnostic(`${format}: 10,000 headings and gutter lookups in ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 3000, `${format} outline scan took ${elapsed} ms`);
    view.line(1); toggleHeading(view);
    const editing = performance.now();
    for (let index = 0; index < 20; index++) view.dispatch({ changes: { from: view.state.doc.length, insert: 'x' } });
    const editMs = (performance.now() - editing) / 20;
    t.diagnostic(`${format}: edits with an existing fold average ${editMs.toFixed(1)} ms`);
    assert.ok(editMs < 150, `${format} folded-outline edit took ${editMs} ms`);
  }
});
