import test from 'node:test';
import assert from 'node:assert/strict';
import { documentFormat, documentTitle } from '../electron/formats.cjs';
import { renderDocument } from '../src/documents.js';
import { analyzeDocument } from '../src/document-analysis.js';

test('.txt syntax is explicit and does not change filename or content', () => {
  const source = '# A heading\n<img src=x onerror=alert(1)>\n';
  assert.equal(documentFormat('notes.TXT'), 'plain');
  assert.equal(documentFormat('notes.txt', 'markdown'), 'markdown');
  assert.equal(documentFormat('notes.txt', 'org'), 'org');
  assert.equal(documentFormat('notes.md', 'org'), 'markdown');
  assert.equal(documentFormat('notes.org', 'markdown'), 'org');
  assert.equal(documentTitle('notes.txt'), 'notes');
  const plain = renderDocument({ name: 'notes.txt', format: 'plain', source });
  assert.match(plain.html, /&lt;img/);
  assert.match(plain.html, /# A heading/);
  assert.equal(plain.images.length, 0);
  assert.equal(analyzeDocument({ source, format: 'plain' }).images.length, 0);
  assert.equal(renderDocument({ name: 'notes.txt', source, format: 'markdown' }).title, 'A heading');
  assert.equal(renderDocument({ name: 'notes.txt', source: '* Org heading', format: 'org' }).outline.length, 1);
});
