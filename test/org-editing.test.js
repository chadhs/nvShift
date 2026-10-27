import test from 'node:test';
import assert from 'node:assert/strict';
import { Compartment, EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { history, undo } from '@codemirror/commands';
import { orgLanguage } from '../src/org-language.js';
import { insertOrgListItem, orgVimNewline } from '../src/org-editing.js';

function editor(source, { cursor = source.length, selection, extensions = [] } = {}) {
  let state = EditorState.create({
    doc: source,
    selection: selection ?? { anchor: cursor },
    extensions: [orgLanguage, history(), EditorState.allowMultipleSelections.of(true), extensions],
  });
  const transactions = [];
  return {
    get state() { return state; },
    transactions,
    dispatch(transaction) { transactions.push(transaction); state = transaction.state; },
  };
}

test('Org Enter continues bullets and exact nesting indentation', () => {
  for (const marker of ['- ', '+ ', '  - ', '\t+ ', '  * ', '    -\t']) {
    const view = editor(marker + 'First');
    assert.equal(insertOrgListItem(view), true);
    assert.equal(view.state.doc.toString(), `${marker}First\n${marker}`);
    assert.equal(view.state.selection.main.from, view.state.doc.length);
  }
});

test('Org Enter increments either numbered delimiter without changing other items', () => {
  for (const [marker, next] of [['1.', '2.'], ['9)', '10)'], ['009.', '010.'], ['99999999999999999999.', '100000000000000000000.']]) {
    const source = `  ${marker} First\n  42. Existing`;
    const view = editor(source, { cursor: source.indexOf('\n') });
    insertOrgListItem(view);
    assert.equal(view.state.doc.toString(), `  ${marker} First\n  ${next} \n  42. Existing`);
  }
});

test('Org Enter creates unchecked checkbox entries from all checkbox states', () => {
  for (const checked of [' ', 'X', 'x', '-']) {
    const view = editor(`- [${checked}] Task`);
    insertOrgListItem(view);
    assert.equal(view.state.doc.toString(), `- [${checked}] Task\n- [ ] `);
  }
  const view = editor('7) [X] Task');
  insertOrgListItem(view);
  assert.equal(view.state.doc.toString(), '7) [X] Task\n8) [ ] ');
});

test('Org Enter removes empty item markers and checkboxes while retaining indentation', () => {
  for (const item of ['- ', '- [ ] ', '+ [X]', '1)   ', '* [ ]']) {
    const view = editor(`- First\n  ${item}`);
    assert.equal(insertOrgListItem(view), true);
    assert.equal(view.state.doc.toString(), '- First\n  ');
    assert.equal(view.state.selection.main.from, view.state.doc.length);
    assert.equal(insertOrgListItem(view), false);
  }
});

test('Org Enter splits at the cursor and positions it after the new marker', () => {
  const source = '- [X] First second';
  const view = editor(source, { cursor: source.indexOf(' second') });
  insertOrgListItem(view);
  assert.equal(view.state.doc.toString(), '- [X] First\n- [ ] second');
  assert.equal(view.state.sliceDoc(view.state.selection.main.from), 'second');
  const middle = editor('- Together', { cursor: 4 });
  insertOrgListItem(middle);
  assert.equal(middle.state.doc.toString(), '- To\n- gether');
});

test('Org Enter leaves headings, ordinary text, selections and read-only buffers to default handling', () => {
  for (const source of ['* Heading', '** Nested heading', 'An ordinary paragraph', '#+TITLE: Notes', ': - Fixed width']) {
    const view = editor(source);
    assert.equal(insertOrgListItem(view), false);
    assert.equal(view.transactions.length, 0);
  }
  const selected = editor('- Selected', { selection: { anchor: 2, head: 5 } });
  assert.equal(insertOrgListItem(selected), false);
  const readOnly = editor('- Read only', { extensions: EditorState.readOnly.of(true) });
  assert.equal(insertOrgListItem(readOnly), false);
  const prefix = editor('- [X] Task', { cursor: 4 });
  assert.equal(insertOrgListItem(prefix), false);
});

test('Org Enter ignores literal blocks, including unmatched ends, and resumes after their matching end', () => {
  for (const block of ['src', 'EXAMPLE', 'export', 'comment']) {
    const source = `#+begin_${block}\n- Literal`;
    const view = editor(source);
    assert.equal(insertOrgListItem(view), false);
    const wrongEnd = editor(source + '\n#+end_quote\n- Still literal');
    assert.equal(insertOrgListItem(wrongEnd), false);
    const after = editor(source + `\n#+END_${block}\n- Real list`);
    assert.equal(insertOrgListItem(after), true);
    assert.match(after.state.doc.toString(), /- Real list\n- $/);
  }
  const quote = editor('#+begin_quote\n- Quoted item');
  assert.equal(insertOrgListItem(quote), true);
});

test('Org Enter edits multiple list cursors together or falls through without partial edits', () => {
  const source = '- One\n+ Two';
  const selection = EditorSelection.create([EditorSelection.cursor(5), EditorSelection.cursor(source.length)]);
  const view = editor(source, { selection });
  assert.equal(insertOrgListItem(view), true);
  assert.equal(view.state.doc.toString(), '- One\n- \n+ Two\n+ ');
  assert.deepEqual(view.state.selection.ranges.map((range) => range.from), [8, 17]);
  const mixed = editor('- One\nPlain', { selection });
  assert.equal(insertOrgListItem(mixed), false);
  assert.equal(mixed.transactions.length, 0);
  const sameLine = editor('- Long item', {
    selection: EditorSelection.create([EditorSelection.cursor(4), EditorSelection.cursor(8)]),
  });
  assert.equal(insertOrgListItem(sameLine), false);
});

test('Org Enter respects CRLF output and keeps a single undoable transaction', () => {
  const view = editor('- Café 日本語', { extensions: EditorState.lineSeparator.of('\r\n') });
  assert.equal(insertOrgListItem(view), true);
  assert.equal(view.state.sliceDoc(), '- Café 日本語\r\n- ');
  assert.equal(view.state.selection.main.from, view.state.doc.length);
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), '- Café 日本語');
});

