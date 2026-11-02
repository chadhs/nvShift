import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAnalyzer } from '../electron/analysis.cjs';
import { createResources } from '../electron/resources.cjs';
import { analyzeDocument } from '../src/document-analysis.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
const source = (label) => `![Image](chart.png)\n[Other](other.md)\n\n\`\`\`mermaid\nflowchart LR\n${label}-->End\n\`\`\``;
const references = (doc) => analyzeDocument(doc);
async function fixture(t, diagrams = { async render() { return { svg: '<svg/>' }; }, cancel() {} }, identical = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-resources-workspace-'));
  await fs.writeFile(path.join(directory, 'chart.png'), png);
  const docs = new Map(['a', 'b', 'hidden'].map((id) => [id, { id, path: path.join(directory, `${id}.md`), name: `${id}.md`, revision: 1, format: 'markdown', source: source(identical ? 'Same' : id) }]));
  const visible = new Set(['a', 'b']);
  const resources = createResources({ get: (id) => docs.has(id) ? { ...docs.get(id) } : null, active: () => ({ ...docs.get('a') }) }, diagrams, { visibleIds: () => visible });
  t.after(async () => { resources.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { resources, docs, visible };
}

test('both visible documents authorize resources while hidden and stale revisions reject', async (t) => {
  const f = await fixture(t);
  for (const id of ['a', 'b']) {
    const ref = references(f.docs.get(id));
    assert.ok((await f.resources.image(id, 1, ref.images[0])).dataUrl);
    assert.equal((await f.resources.link(id, 1, ref.links[0])).target, 'other.md');
    assert.equal((await f.resources.diagram(id, 1, ref.diagrams[0], 'light')).svg, '<svg/>');
  }
  const hidden = references(f.docs.get('hidden'));
  assert.match((await f.resources.image('hidden', 1, hidden.images[0])).error, /changed/);
  assert.match((await f.resources.diagram('hidden', 1, hidden.diagrams[0], 'light')).error, /changed/);
  await assert.rejects(f.resources.link('hidden', 1, hidden.links[0]), /changed/);
  f.docs.set('b', { ...f.docs.get('b'), revision: 2 });
  f.resources.changed(f.docs.get('b'));
  assert.match((await f.resources.image('b', 1, hidden.images[0])).error, /changed/);
});

test('analysis cancellation can target one snapshot without interrupting another revision of the same document', async () => {
  const analyzer = createAnalyzer();
  const old = {}, next = {};
  const first = analyzer.analyze({ id: 'same', revision: 1, source: source('Old'), format: 'markdown' }, { scope: old });
  const rejected = assert.rejects(first, /document changed/);
  const second = analyzer.analyze({ id: 'same', revision: 2, source: source('Next'), format: 'markdown' }, { scope: next });
  analyzer.cancel(old);
  try {
    await rejected;
    assert.equal((await second).images[0].target, 'chart.png');
  } finally { analyzer.cancel(); }
});

test('editing one visible document cancels only its pending image analysis', async (t) => {
  const f = await fixture(t);
  const a = f.resources.image('a', 1, references(f.docs.get('a')).images[0]);
  const b = f.resources.image('b', 1, references(f.docs.get('b')).images[0]);
  f.docs.set('a', { ...f.docs.get('a'), revision: 2, source: 'Changed contents' });
  f.resources.changed(f.docs.get('a'));
  assert.match((await a).error, /changed/);
  assert.equal((await b).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
});

test('closing one pane cancels only its link analysis and reopening permits a fresh request', async (t) => {
  const f = await fixture(t);
  const aRef = references(f.docs.get('a')).links[0];
  const first = assert.rejects(f.resources.link('a', 1, aRef), /changed/);
  const second = f.resources.link('b', 1, references(f.docs.get('b')).links[0]);
  f.visible.delete('a');
  f.resources.syncVisibility();
  await first;
  assert.equal((await second).target, 'other.md');
  f.visible.add('a');
  assert.equal((await f.resources.link('a', 1, aRef)).target, 'other.md');
});

test('closing a pane does not cancel the other visible document diagram', async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const bothStarted = new Promise((resolve) => { started = resolve; });
  let renders = 0, cancellations = 0;
  const f = await fixture(t, {
    async render(_source, _theme, isCurrent) { if (++renders === 2) started(); await gate; return isCurrent() ? { svg: '<svg/>' } : { error: 'Interrupted' }; },
    cancel() { cancellations++; },
  });
  const a = f.resources.diagram('a', 1, references(f.docs.get('a')).diagrams[0], 'light');
  const b = f.resources.diagram('b', 1, references(f.docs.get('b')).diagrams[0], 'light');
  try {
    await bothStarted;
    f.visible.delete('a'); f.resources.syncVisibility();
    assert.equal(cancellations, 0);
    release();
    assert.match((await a).error, /changed/);
    assert.equal((await b).svg, '<svg/>');
  } finally { release(); }
});

test('a shared diagram stays usable by its remaining visible recipient', async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  let renders = 0;
  const f = await fixture(t, { async render(_source, _theme, isCurrent) { renders++; started(); await gate; return isCurrent() ? { svg: '<svg/>' } : { error: 'Interrupted' }; }, cancel() {} }, true);
  const ref = references(f.docs.get('a'));
  const a = f.resources.diagram('a', 1, ref.diagrams[0], 'light');
  try {
    await began;
    const b = f.resources.diagram('b', 1, ref.diagrams[0], 'light');
    await f.resources.link('b', 1, ref.links[0]);
    f.visible.delete('a'); f.resources.syncVisibility();
    release();
    assert.match((await a).error, /changed/);
    assert.equal((await b).svg, '<svg/>');
    assert.equal(renders, 1);
  } finally { release(); }
});

test('closing and reopening the same revision cannot revive an old diagram recipient', async (t) => {
  let release, started;
  const gate = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { async render() { started(); await gate; return { svg: '<svg/>' }; }, cancel() {} });
  const ref = references(f.docs.get('a')).diagrams[0];
  const old = f.resources.diagram('a', 1, ref, 'light');
  try {
    await began;
    f.visible.delete('a'); f.resources.syncVisibility(); f.visible.add('a');
    const next = f.resources.diagram('a', 1, ref, 'light');
    release();
    assert.match((await old).error, /changed/);
    assert.equal((await next).svg, '<svg/>');
  } finally { release(); }
});
