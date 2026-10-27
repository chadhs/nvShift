import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrg } from '../src/org.js';
import { MAX_IMAGE_LINKS } from '../electron/formats.cjs';

test('Org local and remote image links produce placeholders and verified source positions', () => {
  const source = '#+title: Café 日本語\n[[file:images/chart.png]]\n[[./photo.JPG]]\n[[../diagram.svg]]\n[[file:photo.png][A description]]\n[[https://example.com/photo.png]]\n#+begin_src org\n[[file:code.png]]\n#+end_src';
  const result = renderOrg(source);
  assert.equal(result.images.length, 4);
  for (const image of result.images) assert.equal(source.slice(image.start, image.end), image.reference);
  assert.match(result.html, /data-image-id="0"/);
  assert.doesNotMatch(result.html, /<img\b/);
  assert.equal(result.images[3].target, 'https://example.com/photo.png');
  assert.equal(renderOrg('[[file:chart.png]]').images[0].label, 'chart.png');
  assert.match(result.html, /A description/);
  const many = renderOrg('[[file:photo.png]]\n'.repeat(MAX_IMAGE_LINKS + 1));
  assert.equal(many.images.length, MAX_IMAGE_LINKS);
  assert.match(many.html, /Image limit reached/);
});

test('Org remote images use URL pathnames and preserve ordinary and described links', () => {
  const source = '[[https://example.com/photo.JPG?size=2#view]]\n[[http://localhost:8080/chart.svg]]\n[[https://example.com/photo.png][Description]]\n[[https://example.com/image]]\n[[https://example.com/page?name=photo.png]]\n[[ftp://example.com/photo.png]]\n#+begin_src org\n[[https://example.com/code.png]]\n#+end_src\n#+begin_export html\n<img src="https://example.com/html.png">\n#+end_export';
  const parsed = renderOrg(source);
  assert.deepEqual(parsed.images.map((image) => image.target), ['https://example.com/photo.JPG?size=2#view', 'http://localhost:8080/chart.svg']);
  assert.match(parsed.html, /href="https:\/\/example.com\/photo.png"[^>]*>Description/);
  assert.match(parsed.html, /href="https:\/\/example.com\/image"/);
  const mixed = renderOrg(('[[file:local.png]]\n[[https://example.com/remote.png]]\n').repeat(51));
  assert.equal(mixed.images.length, MAX_IMAGE_LINKS);
  assert.equal((mixed.html.match(/data-image-id=/g) || []).length, MAX_IMAGE_LINKS);
  assert.match(mixed.html, /Image limit reached/);
});
