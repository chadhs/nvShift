import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../src/markdown.js';
import { documentResource } from '../electron/resource-index.cjs';

const yaml = '---\ntitle: Hugo post\nauthor: Chad Stovern\ndate: 2026-09-11\ntags: [linux, omarchy]\ndraft: false\n---\n';
const toml = '+++\ntitle = "Hugo post"\nauthor = "Chad Stovern"\ndate = 2026-09-11\ntags = ["linux", "omarchy"]\ndraft = false\n+++\n';
for (const [format, header] of [['YAML', yaml], ['TOML', toml]]) {
  test(`Markdown Hugo ${format} front matter supplies metadata and preserves the body`, async () => {
    const source = header + '\n# A different heading\n\n![Chart](chart.png)\n\n[Other](other.org::#target)\n\n~~~mermaid\nflowchart LR\nA-->B\n~~~';
    const parsed = renderMarkdown(source);
    assert.equal(parsed.title, 'Hugo post');
    assert.equal(parsed.author, 'Chad Stovern');
    assert.equal(parsed.date, '2026-09-11');
    assert.deepEqual(parsed.tags, ['linux', 'omarchy']);
    assert.equal(parsed.draft, false);
    assert.equal(parsed.metadataWarning, '');
    assert.doesNotMatch(parsed.html, /title[:=]|draft[:=]|linux/);
    assert.match(parsed.html, /A different heading/);
    for (const kind of ['images', 'links', 'diagrams']) for (const resource of parsed[kind]) {
      assert.equal(source.slice(resource.start, resource.end), resource.reference);
      assert.ok(await documentResource({ path: '/post.md', format: 'markdown', source }, kind, resource));
    }
    const same = renderMarkdown(header + '\n# Hugo post\nBody.');
    assert.equal(same.outline[0].id, 'document-title');
    assert.doesNotMatch(same.html, /<h[1-6]/);
    assert.equal(renderMarkdown(header.replace('false', 'true')).draft, true);
    assert.equal(renderMarkdown(header.replace('false', '"true"')).draft, false);
  });
}

test('Markdown Hugo metadata handles params.author, blank fields, and malformed data safely', () => {
  assert.equal(renderMarkdown('---\nparams:\n  author: Chad\n---\n\n# Body').author, 'Chad');
  assert.equal(renderMarkdown('---\nauthor: [One, Two]\n---').author, 'One, Two');
  assert.equal(renderMarkdown('---\ntitle: 123\ndraft: yes\n---\n\n# Body').title, 'Body');
  assert.equal(renderMarkdown('---\ndraft: yes\n---').draft, false);
  for (const source of ['---\ntags: [broken\n---\n\nBody.', '+++\ntitle = ???\n+++\n\nBody.', '---\ntitle: &title "Alias"\nauthor: *title\n---\n\nBody.']) {
    const parsed = renderMarkdown(source);
    assert.match(parsed.metadataWarning, /Could not read/);
    assert.match(parsed.html, /frontmatter-source/);
    assert.match(parsed.html, /Body\./);
    assert.equal(parsed.draft, false);
  }
});
