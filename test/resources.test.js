import test from 'node:test';
import assert from 'node:assert/strict';
import { createResources } from '../electron/resources.cjs';
import { analyzeDocument } from '../src/document-analysis.js';

test('diagram requests authorize unsaved source and cache identical source across revisions', async () => {
  let doc = { id: 'note', path: '/notes/a.txt', name: 'a.txt', format: 'markdown', source: '```mermaid\nflowchart LR\nA-->B\n```', revision: 1 };
  let renders = 0;
  const diagrams = { render: async () => { renders++; return { svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }; }, cancel() {} };
  const resources = createResources({ get: () => ({ ...doc }), active: () => ({ ...doc }) }, diagrams);
  try {
    const reference = analyzeDocument(doc).diagrams[0];
    assert.ok((await resources.diagram('note', 1, reference, 'light')).svg);
    doc = { ...doc, revision: 2, source: doc.source + '\nExtra text' };
    assert.ok((await resources.diagram('note', 2, reference, 'light')).svg);
    assert.equal(renders, 1);
    assert.match((await resources.diagram('note', 1, reference, 'light')).error, /changed/);
    assert.ok((await resources.diagram('note', 2, { ...reference, start: 1 }, 'light')).error);
    assert.ok((await resources.diagram('note', 2, reference, 'dark')).svg);
    assert.equal(renders, 2);
  } finally { resources.dispose(); }
});

test('one pending diagram can serve a newly selected note while rejecting the old recipient', async () => {
  const source = '```mermaid\nflowchart LR\nA-->B\n```';
  const docs = new Map(['first', 'second'].map((id) => [id, { id, path: `/notes/${id}.md`, name: `${id}.md`, format: 'markdown', source, revision: 1 }]));
  let active = 'first', renders = 0, release, started;
  const running = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const resources = createResources({ get: (id) => ({ ...docs.get(id) }), active: () => ({ ...docs.get(active) }) }, {
    async render(_source, _theme, isCurrent) { renders++; started(); await gate; return isCurrent() ? { svg: '<svg/>' } : { error: 'Interrupted' }; },
    cancel() {},
  });
  try {
    const reference = analyzeDocument(docs.get('first')).diagrams[0];
    const first = resources.diagram('first', 1, reference, 'light');
    await running;
    active = 'second';
    resources.changed(docs.get('second'));
    const second = resources.diagram('second', 1, reference, 'light');
    release();
    assert.match((await first).error, /changed/);
    assert.equal((await second).svg, '<svg/>');
    assert.equal(renders, 1);
  } finally { release(); resources.dispose(); }
});