test('Org Enter follows the active syntax compartment without replacing editor history', () => {
  const language = new Compartment();
  let state = EditorState.create({ doc: '- First', selection: { anchor: 7 }, extensions: [history(), language.of(orgLanguage)] });
  const view = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(insertOrgListItem(view), true);
  state = state.update({ effects: language.reconfigure([]) }).state;
  assert.equal(insertOrgListItem(view), false);
  state = state.update({ effects: language.reconfigure(orgLanguage) }).state;
  assert.equal(undo(view), true);
  assert.equal(state.doc.toString(), '- First');
});

test('Vim newline integration handles Org insert mode and retains Vim operation history annotations', () => {
  const view = editor('- First');
  let fallbackCalls = 0;
  const cm = { cm6: view, state: { vim: { insertMode: true } }, curOp: {} };
  const fallback = () => { fallbackCalls++; };
  orgVimNewline(cm, fallback);
  assert.equal(view.state.doc.toString(), '- First\n- ');
  assert.equal(fallbackCalls, 0);
  assert.equal(view.transactions[0].annotation(Transaction.userEvent), 'input.type.compose.start');
  assert.equal(undo(view), true);
  assert.equal(view.state.doc.toString(), '- First');
  cm.curOp.lastChange = {};
  orgVimNewline(cm, fallback);
  assert.equal(view.transactions.at(-1).annotation(Transaction.userEvent), 'input.type.compose');
});

test('Vim newline integration preserves normal mode, non-list and other-language behavior', () => {
  let fallbackCalls = 0;
  const fallback = () => { fallbackCalls++; };
  for (const [view, insertMode] of [[editor('- Item'), false], [editor('* Heading'), true], [editor('Plain text'), true]]) {
    orgVimNewline({ cm6: view, state: { vim: { insertMode } } }, fallback);
    assert.equal(view.transactions.length, 0);
  }
  const plain = { state: EditorState.create({ doc: '- Plain' }), dispatch() { assert.fail('Plain text must fall through'); } };
  orgVimNewline({ cm6: plain, state: { vim: { insertMode: true } } }, fallback);
  assert.equal(fallbackCalls, 4);
});
