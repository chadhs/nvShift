import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalPath, assertLocalPath, localFileURL } from '../electron/local-paths.cjs';
import { resolveDocumentLink } from '../electron/links.cjs';
import { readDocument } from '../electron/documents.cjs';
import { documentResource } from '../electron/resource-index.cjs';
import { analyzeDocument } from '../src/document-analysis.js';
import { renderDocument } from '../src/documents.js';

const options = { platform: 'win32', home: 'C:\\Users\\Reader' };
const documentPath = 'C:\\Users\\Reader\\notes\\source.md';

test('Windows local paths resolve consistently on every test host', () => {
  for (const [target, expected] of [
    ['C:/notes/café 日本語.md', 'C:\\notes\\café 日本語.md'],
    ['D:\\notes\\other.org', 'D:\\notes\\other.org'],
    ['file:C:/notes/other.md', 'C:\\notes\\other.md'],
    ['../images/chart.png', 'C:\\Users\\Reader\\images\\chart.png'],
    ['..\\images\\chart.png', 'C:\\Users\\Reader\\images\\chart.png'],
    ['file:///C:/notes/caf%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E.md', 'C:\\notes\\café 日本語.md'],
    ['~/notes/other.org', 'C:\\Users\\Reader\\notes\\other.org'],
  ]) assert.equal(resolveLocalPath(documentPath, target, options), expected, target);
  assert.deepEqual(resolveDocumentLink(documentPath, 'file:D:/notes/other.org::*Some heading', options), {
    file: 'D:\\notes\\other.org', fragment: { kind: 'heading', value: 'Some heading' },
  });
  assert.deepEqual(resolveDocumentLink(documentPath, 'file:///C:/notes/other.md#caf%C3%A9', options), {
    file: 'C:\\notes\\other.md', fragment: { kind: 'anchor', value: 'café' },
  });
});

test('Windows path support never enables network shares, devices, streams, or other schemes', async () => {
  for (const target of [
    '//server/share/a.md', '\\\\server\\share\\a.md', '\\\\?\\C:\\notes\\a.md', '\\\\.\\pipe\\a.md', '\\??\\C:\\notes\\a.md',
    '%5C%5Cserver%5Cshare%5Ca.md', 'file://server/share/a.md', 'file:////server/share/a.md',
    'C:relative.md', 'file:C:relative.md', 'C:/notes/a.md:stream.md', 'javascript:alert.md', 'https://example.com/a.md', 'a%00.md',
    'C:/notes/NUL.org', 'COM1.md', 'LPT¹.org', 'file:///C:/notes/CON.md',
  ]) assert.throws(() => resolveLocalPath(documentPath, target, options), /local|supported|Invalid/i, target);
  assert.throws(() => localFileURL('file://server/share/a.md', 'win32'), /local/);
  assert.throws(() => localFileURL('file:///C:/bad%5Cpath.md', 'win32'), /encoded/i);
  for (const file of ['\\\\server\\share\\a.org', '\\\\?\\C:\\a.org', '\\\\.\\pipe\\a.org']) {
    assert.throws(() => assertLocalPath(file, 'win32'), /not supported/);
    await assert.rejects(readDocument(file), /not supported/);
  }
});

test('Org and Markdown index Windows links and images with CRLF and original source positions', () => {
  for (const format of ['org', 'markdown']) {
    for (const image of ['C:/notes/chart.png', 'C:\\notes\\chart.png', 'file:C:/notes/chart.png', 'file:C:\\notes\\chart.png', 'file:///C:/notes/chart.png']) {
      const source = format === 'org'
        ? `* Café 日本語\r\n[[${image}]]\r\n[[file:C:/notes/other.md][Other]]\r\n`
        : `# Café 日本語\r\n\r\n![Chart](${image})\r\n\r\n[Other](C:/notes/other.md)\r\n`;
      const analysis = analyzeDocument({ source, format });
      assert.equal(analysis.images.length, 1, source);
      assert.equal(analysis.links.length, 1, source);
      for (const resource of [...analysis.images, ...analysis.links]) assert.equal(source.slice(resource.start, resource.end), resource.reference);
      const rendered = renderDocument({ source, format, path: documentPath, name: 'source.md' });
      assert.match(rendered.html, /data-image-id="0"/);
      assert.match(rendered.html, /data-document-link="0"/);
    }
  }
});

test('CRLF Org blocks, metadata, and resources retain their original source boundaries', async () => {
  const source = '#+title: Café 日本語\r\n\r\n* Reading\r\nText before.\r\n\r\n[[file:C:/notes/chart.png]]\r\n[[file:other.md][Read]]\r\n\r\n#+begin_src mermaid\r\nflowchart LR\r\n  A-->B\r\n#+end_src\r\n\r\n* Last\r\nText after.\r\n';
  const doc = { source, format: 'org', path: 'C:\\notes\\source.org', name: 'source.org' };
  const analysis = analyzeDocument(doc);
  for (const kind of ['images', 'links', 'diagrams']) {
    assert.equal(analysis[kind].length, 1);
    const resource = analysis[kind][0];
    assert.equal(source.slice(resource.start, resource.end), resource.reference);
    assert.ok(await documentResource(doc, kind, resource));
  }
  const rendered = renderDocument(doc);
  assert.equal(rendered.outline.length, 2);
  assert.match(rendered.html, /Text before\./);
  assert.match(rendered.html, /Text after\./);
  assert.match(analysis.diagrams[0].source, /A-->B/);
});
