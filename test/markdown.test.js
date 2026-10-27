import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';
import { renderDocument, resolveAnchor } from '../src/documents.js';
import { documentResource } from '../electron/resource-index.cjs';

test('Markdown promotes the first document H1 and keeps all headings addressable', () => {
  const parsed = renderMarkdown('[ref]: https://example.com\n\n# *Hello* 日本語\n\n## Café!\n## Café!\n\n[Top](#hello-日本語) [Second](#café-1)');
  assert.equal(parsed.title, 'Hello 日本語');
  assert.deepEqual(parsed.outline.map((heading) => heading.id), ['document-title', 'md-heading-café', 'md-heading-café-1']);
  assert.doesNotMatch(parsed.html, /<h1|<em>Hello/);
  assert.match(parsed.html, /href="#document-title"/);
  assert.match(parsed.html, /href="#md-heading-café-1"/);
  assert.equal(renderMarkdown('Paragraph\n\n# Later', 'File').title, 'Later');
  assert.equal(renderMarkdown('Title\n=====').title, 'Title');
  assert.equal(renderMarkdown('', 'Empty').title, 'Empty');
  assert.equal(renderMarkdown('').words, 0);
  assert.match(renderMarkdown('- [x] Done\n- [ ] Later').html, /aria-label="Complete"> Done<\/li>/);
  assert.match(renderMarkdown('- [x] Done\n\n- [ ] Later').html, /<p><input[^>]+> Done<\/p>/);
});

test('Markdown renders GFM tables, tasks, references, footnotes, nested lists and code', () => {
  const { html } = renderMarkdown('# Notebook\n\n**bold** *italic* ~~gone~~ `literal`\n\n> A quote\n\n3. Ordered\n   - Nested\n\n- [x] Done\n- [ ] Later\n\n| Left | Right |\n| :--- | ---: |\n| a | b |\n\n[site][url] www.example.com\n\n[url]: https://example.com\n\nA note[^n], again[^n].\n\n[^n]: Footnote text.\n\n```js\nconst answer = 42;\n```');
  for (const pattern of [/<strong>bold<\/strong>/, /<em>italic<\/em>/, /<s>gone<\/s>/, /<blockquote>/, /<ol start="3">/, /disabled checked/, /align-right/, /href="https:\/\/example.com"/, /hljs-keyword/, /Footnote text/, /md-footnote-ref-1-2/]) assert.match(html, pattern);
});

test('Markdown HTML and unsafe protocols stay inert, remote images use verified placeholders', () => {
  const { html } = renderMarkdown('<script>alert(1)</script>\n\n<img src="https://tracker.invalid/a.png" onerror="bad()">\n\n[bad](javascript:alert%281%29) ![remote](https://tracker.invalid/a.png) [mail](mailto:a@example.com)\n\n```html\n<script>bad()</script>\n```');
  assert.doesNotMatch(html, /<(?:script|img)\b|href="(?:javascript|data|file):/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /data-image-id="0"/);
  assert.match(html, /href="mailto:a@example.com"/);
});

test('Markdown resource descriptors use actual nodes and definitions with CRLF and Unicode', async () => {
  const source = '# Café 日本語\r\n\r\n![A chart][img]\r\n\r\n[img]: ./chart.png "Title"\r\n\r\n> ~~~~mermaid\r\n> flowchart LR\r\n>   A-->B\r\n> ~~~~\r\n\r\n- ```mermaid\r\n  sequenceDiagram\r\n    A->>B: Hi\r\n  ```\r\n\r\n```md\r\n![fake](secret.png)\r\n```';
  const doc = { source, path: '/notes/test.md', format: 'markdown' };
  const parsed = renderMarkdown(source);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].alt, 'A chart');
  assert.equal(parsed.diagrams.length, 2);
  for (const kind of ['images', 'diagrams']) for (const resource of parsed[kind]) {
    assert.equal(source.slice(resource.start, resource.end), resource.reference);
    assert.deepEqual(await documentResource(doc, kind, resource), resource);
  }
  assert.match(parsed.diagrams[0].source, /^flowchart LR\r?\n/);
  const reference = '![fake](secret.png)', start = source.indexOf(reference);
  await assert.rejects(documentResource(doc, 'images', { start, end: start + reference.length, reference }), /Invalid/);
  await assert.rejects(documentResource(doc, 'images', { ...parsed.images[0], target: 'secret.png', start: 0 }), /Invalid/);
  const verified = await documentResource(doc, 'images', { ...parsed.images[0], target: 'secret.png' });
  assert.equal(verified.target, './chart.png');
});

test('Markdown bounds diagrams, images and highlighting without dropping source', () => {
  const diagram = (value) => `~~~mermaid\n${value}\n~~~\n\n`;
  assert.equal(renderMarkdown(diagram('A-->B').repeat(25)).diagrams.length, 20);
  const oversized = renderMarkdown(diagram('<'.repeat(20001)));
  assert.equal(oversized.diagrams.length, 0);
  assert.match(oversized.html, /20,000 characters/);
  assert.equal(renderMarkdown('![image](a.png)\n\n'.repeat(101)).images.length, 100);
  const code = '<large> ' + 'x'.repeat(2 * 1024 * 1024);
  const parsed = renderMarkdown(`\`\`\`js\n${code}\n\`\`\`\n\n## Last\nFinal paragraph.`);
  assert.ok(parsed.html.includes('&lt;large&gt; ' + 'x'.repeat(2 * 1024 * 1024)));
  assert.doesNotMatch(parsed.html, /hljs-/);
  assert.match(parsed.html, /Final paragraph/);
  assert.equal(parsed.outline.at(-1).label, 'Last');
});

test('both document formats expose the same reading and navigation contract', () => {
  for (const [name, source] of [['notes.ORG', '* Hello'], ['notes.MARKDOWN', '## Hello'], ['notes.md', '## Hello']]) {
    const parsed = renderDocument({ name, source });
    for (const field of ['html', 'title', 'subtitle', 'author', 'outline', 'images', 'diagrams', 'links', 'anchors', 'words', 'lines']) assert.ok(Object.hasOwn(parsed, field), field);
    assert.equal(parsed.title, name === 'notes.ORG' ? 'Hello' : 'notes');
    assert.equal(resolveAnchor(parsed, { kind: 'heading', value: 'Hello' }), parsed.outline[0].id);
  }
  assert.throws(() => renderDocument({ name: 'notes.json', source: '' }), /Unsupported/);
});
