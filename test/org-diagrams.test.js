import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrg } from '../src/org.js';
import { documentResource } from '../electron/resource-index.cjs';
const orgDiagramSource = async (doc, request) => (await documentResource({ ...doc, format: 'org' }, 'diagrams', request)).source;

const block = (body = 'flowchart LR\n A-->B', header = 'mermaid') => `#+begin_src ${header}\n${body}\n#+end_src`;
test('Mermaid descriptors preserve source positions and safe source fallback', () => {
  const source = `#+title: 日本語\n${block('flowchart LR\n A[<script>bad</script>]', 'MERMAID :file chart.svg')}`;
  const result = renderOrg(source);
  assert.equal(result.diagrams.length, 1);
  const [diagram] = result.diagrams;
  assert.match(source.slice(diagram.start, diagram.end), /^#\+begin_src MERMAID/);
  assert.match(result.html, /Show source/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.doesNotMatch(result.html, /<script>/);
  assert.equal(renderOrg(block('A-->B', 'dot')).diagrams.length, 0);
});

test('only an adjacent single-image Babel result with matching names is associated', () => {
  for (const name of ['', 'workflow']) {
    const source = `${name ? `#+name: ${name}\n` : ''}${block()}\n\n#+RESULTS: ${name}\n[[file:chart.svg]]\n\nParagraph`;
    const result = renderOrg(source);
    assert.equal(result.diagrams[0].resultStart, result.images[0].start);
    assert.match(result.html, /data-image-start=/);
  }
  for (const suffix of [
    '\n#+RESULTS: other\n[[file:chart.svg]]',
    '\nText\n#+RESULTS:\n[[file:chart.svg]]',
    '\n#+RESULTS:\n[[file:chart.svg]] more text',
    '\n#+RESULTS:\n[[file:chart.svg][Description]]',
    '\n#+RESULTS:\n[[https://example.com/chart.svg]]',
    '\n#+RESULTS:\n[[file:a.svg]] [[file:b.svg]]',
    '\n#+RESULTS:\n[[file:a.svg]]\n[[file:b.svg]]',
  ]) assert.equal(renderOrg(block() + suffix).diagrams[0].resultStart, undefined, suffix);
});

test('diagram limits retain escaped source and bound scheduled rendering', () => {
  const many = renderOrg(Array.from({ length: 25 }, () => block()).join('\n\n'));
  assert.equal(many.diagrams.length, 20);
  assert.match(many.html, /20 per document/);
  const huge = renderOrg(block('<'.repeat(20001)));
  assert.equal(huge.diagrams.length, 0);
  assert.match(huge.html, /20,000 characters/);
  assert.equal((huge.html.match(/&lt;/g) || []).length, 20001);
  assert.equal(renderOrg(Array.from({ length: 6 }, () => block('a'.repeat(20000))).join('\n\n')).diagrams.length, 5);
});

test('Org diagram requests only extract parsed Mermaid blocks from document source', async () => {
  const source = `* Header\n${block('flowchart LR\n A-->B', 'MERMAID :file output.svg')}\n`;
  const request = renderOrg(source).diagrams[0];
  assert.equal((await orgDiagramSource({ source }, request)).trimEnd(), 'flowchart LR\n A-->B');
  for (const invalid of [null, {}, { start: -1, end: 3 }, { start: 0, end: source.length + 1 }, { start: 0, end: source.length }, { ...request, start: request.start + 1 }]) {
    await assert.rejects(orgDiagramSource({ source }, invalid), /Invalid/);
  }
  const long = block('x'.repeat(20001));
  await assert.rejects(orgDiagramSource({ source: long }, { start: 0, end: long.length }), /Invalid/);
});
