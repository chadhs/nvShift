import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrg } from '../src/org.js';
import { execFileSync } from 'node:child_process';

test('duplicate headings keep stable IDs around existing suffixed headings', () => {
  const result = renderOrg('* Same\n* Same-2\n* Same\n* Same\n* Same-3\n* Same');
  assert.deepEqual(result.outline.map((heading) => heading.id), ['org-same', 'org-same-2', 'org-same-3', 'org-same-4', 'org-same-3-2', 'org-same-5']);
});

test('many duplicate headings render within a bounded subprocess deadline', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { renderOrg } from './src/org.js';
    const { outline } = renderOrg('* same\\n'.repeat(30000));
    assert.equal(outline.length, 30000);
    assert.equal(new Set(outline.map((heading) => heading.id)).size, 30000);
    assert.equal(outline.at(-1).id, 'org-same-30000');
  `], { timeout: 10000, killSignal: 'SIGKILL' });
});

test('metadata, task states, tags, stable duplicate headings, and custom anchors', () => {
  const result = renderOrg('#+title: A notebook\n#+author: Chad\n* TODO First :work:\n:PROPERTIES:\n:CUSTOM_ID: custom\n:END:\n* DONE First\n* First\n[[#custom][Go back]]');
  assert.equal(result.title, 'A notebook');
  assert.equal(result.author, 'Chad');
  assert.deepEqual(result.outline.map((h) => h.id), ['org-custom', 'org-first', 'org-first-2']);
  assert.match(result.html, /class="todo pending">TODO/);
  assert.match(result.html, /class="todo done">DONE/);
  assert.match(result.html, /<span>work<\/span>/);
  assert.match(result.html, /href="#org-custom"/);
});

test('emphasis, nested lists, checkboxes, tables and source blocks', () => {
  const { html } = renderOrg('* Hello\n*bold* /italic/ =literal= ~code~ _under_ +gone+\n\n- [X] Done\n  - Nested\n- [ ] Later\n\n| Name | Value |\n|------+-------|\n| One | Two |\n\n#+begin_src js\nconsole.log("<hello>")\n#+end_src');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>literal<\/code>/);
  assert.match(html, /<u>under<\/u>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /Done\s*<ul><li>Nested\s*<\/li><\/ul><\/li>/);
  assert.match(html, /disabled checked/);
  assert.match(html, /<thead><tr><th> Name <\/th>/);
  assert.match(html.replace(/<\/?span\b[^>]*>/g, ''), /console.log\(&quot;&lt;hello&gt;&quot;\)/);
});

test('embedded HTML, code, attributes and unsafe links stay inert', () => {
  const { html, title } = renderOrg('#+title: <script>alert(1)</script>\n* <img src=x onerror=alert(1)>\n[[javascript:alert(1)][click]]\n[[file:/etc/passwd][local]]\n[[https://example.com/"onclick="bad][safe]]\n#+begin_export html\n<script>alert(1)</script><img src="https://tracker.test/pixel">\n#+end_export');
  assert.equal(title, '<script>alert(1)</script>');
  assert.doesNotMatch(html, /<(script|img)\b/);
  assert.doesNotMatch(html, /href="(?:javascript|file):/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example.com\/&quot;onclick=&quot;bad"/);
});

test('empty files, no headings, Unicode and headings deeper than HTML supports', () => {
  assert.equal(renderOrg('', 'Empty').title, 'Empty');
  assert.equal(renderOrg('').words, 0);
  assert.equal(renderOrg('Just a paragraph').outline.length, 0);
  const result = renderOrg('* Café 日本語\n******* Deep');
  assert.equal(result.outline[0].id, 'org-café-日本語');
  assert.match(result.html, /<h6 /);
});

test('mailto links retain their protocol and escape address attributes', () => {
  const { html } = renderOrg('[[mailto:reader@example.invalid][Email]]\n[[mailto:reader@example.invalid?subject="Org"][Subject]]');
  assert.match(html, /href="mailto:reader@example.invalid"/);
  assert.match(html, /href="mailto:reader@example.invalid\?subject=&quot;Org&quot;"/);
});

test('mixed list markers split into ordered and unordered lists while keeping nesting', () => {
  const { html } = renderOrg('- Bullet\n  - Nested\n\n1. First\n2. Second\n  - Inside second\n\n- Back to bullets');
  assert.match(html, /<ul><li>Bullet\s*<ul><li>Nested\s*<\/li><\/ul><\/li><\/ul><ol>/);
  assert.match(html, /<li>First\s*<\/li><li>Second\s*<ul><li>Inside second\s*<\/li><\/ul><\/li><\/ol><ul><li>Back to bullets/);
});

test('a long section does not exhaust the parser stack or lose its final content', () => {
  const source = '#+title: Long notebook\n* Notes\n' +
    'A paragraph with *bold* text.\n\n'.repeat(3000) +
    '** Last heading\n[[*Notes][Back to notes]]\nFinal paragraph.';
  const result = renderOrg(source);
  assert.equal(result.title, 'Long notebook');
  assert.equal(result.outline.length, 2);
  assert.equal((result.html.match(/<strong>bold<\/strong>/g) || []).length, 3000);
  assert.match(result.html, /href="#org-notes"/);
  assert.match(result.html, /Final paragraph\.<\/p>$/);
});

test('multi-megabyte source blocks remain complete and escaped', () => {
  const code = ('<config> ' + 'x'.repeat(4086) + '\n').repeat(1280);
  assert.ok(Buffer.byteLength(code) > 4 * 1024 * 1024);
  const result = renderOrg('#+title: Large config\n* Configuration\n#+begin_src emacs-lisp\n' + code + '#+end_src\n* End\nFinished.');
  assert.equal(result.outline.length, 2);
  assert.equal((result.html.match(/&lt;config&gt;/g) || []).length, 1280);
  assert.doesNotMatch(result.html, /<config>/);
  assert.match(result.html, /Finished\.<\/p>$/);
});
