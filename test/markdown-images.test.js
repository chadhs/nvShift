import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createImageReader } from '../electron/images.cjs';
import { renderMarkdown } from '../src/markdown.js';
import { documentResource } from '../electron/resource-index.cjs';

test('Markdown inline and reference images load only verified local image nodes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'markup-preview-md-images-'));
  try {
    await writeFile(path.join(directory, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const source = '![Inline](chart.svg)\n\n![Reference][chart]\n\n[chart]: chart.svg\n\n```md\n![Fake](chart.svg)\n```\n\n![Host](file://remote/chart.svg)';
    const doc = { path: path.join(directory, 'notes.md'), source };
    const read = createImageReader(doc), parsed = renderMarkdown(source);
    for (const image of parsed.images.slice(0, 2)) assert.match((await read(image)).dataUrl, /^data:image\/svg\+xml;base64,/);
    assert.match((await read(parsed.images[2])).error, /local/);
    const reference = '![Fake](chart.svg)', start = source.indexOf(reference);
    assert.match((await read({ start, end: start + reference.length, reference })).error, /Invalid/);
    const updated = { ...doc, source: source.replace('[chart]: chart.svg', '[chart]: missing.svg') };
    assert.match((await createImageReader(updated)(parsed.images[1])).error, /not found/);
    const unchanged = await read(parsed.images[1]);
    assert.ok(unchanged.dataUrl);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Markdown remote image nodes include extensionless URLs, references and linked images', async () => {
  const source = '# Café 日本語\r\n\r\n![Inline](http://localhost:8080/image?size=2#view)\r\n\r\n[![Linked][image]](https://example.com/page)\r\n\r\n[image]: https://example.com/api/image "Title"\r\n\r\n![Unsafe](data:image/png;base64,AAA)\r\n\r\n```md\r\n![Fake](https://example.com/fake.png)\r\n```\r\n\r\n<img src="https://example.com/html.png">';
  const doc = { path: '/notes/test.md', source };
  const parsed = renderMarkdown(source);
  assert.deepEqual(parsed.images.map(({ target, alt }) => ({ target, alt })), [
    { target: 'http://localhost:8080/image?size=2#view', alt: 'Inline' },
    { target: 'https://example.com/api/image', alt: 'Linked' },
  ]);
  assert.match(parsed.html, /<a href="https:\/\/example.com\/page"[^>]*><span class="image-preview"/);
  for (const image of parsed.images) assert.deepEqual(await documentResource(doc, 'images', image), image);
  const reference = '![Fake](https://example.com/fake.png)', start = source.indexOf(reference);
  await assert.rejects(documentResource(doc, 'images', { start, end: start + reference.length, reference }), /Invalid/);
  const mixed = renderMarkdown(('![Local](local.png)\n\n![Remote](https://example.com/image)\n\n').repeat(51));
  assert.equal(mixed.images.length, 100);
  assert.equal((mixed.html.match(/data-image-id=/g) || []).length, 100);
  assert.match(mixed.html, /Image unavailable or limit reached/);
  assert.doesNotMatch(mixed.html, /href="https:\/\/example.com\/image"/);
});
