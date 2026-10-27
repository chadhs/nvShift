import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrg } from '../src/org.js';
import { documentResource } from '../electron/resource-index.cjs';

const header = '#+title: Omarchy Quattro and the Year of the Linux Desktop\n#+author: Chad Stovern\n#+date: 2026-09-11\n#+tags[]: linux omarchy\n#+draft: false\n';
test('Org Hugo metadata displays dates and array tags without leaking header lines into the body', () => {
  const result = renderOrg(header + '\n* Post\nBody.');
  assert.equal(result.title, 'Omarchy Quattro and the Year of the Linux Desktop');
  assert.equal(result.author, 'Chad Stovern');
  assert.equal(result.date, '2026-09-11');
  assert.deepEqual(result.tags, ['linux', 'omarchy']);
  assert.equal(result.draft, false);
  assert.doesNotMatch(result.html, /#\+tags|#\+draft|linux omarchy/);
  assert.match(result.html, /Body\./);
});

test('Org only marks a draft for the true keyword value and leaves code examples literal', () => {
  for (const value of ['false', 'yes', '1', '"true"', '']) assert.equal(renderOrg(header.replace('draft: false', `draft: ${value}`)).draft, false);
  assert.equal(renderOrg(header.replace('draft: false', 'draft: true')).draft, true);
  assert.equal(renderOrg('* A notebook').draft, false);
  const example = renderOrg('* Examples\n#+begin_example\n#+tags[]: preserve me\n#+draft: true\n#+end_example');
  assert.equal(example.draft, false);
  assert.match(example.html, /#\+tags\[\]: preserve me/);
});

test('Org Hugo array keywords preserve CRLF and Unicode resource positions', async () => {
  const source = (header + '\n[[file:café.png]]\n[[file:other.md][Read]]').replaceAll('\n', '\r\n');
  const doc = { source, format: 'org', path: '/notes/post.org' }, parsed = renderOrg(source);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.links.length, 1);
  for (const kind of ['images', 'links']) for (const resource of parsed[kind]) {
    assert.equal(source.slice(resource.start, resource.end), resource.reference);
    assert.ok(await documentResource(doc, kind, resource));
  }
});
