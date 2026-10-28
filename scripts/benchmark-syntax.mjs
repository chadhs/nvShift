// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createSyntaxDetector } from '../electron/syntax-client.cjs';

const detector = createSyntaxDetector();
const prose = 'Decisions, implementation details, diagrams, and follow-up work. '.repeat(32);
const sources = ['# Markdown heading\n' + prose, '#+TITLE: Org title\n* Heading\n' + prose, prose];
const formats = ['markdown', 'org', 'plain'];
try {
  const startup = performance.now();
  await detector.detect(sources[0]);
  const workerStartupMs = performance.now() - startup;
  const samples = [];
  for (let index = 0; index < 1000; index++) {
    const before = performance.now();
    const result = await detector.detect(sources[index % sources.length] + index);
    samples.push(performance.now() - before);
    assert.equal(result.format, formats[index % sources.length]);
  }
  samples.sort((a, b) => a - b);
  const adversarial = `${'a'.repeat(4 * 1024 * 1024)}\n${'['.repeat(2 * 1024 * 1024)}\n#+TITLE: Last line\n`;
  const before = performance.now();
  assert.equal((await detector.detect(adversarial)).format, 'org');
  const adversarialMs = performance.now() - before;
  const rounded = (number) => Number(number.toFixed(2));
  console.log(JSON.stringify({
    samples: samples.length,
    averageSourceBytes: Math.round(sources.reduce((sum, source) => sum + Buffer.byteLength(source), 0) / sources.length),
    workerStartupMs: rounded(workerStartupMs), medianMs: rounded(samples[500]), p95Ms: rounded(samples[949]),
    adversarialSourceBytes: Buffer.byteLength(adversarial), adversarialMs: rounded(adversarialMs), debounceMs: 120,
  }, null, 2));
} finally { await detector.close(); }
