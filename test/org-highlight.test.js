import test from 'node:test';
import assert from 'node:assert/strict';
import { renderOrg } from '../src/org.js';
import { escapeHtml } from '../src/html.js';
import { createCodeHighlighter, MAX_HIGHLIGHT_BLOCK_LENGTH, MAX_HIGHLIGHT_DOCUMENT_LENGTH } from '../src/highlight.js';

test('Org source languages and aliases produce token markup without changing code text', () => {
  for (const [language, source] of [
    ['js', 'const message = "hello";'], ['JS', 'const message = "hello";'],
    ['typescript', 'const count: number = 2;'], ['python', 'def greet():\n    return "hello"'],
    ['sh', 'echo "hello"'], ['shell', 'echo "hello"'],
    ['emacs-lisp', '(message "hello")'], ['elisp', '(message "hello")'],
    ['json', '{"hello": true}'], ['toml', 'hello = true'], ['yml', 'hello: true'],
    ['c++', 'int count = 2;'], ['nix', '{ hello = true; }'],
  ]) {
    const { html } = renderOrg(`#+begin_src ${language} :results output\n${source}\n#+end_src`);
    assert.match(html, /class="hljs-/, language);
    assert.ok(html.includes(`<figcaption>${escapeHtml(language)}</figcaption>`));
    const code = html.match(/<code>([\s\S]*?)<\/code>/)[1];
    assert.equal(code.replace(/<\/?span\b[^>]*>/g, ''), escapeHtml(source), language);
  }
});

test('unknown, missing and plain-text languages and non-source blocks stay escaped plain text', () => {
  for (const header of ['src unknown-language', 'src', 'src text', 'src constructor', 'example', 'export html']) {
    const { html } = renderOrg(`#+begin_${header}\nconst value = "<script>";\n#+end_${header.split(' ')[0]}`);
    assert.doesNotMatch(html, /class="hljs-|<script>/);
    assert.match(html, /const value = &quot;&lt;script&gt;&quot;;/);
  }
  const inline = renderOrg('Use =const value = 2= and ~echo hello~.').html;
  assert.doesNotMatch(inline, /class="hljs-/);
});

test('highlighted HTML and malformed code cannot introduce executable markup', () => {
  for (const language of ['html', 'js', 'python']) {
    const { html } = renderOrg(`#+begin_src ${language}\n<script>globalThis.compromised = true</script><img src="https://tracker.invalid/pixel" onerror="alert(1)"> &\n#+end_src`);
    assert.doesNotMatch(html, /<(?:script|img|iframe)\b|\bonerror="/i);
    assert.match(html, /&lt;/);
    assert.match(html, /&amp;/);
  }
  assert.match(renderOrg('#+begin_src js\nconst value = "unfinished\n#+end_src').html, /unfinished/);
  assert.doesNotMatch(renderOrg('#+begin_src js"onclick="bad\n<script>\n#+end_src').html, /<script>|<figcaption[^>]+onclick=/);
});

test('large blocks fall back intact and each document has its own highlighting budget', () => {
  const large = 'const value = "<large>";\n'.repeat(Math.ceil(MAX_HIGHLIGHT_BLOCK_LENGTH / 24) + 1);
  const { html } = renderOrg(`#+begin_src js\n${large}\n#+end_src`);
  assert.doesNotMatch(html, /class="hljs-/);
  assert.ok(html.includes(escapeHtml(large.trimEnd())));
  const highlight = createCodeHighlighter();
  const chunk = '// comment\n'.padEnd(MAX_HIGHLIGHT_BLOCK_LENGTH, ' ');
  for (let i = 0; i < MAX_HIGHLIGHT_DOCUMENT_LENGTH / MAX_HIGHLIGHT_BLOCK_LENGTH; i++) {
    assert.notEqual(highlight(chunk, 'js'), null);
  }
  assert.equal(highlight('const next = 1;', 'js'), null);
  assert.notEqual(createCodeHighlighter()('const next = 1;', 'js'), null);
});
