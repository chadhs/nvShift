import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolveDocumentLink } from '../electron/links.cjs';
import { createLibrary } from '../electron/library.cjs';
import { createResources } from '../electron/resources.cjs';
import { renderDocument, resolveAnchor } from '../src/documents.js';

test('local links resolve paths and heading targets without external protocols', () => {
  const doc = path.resolve('notes/source.md');
  assert.deepEqual(resolveDocumentLink(doc, '../café%20日本語.MD#heading'), { file: path.resolve('café 日本語.MD'), fragment: { kind: 'anchor', value: 'heading' } });
  assert.deepEqual(resolveDocumentLink(doc, 'file:other.org::*Some heading'), { file: path.resolve('notes/other.org'), fragment: { kind: 'heading', value: 'Some heading' } });
  assert.equal(resolveDocumentLink(doc, 'file:other.org::#custom').fragment.value, 'custom');
  assert.equal(resolveDocumentLink(doc, '~/notes.md').file, path.join(os.homedir(), 'notes.md'));
  assert.equal(resolveDocumentLink(doc, pathToFileURL(path.resolve('notes/café 日本語.markdown')).href).file, path.resolve('notes/café 日本語.markdown'));
  assert.equal(resolveDocumentLink(doc, 'other.txt').file, path.resolve('notes/other.txt'));
  for (const target of ['https://example.com/a.md', 'javascript:bad.md', '//server/a.md', 'file://server/a.md', '%2F%2Fserver/a.md', 'file:other.org::42', 'secret.json', 'a%00.md']) assert.throws(() => resolveDocumentLink(doc, target), /supported|only|local|Invalid/i, target);
});

test('verified links navigate library notes, resolve anchors, and reject stale source revisions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'nvshift-links-'));
  const notes = path.join(directory, 'notes');
  await mkdir(notes);
  const library = createLibrary({ userData: path.join(directory, 'profile') });
  const resources = createResources(library, { cancel() {} });
  try {
    const canonical = await realpath(notes);
    const org = path.join(canonical, 'one.org'), markdown = path.join(canonical, 'two.md');
    await writeFile(org, '#+title: Org\n* Destination\n:PROPERTIES:\n:CUSTOM_ID: custom\n:END:\n[[file:two.md#destination][Markdown]]');
    await writeFile(markdown, '# Markdown\n\n## Destination\n\n[Org](one.org::#custom)');
    await library.open(notes);
    let doc = await library.activate(library.getByPath(org).id);
    let resource = await resources.link(doc.id, doc.revision, renderDocument(doc).links[0]);
    let resolved = resolveDocumentLink(doc.path, resource.target);
    doc = await library.activate(library.getByPath(resolved.file).id);
    assert.equal(doc.format, 'markdown');
    assert.equal(resolveAnchor(renderDocument(doc), resolved.fragment), 'md-heading-destination');
    resource = await resources.link(doc.id, doc.revision, renderDocument(doc).links[0]);
    resolved = resolveDocumentLink(doc.path, resource.target);
    const old = doc;
    doc = await library.activate(library.getByPath(resolved.file).id);
    assert.equal(doc.format, 'org');
    assert.equal(resolveAnchor(renderDocument(doc), resolved.fragment), 'org-custom');
    await assert.rejects(resources.link(old.id, old.revision, {}), /changed/);
    await assert.rejects(resources.link(doc.id, doc.revision, { start: 0, end: 1 }), /Invalid/);
  } finally { resources.dispose(); await library.dispose(); await rm(directory, { recursive: true, force: true }); }
});
