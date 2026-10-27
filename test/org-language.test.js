import test from 'node:test';
import assert from 'node:assert/strict';
import { StringStream } from '@codemirror/language';
import { orgStreamParser } from '../src/org-language.js';

function tokens(line, state = orgStreamParser.startState()) {
  const stream = new StringStream(line, 4, 2);
  const result = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const style = orgStreamParser.token(stream, state);
    assert.ok(stream.pos > stream.start, 'The tokenizer always consumes input');
    result.push({ text: stream.current(), style });
  }
  return result;
}

test('Org highlights headings, task states, links and common emphasis', () => {
  const heading = tokens('** TODO A heading :work:');
  assert.ok(heading.some((token) => token.text === '** ' && token.style === 'heading'));
  assert.ok(heading.some((token) => token.text === 'TODO' && token.style === 'keyword'));
  assert.ok(heading.some((token) => token.text === 'A' && token.style === 'heading'));
  assert.ok(heading.some((token) => token.text === ':work:' && token.style === 'tag'));
  assert.equal(tokens('[[file:assets/image.png]]')[0].style, 'link');
  assert.equal(tokens('*bold* /italic/ =code= ~verbatim~')[0].style, 'strong');
  assert.ok(tokens('*bold* /italic/ =code= ~verbatim~').some((token) => token.style === 'monospace'));
});

test('Org source and example blocks retain state and end without leaking into following lines', () => {
  const state = orgStreamParser.startState();
  assert.equal(tokens('#+begin_src mermaid', state)[0].style, 'meta');
  assert.equal(state.block, 'src');
  assert.equal(tokens('* not an Org heading here', state)[0].style, 'string');
  assert.equal(tokens('#+END_SRC', state)[0].style, 'meta');
  assert.equal(state.block, null);
  assert.equal(tokens('Plain text', state)[0].style, null);
});

test('Org distinguishes comments, directives, planning, lists and checkboxes', () => {
  for (const [line, style] of [['# comment', 'comment'], ['#+title: My note', 'meta'], ['SCHEDULED: <2026-10-26 Mon>', 'keyword'], ['- [ ] Task', 'list'], ['[X] Complete', 'atom']]) assert.equal(tokens(line)[0].style, style);
});
