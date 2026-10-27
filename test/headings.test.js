import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { renderDocument, resolveAnchor } from '../src/documents.js';
import { createDocumentRenderer } from '../src/renderer.js';

function both(doc, title, options = {}) {
  const preview = renderDocument(doc, options);
  assert.equal(preview.title, title);
  assert.deepEqual(renderDocument(doc, { ...options, titleOnly: true }), { title });
  return preview;
}

test('content headings resolve metadata, later H1s and filename fallbacks in every syntax', () => {
  for (const name of ['file.md', 'file.markdown', 'file.txt']) {
    const doc = { name, format: 'markdown', source: 'An introduction.\n\n# *Café* 日本語\n\n## Section\nBody.' };
    const preview = both(doc, 'Café 日本語');
    assert.equal(preview.outline[0].id, 'document-title');
    assert.doesNotMatch(preview.html, /<em>Café<\/em>/);
    assert.match(preview.html, /An introduction\./);
    both({ ...doc, source: '---\ntitle: Explicit title\n---\n' + doc.source }, 'Explicit title');
    both({ ...doc, source: '+++\ntitle = "TOML title"\n+++\n' + doc.source }, 'TOML title');
    both({ ...doc, source: '## Only H2\nBody.' }, 'file');
    both({ ...doc, source: '' }, 'file');
  }
  for (const name of ['file.org', 'file.txt']) {
    const doc = { name, format: 'org', source: 'Introduction.\n* TODO [#A] Café *日本語* :work:\nBody.\n** Section\nDetails.' };
    const preview = both(doc, 'Café 日本語');
    assert.equal(preview.outline[0].todo, 'TODO');
    assert.doesNotMatch(preview.html, /class="todo|<strong>日本語<\/strong>/);
    assert.match(preview.html, /Introduction\./);
    assert.match(preview.html, /Body\./);
    assert.match(preview.html, /Details\./);
    both({ ...doc, source: '#+TiTlE: Explicit title\n' + doc.source }, 'Explicit title');
    both({ ...doc, source: 'Introduction.\n#+TITLE: Later metadata\n* Main\nBody.' }, 'Later metadata');
    both({ ...doc, source: '#+TITLE:   \n* Main\nBody.' }, 'Main');
    both({ ...doc, source: '** Only H2\nBody.' }, 'file');
    both({ ...doc, source: '' }, 'file');
  }
  both({ name: 'file.txt', format: 'plain', source: '# Fake\n#+TITLE: Fake\n* Fake' }, 'file');
});

test('title candidates exclude Markdown code, quotes and nested headings', () => {
  const source = '```markdown\n# Fenced fake\n```\n\n> # Quoted fake\n\n- # Nested fake\n\n    # Indented fake\n\n# Real title\nBody.';
  const doc = { name: 'file.md', source };
  both(doc, 'Real title');
  both({ ...doc, source: source.slice(0, source.indexOf('\n# Real title')) }, 'file');
  both({ ...doc, source: '# \n\n# Nonempty' }, 'Nonempty');
});

test('Org title candidates ignore blocks even when the parser exposes their stars as headings', () => {
  for (const block of ['src org', 'example', 'quote', 'export html', 'comment']) {
    const kind = block.split(' ')[0];
    const source = `#+begin_${block}\n#+TITLE: Fake metadata\n* Fake title\n#+end_${kind}\n* Real title\nBody.`;
    both({ name: 'file.org', source }, 'Real title');
    both({ name: 'file.org', source: source.slice(0, source.indexOf('\n* Real title')) }, 'file');
  }
  both({ name: 'file.org', source: '#+begin_src org\n* Unclosed fake' }, 'file');
});

test('filename override keeps metadata and every content heading in the rendered body', () => {
  for (const [name, source, label] of [
    ['file.md', '---\ntitle: Explicit title\nauthor: Chad\n---\n# Explicit title\nBody.\n# Another title', 'Explicit title'],
    ['file.org', '#+TITLE: Explicit title\n#+AUTHOR: Chad\n* Explicit title\nBody.\n* Another title', 'Explicit title'],
  ]) {
    const doc = { name, source };
    const content = both(doc, label);
    assert.equal(content.outline[0].id, 'document-title');
    assert.doesNotMatch(content.html, /<h\d[^>]*>Explicit title/);
    const filename = both(doc, 'file', { filenameHeadings: true });
    assert.equal(filename.author, 'Chad');
    assert.match(filename.html, /<h\d[^>]*>Explicit title<\/h\d>/);
    assert.match(filename.html, /Another title/);
    assert.notEqual(filename.outline[0].id, 'document-title');
  }
  const different = both({ name: 'file.org', source: '#+TITLE: Metadata\n* Different heading\nBody.' }, 'Metadata');
  assert.match(different.html, /Different heading/);
});

test('promoted Org headings preserve custom IDs, duplicate IDs and internal links', () => {
  const source = 'Introduction.\r\n* [[https://example.com][Café]] 日本語\r\n:PROPERTIES:\r\n:CUSTOM_ID: custom\r\n:END:\r\nBody.\r\n* Café 日本語\r\n[[#custom][Custom]] [[*Café 日本語][Heading]]\r\n';
  const preview = both({ name: 'file.org', source }, 'Café 日本語');
  assert.equal(preview.outline[0].id, 'document-title');
  for (const value of ['custom', 'org-custom']) assert.equal(resolveAnchor(preview, { kind: 'anchor', value }), 'document-title');
  assert.equal(resolveAnchor(preview, { kind: 'heading', value: 'Café 日本語' }), 'document-title');
  assert.match(preview.html, /href="#document-title">Custom/);
  assert.match(preview.html, /href="#document-title">Heading/);
  assert.match(preview.html, /id="org-café-日本語"/);
  assert.match(preview.html, /Body\./);
  const overridden = both({ name: 'file.org', source }, 'file', { filenameHeadings: true });
  assert.equal(resolveAnchor(overridden, { kind: 'anchor', value: 'custom' }), 'org-custom');
  assert.match(overridden.html, /href="#org-custom">Custom/);
});

test('promoted Markdown H1s retain links and duplicate heading numbering', () => {
  const preview = both({ name: 'file.md', source: 'Intro.\n\n# Main\n\n# Main\n\n[Title](#main) [Next](#main-1)' }, 'Main');
  assert.deepEqual(preview.outline.map((item) => item.id), ['document-title', 'md-heading-main-1']);
  assert.match(preview.html, /href="#document-title">Title/);
  assert.match(preview.html, /href="#md-heading-main-1">Next/);
});

test('renderer forwards title-only and filename preferences while replacing stale work', async () => {
  const workers = [];
  const renderer = createDocumentRenderer({ createWorker() {
    const worker = { postMessage(message) { this.message = message; }, terminate() { this.terminated = true; } };
    workers.push(worker);
    return worker;
  } });
  const doc = { name: 'file.org', format: 'org', source: '* Current', id: 'not-forwarded' };
  const old = renderer.render(doc, { titleOnly: true });
  const current = renderer.render(doc, { filenameHeadings: true });
  await assert.rejects(old, /document changed/);
  assert.deepEqual(workers[0].message, { name: 'file.org', format: 'org', source: '* Current', titleOnly: true, filenameHeadings: false });
  assert.deepEqual(workers[1].message, { name: 'file.org', format: 'org', source: '* Current', titleOnly: false, filenameHeadings: true });
  assert.equal(workers[0].terminated, true);
  workers[0].onmessage({ data: { preview: { title: 'Stale' } } });
  workers[1].onmessage({ data: { preview: { title: 'file' } } });
  assert.deepEqual(await current, { title: 'file' });
  assert.equal(workers[1].terminated, true);
});

test('actual render worker supports title-only results without HTML or resource rendering', async () => {
  const module = new URL('../src/render-worker.js', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    global.self = { postMessage: (result) => parentPort.postMessage(result) };
    import(${JSON.stringify(module)}).then(() => {
      parentPort.on('message', (data) => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    }).catch((error) => { throw error; });
  `, { eval: true });
  const message = () => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  try {
    assert.deepEqual(await message(), { ready: true });
    for (const filenameHeadings of [false, true]) {
      const result = message();
      worker.postMessage({ name: 'file.org', format: 'org', source: '* Current\n#+begin_src js\nconst x = 1;\n#+end_src', titleOnly: true, filenameHeadings });
      assert.deepEqual(await result, { preview: { title: filenameHeadings ? 'file' : 'Current' } });
    }
  } finally { await worker.terminate(); }
});
