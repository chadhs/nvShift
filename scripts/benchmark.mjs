import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { NoteSearchIndex } from '../electron/search-index.js';

const index = new NoteSearchIndex();
const body = 'Engineering meeting notes contain decisions, implementation details, diagrams, and follow-up work. '.repeat(21);
const documents = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), title: `Project ${i} team ${i % 50}`, source: `${body}\nMilestone ${i % 100} for customer ${i % 200}.`, name: `Project ${i}.md`, relativePath: `team-${i % 50}/Project ${i}.md`, modified: i, format: 'markdown', extension: 'md' }));
const started = performance.now();
index.replaceAll(documents);
const indexingMs = performance.now() - started;
const queries = ['engineering', 'project', 'project 42', 'implementation details', 'milestone 9', 'customer 17', 'team 3', '', 'diagr follow', 'decisions engineering'];
for (let i = 0; i < 20; i++) index.search(queries[i % queries.length]);
const samples = [];
for (let i = 0; i < 100; i++) {
  const before = performance.now();
  index.search(queries[i % queries.length]);
  samples.push(performance.now() - before);
}
samples.sort((a, b) => a - b);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
console.log(JSON.stringify({ notes: documents.length, averageSourceBytes: Buffer.byteLength(documents[0].source), indexingMs: Number(indexingMs.toFixed(2)), searches: samples.length, medianMs: Number(samples[Math.floor(samples.length / 2)].toFixed(2)), p95Ms: Number(p95.toFixed(2)), targetMs: 100, passed: p95 < 100 }, null, 2));
assert.ok(p95 < 100, `Search p95 ${p95.toFixed(2)} ms exceeds the 100 ms target.`);
