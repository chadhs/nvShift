import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteSearchIndex, makeSnippet } from '../electron/search-index.js';

const note = (id, title, source, modified = 1) => ({ id, title, source, name: `${title}.md`, relativePath: `${title}.md`, modified, format: 'markdown', extension: 'md' });

test('full filenames and extensions are searchable and exact filenames outrank body mentions', () => {
  const index = new NoteSearchIndex();
  index.replaceAll([
    { ...note('file', 'Roadmap', '* Plans'), name: 'Roadmap.org', relativePath: 'Roadmap.org', format: 'org', extension: 'org' },
    note('body', 'Other', 'A mention of roadmap.org in another note'),
  ]);
  assert.equal(index.search('ROADMAP.ORG').results[0].id, 'file');
  assert.equal(index.search('.org').results[0].id, 'file');
  assert.equal(index.search('road org').results[0].id, 'file');
});

test('prefix searches require all terms and rank exact titles then title matches above body matches', () => {
  const index = new NoteSearchIndex();
  index.replaceAll([
    note('body', 'Other', 'project alpha project alpha project alpha project alpha', 10),
    note('title', 'Project alphabet soup', '', 2),
    note('exact', 'Project alpha', '', 1),
    note('partial', 'Project', 'Only beta'),
  ]);
  assert.deepEqual(index.search('PROJECT ALPHA').results.map((result) => result.id), ['exact', 'title', 'body']);
  assert.equal(index.search('project nonexistent').total, 0);
  assert.equal(index.search('proj alph').total, 3);
  assert.equal(index.search('prject').total, 0);
});

test('empty queries use recency and incremental updates remove stale source and metadata', () => {
  const index = new NoteSearchIndex();
  index.replaceAll([note('a', 'Alpha', 'older', 1), note('b', 'Beta', 'newer', 2)]);
  assert.deepEqual(index.search('').results.map((result) => result.id), ['b', 'a']);
  index.upsert({ ...note('a', 'Renamed', 'different words', 3), format: 'org', extension: 'txt' });
  assert.equal(index.search('older').total, 0);
  assert.equal(index.search('renam').results[0].format, 'org');
  assert.equal(index.search('different').results[0].extension, 'txt');
  index.remove('a');
  assert.equal(index.search('different').total, 0);
  assert.equal(index.search('').total, 1);
});

test('search limits results without hiding total and snippets retain nearby Unicode text', () => {
  const index = new NoteSearchIndex();
  index.replaceAll(Array.from({ length: 250 }, (_, i) => note(String(i), `Meeting ${i}`, 'Résumé 世界 notes')));
  const result = index.search('meet');
  assert.equal(result.total, 250);
  assert.equal(result.results.length, 200);
  assert.match(makeSnippet(`${'before '.repeat(30)}Résumé world ${'after '.repeat(40)}`, 'rés'), /Résumé/u);
  assert.match(index.search('世界').results[0].snippet, /世界/u);
});
