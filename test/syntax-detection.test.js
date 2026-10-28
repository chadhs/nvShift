import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { detectSyntax, MAX_SYNTAX_BYTES } from '../electron/syntax-detection.cjs';
import { createSyntaxDetector } from '../electron/syntax-client.cjs';

const result = (format, reason = format) => ({ format, reason });

test('existing prose and shared list/emphasis syntax remain ambiguous plain text', () => {
  for (const source of ['', 'Hello 世界 café\nAnother paragraph.', '* Heading', '- list\n+ item\n  * nested\n1. first\n2) second', '*emphasis* and **bold**', '    # Code example\n\t[[file:example.png]]']) {
    assert.deepEqual(detectSyntax(source), result('plain', 'ambiguous'), source);
  }
});

test('recognizes strong Markdown evidence after introductory text', () => {
  for (const source of ['# 标题', 'intro\n\n  ### A heading', 'Before [a link](other.md) after', '![Image](assets/chart.png)', '![](assets/chart.png)', '[image]: assets/chart.png', '```mermaid\nflowchart LR\nA-->B\n```', '~~~js\n# fake heading\n~~~']) {
    assert.deepEqual(detectSyntax(source), result('markdown'), source);
  }
});

test('recognizes strong Org evidence with Unicode and case-insensitive directives', () => {
  for (const source of ['#+TITLE: 标题', '#+title: A title', '#+STARTUP: overview', '** Nested heading', '*** TODO café', '[[file:assets/chart.png]]', 'A [[https://example.com][link]].', '#+BEGIN_SRC js\nconst n = 2;\n#+END_SRC']) {
    assert.deepEqual(detectSyntax(source), result('org'), source);
  }
});

test('real evidence from both formats falls back to plain text', () => {
  for (const source of ['# Markdown\n#+TITLE: Org', '[[file:chart.png]]\n[Link](other.md)', '#+TITLE: Title\n\n~~~\nexample\n~~~']) assert.deepEqual(detectSyntax(source), result('plain', 'conflicting'));
});

test('literal block bodies do not contribute conflicting evidence', () => {
  const examples = [
    ['```org\n#+TITLE: Example\n** Org\n[[file:image.png]]\n```\n# Markdown', 'markdown'],
    ['~~~~org\n#+BEGIN_SRC\n#+TITLE: Org\n~~~\n#+END_SRC\n~~~~', 'markdown'],
    ['#+BEGIN_SRC markdown\n# Markdown\n![Image](image.png)\n```mermaid\n#+END_SRC\n* Org', 'org'],
    ['#+begin_example\n# fake\n[Link](a.md)\n#+end_example', 'org'],
    ['```org\n#+TITLE: unfinished', 'markdown'],
    ['#+BEGIN_SRC markdown\n# unfinished', 'org'],
  ];
  for (const [source, format] of examples) assert.deepEqual(detectSyntax(source), result(format), source);
});

test('inline literals and escaped syntax do not count as evidence', () => {
  for (const source of [
    'Use `[[file:chart.png]]` or `[link](file.md)` as examples.',
    'Use `` a ` and [[file:chart.png]] `` in text.',
    'Use =[[file:chart.png]]= or ~[link](other.md)~.',
    'A `long example\n#+TITLE: Example\n[[file:chart.png]]\n` ends here.',
    '\\# Heading\n\\*\\* Org\n\\[\\[file:chart.png\\]\\]\n\\[link](other.md)',
  ]) assert.deepEqual(detectSyntax(source), result('plain', 'ambiguous'), source);
  assert.deepEqual(detectSyntax('An unmatched ` delimiter\n# Real heading'), result('markdown'));
});

test('validates the entire source and never truncates over-limit or invalid UTF-8 notes', () => {
  for (const source of [null, 1, {}, '\ud800', 'bad\0text']) assert.throws(() => detectSyntax(source), /valid UTF-8/u);
  assert.throws(() => detectSyntax('x'.repeat(MAX_SYNTAX_BYTES + 1)), /16 MiB/u);
  assert.throws(() => detectSyntax('界'.repeat(Math.ceil(MAX_SYNTAX_BYTES / 3))), /16 MiB/u);
});

test('large and adversarial notes have bounded scan time', (t) => {
  const source = `${'a'.repeat(4 * 1024 * 1024)}\n${'['.repeat(2 * 1024 * 1024)}\n#+TITLE: Last line\n`;
  const start = performance.now();
  assert.deepEqual(detectSyntax(source), result('org'));
  const elapsed = performance.now() - start;
  t.diagnostic(`6 MiB adversarial note classified in ${elapsed.toFixed(1)} ms`);
  assert.ok(elapsed < 6000, `Scan took ${elapsed} ms`);
});

test('persistent worker resolves concurrent requests independently and survives invalid input', async (t) => {
  const detector = createSyntaxDetector(); t.after(() => detector.close());
  assert.deepEqual(await Promise.all([detector.detect('# Markdown'), detector.detect('#+TITLE: Org'), detector.detect('plain')]), [result('markdown'), result('org'), result('plain', 'ambiguous')]);
  await assert.rejects(detector.detect('\ud800'), /valid UTF-8/u);
  await assert.rejects(detector.detect(null), /requires text/u);
  assert.deepEqual(await detector.detect('[[file:chart.png]]'), result('org'));
  await detector.close(); await detector.close();
  await assert.rejects(detector.detect('# Markdown'), /closed/u);
});

test('unused detector closes without starting its worker', async () => {
  const detector = createSyntaxDetector({ workerPath: '/a/path/that/does/not/exist.cjs' });
  await detector.close();
});

async function customWorker(t, source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nvshift-syntax-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'worker.cjs'); await writeFile(file, source);
  return file;
}

test('worker timeouts reject queued work and permit a fresh worker on retry', async (t) => {
  const workerPath = await customWorker(t, "require('node:worker_threads').parentPort.on('message', () => {});");
  const detector = createSyntaxDetector({ workerPath, timeoutMs: 100 }); t.after(() => detector.close());
  const requests = [detector.detect('one'), detector.detect('two')];
  for (const request of requests) request.catch(() => {});
  await Promise.all(requests.map((request) => assert.rejects(request, /processing limit/u)));
  await writeFile(workerPath, "const {parentPort}=require('node:worker_threads'); parentPort.on('message',({requestId})=>parentPort.postMessage({requestId,result:{format:'org',reason:'org'}}));");
  assert.deepEqual(await detector.detect('retry'), result('org'));
});

test('worker exit and malformed replies fail safely, and close rejects active work', async (t) => {
  for (const source of ["process.exit(0);", "const {parentPort}=require('node:worker_threads');parentPort.on('message',({requestId})=>parentPort.postMessage({requestId,result:{format:'markdown',reason:'ambiguous'}}));"]) {
    const workerPath = await customWorker(t, source);
    const detector = createSyntaxDetector({ workerPath }); t.after(() => detector.close());
    await assert.rejects(detector.detect('one'), /unexpectedly|invalid result/u);
  }
  const workerPath = await customWorker(t, "require('node:worker_threads').parentPort.on('message',()=>{});");
  const detector = createSyntaxDetector({ workerPath });
  const request = detector.detect('pending'); request.catch(() => {});
  await detector.close();
  await assert.rejects(request, /closed/u);
});
