import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAnalyzer } from '../electron/analysis.cjs';
import { documentIndex, cancelAnalysis } from '../electron/resource-index.cjs';
import { createDocumentRenderer } from '../src/renderer.js';
import { analyzeDocument } from '../src/document-analysis.js';
import { renderMarkdown } from '../src/markdown.js';
import { resolveAnchor } from '../src/anchors.js';
import { visitTree, MAX_TREE_NODES, MAX_METADATA_CHARACTERS } from '../src/processing-limits.js';

test('worker-cloned anchor maps resolve only actual headings', () => {
  const anchors = Object.create(null); anchors.real = 'org-real';
  const parsed = structuredClone({ anchors, outline: [] });
  assert.equal(resolveAnchor(parsed, { kind: 'anchor', value: 'real' }), 'org-real');
  for (const value of ['constructor', '__proto__', 'toString']) assert.equal(resolveAnchor(parsed, { kind: 'anchor', value }), undefined);
  parsed.anchors.constructor = 'org-constructor';
  assert.equal(resolveAnchor(parsed, { kind: 'anchor', value: 'constructor' }), 'org-constructor');
});

test('a busy analysis worker times out while the parent stays responsive, and cancellation settles work', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'markup-processing-'));
  const workerPath = path.join(directory, 'busy.cjs');
  await writeFile(workerPath, 'while (true) {}');
  const analyzer = createAnalyzer({ workerPath, timeoutMs: 200 });
  let heartbeat = false;
  try {
    const timer = setTimeout(() => { heartbeat = true; }, 20);
    await assert.rejects(analyzer.analyze({}), /processing limit/);
    clearTimeout(timer);
    assert.equal(heartbeat, true);
    const pending = analyzer.analyze({});
    analyzer.cancel();
    await assert.rejects(pending, /document changed/);
    const healthy = createAnalyzer();
    const index = await healthy.analyze({ source: '![Image](chart.png)', format: 'markdown' });
    assert.equal(index.images[0].target, 'chart.png');
  } finally { analyzer.cancel(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelled resource analysis can be retried for the same revision', async () => {
  const doc = { source: '![Image](chart.png)', path: '/notes.md' };
  const pending = documentIndex(doc);
  cancelAnalysis();
  await assert.rejects(pending, /document changed/);
  assert.equal((await documentIndex(doc)).images[0].target, 'chart.png');
});

test('preview workers terminate on replacement, timeout and success, ignoring late results', async () => {
  const workers = [];
  const renderer = createDocumentRenderer({ timeoutMs: 40, createWorker: () => {
    const worker = { postMessage(doc) { this.doc = doc; }, terminate() { this.terminated = true; } };
    workers.push(worker); return worker;
  } });
  const first = renderer.render({ source: 'first' });
  const second = renderer.render({ source: 'second' });
  await assert.rejects(first, /document changed/);
  assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { preview: { title: 'stale' } } });
  workers[1].onmessage({ data: { preview: { title: 'current' } } });
  assert.deepEqual(await second, { title: 'current' });
  assert.equal(workers[1].terminated, true);
  await assert.rejects(renderer.render({ source: 'stalled' }), /processing limit/);
  assert.equal(workers[2].terminated, true);
  const broken = renderer.render({ source: 'broken' });
  workers[3].onerror({ preventDefault() {} });
  await assert.rejects(broken, /processing stopped/);
});

test('document complexity limits reject deep trees and excessive nodes', () => {
  assert.throws(() => analyzeDocument({ source: '> '.repeat(200) + 'Text', format: 'markdown' }), /nesting limit/);
  assert.throws(() => analyzeDocument({ source: Array.from({ length: 150 }, (_, index) => '*'.repeat(index + 1) + ' Heading').join('\r\n'), format: 'org' }), /nesting limit/);
  const leaf = { type: 'text' };
  assert.throws(() => visitTree({ children: Array(MAX_TREE_NODES).fill(leaf) }, () => {}), /node preview limit/);
});

test('oversized front matter remains readable without metadata expansion', () => {
  for (const delimiter of ['---', '+++']) {
    const source = `${delimiter}\n# ${'x'.repeat(MAX_METADATA_CHARACTERS)}\n${delimiter}\n\n# Body\nReadable.`;
    const parsed = renderMarkdown(source);
    assert.match(parsed.metadataWarning, /128 Ki characters/);
    assert.match(parsed.html, /frontmatter-source/);
    assert.match(parsed.html, /Readable\./);
    assert.equal(parsed.title, 'Body');
  }
});
