import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspace } from '../electron/workspace.cjs';
import { createLibrary } from '../electron/library.cjs';

function fixture() {
  const docs = new Map(['a', 'b', 'c', 'd'].map((id) => [id, { id, name: `${id}.md`, source: id, format: 'markdown', status: 'saved', revision: 1, clientVersion: 0 }]));
  const opened = new Set(['a']), counts = new Map(), saves = [];
  let activeId = 'a', root = '/notes', failSave = null, holdOpen = null;
  const library = {
    snapshot: () => ({ root }), active: () => docs.get(activeId) ?? null, get: (id) => docs.get(id) ?? null,
    documents: () => [...docs.values()],
    async openDocument(id) {
      if (holdOpen) await holdOpen;
      if (!docs.has(id)) throw new Error('Missing note');
      if (!opened.has(id)) { counts.set(id, (counts.get(id) ?? 0) + 1); opened.add(id); }
      return this.get(id);
    },
    releaseDocument(id) { opened.delete(id); },
    async focusDocument(id) { activeId = id; return this.get(id); },
    async save(id) { saves.push(id); if (failSave) throw failSave; return this.get(id); },
    async create(title) { const id = title; docs.set(id, { id, name: `${title}.txt`, source: '', format: 'plain', status: 'saved', revision: 1 }); opened.add(id); activeId = id; return this.get(id); },
  };
  const events = [];
  const workspace = createWorkspace({ library, onChange: (state) => events.push(state) });
  return { workspace, library, docs, opened, counts, saves, events,
    setRoot(value) { root = value; }, failSave(value) { failSave = value; }, holdOpen(value) { holdOpen = value; } };
}
const ids = (workspace) => workspace.snapshot().groups.flatMap((g) => g.tabs.map((tab) => tab.documentId));
const focused = (workspace) => workspace.snapshot().groups.find((g) => g.id === workspace.snapshot().focusedGroupId);
const send = (workspace, type, fields = {}) => workspace.command({ type, ...fields });

test('ordinary opening replaces while explicit tabs append and duplicate opens focus the existing tab', async () => {
  const { workspace } = fixture(); await workspace.reset();
  await send(workspace, 'open', { id: 'b' });
  assert.deepEqual(ids(workspace), ['b']);
  await send(workspace, 'open', { id: 'c', disposition: 'new-tab' });
  assert.deepEqual(ids(workspace), ['b', 'c']);
  const original = focused(workspace).tabs[0];
  await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
  assert.deepEqual(ids(workspace), ['b', 'c']);
  assert.equal(focused(workspace).activeTabId, original.id);
});

test('new-tab opening after browsing preserves the original document and cancellation restores it', async () => {
  const { workspace, counts } = fixture(); await workspace.reset();
  await send(workspace, 'open', { id: 'b', disposition: 'browse' });
  assert.equal(workspace.active().id, 'b'); assert.deepEqual(ids(workspace), ['a']);
  assert.deepEqual(workspace.visibleIds(), ['b']);
  assert.deepEqual(Object.keys(workspace.documents()).sort(), ['a', 'b']);
  await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
  assert.deepEqual(ids(workspace), ['a', 'b']); assert.equal(counts.get('b'), 1);
  await send(workspace, 'open', { id: 'c', disposition: 'browse' });
  await send(workspace, 'cancelBrowse');
  assert.equal(workspace.active().id, 'b'); assert.deepEqual(ids(workspace), ['a', 'b']);
  await send(workspace, 'open', { id: 'c', disposition: 'browse' });
  await send(workspace, 'commitBrowse');
  assert.deepEqual(ids(workspace), ['a', 'c']);
});

test('two groups preserve reference pane while browsing and support merge, moving, and independent views', async () => {
  const { workspace } = fixture(); await workspace.reset({ viewMode: 'split' });
  await send(workspace, 'toggleLayout');
  assert.equal(workspace.snapshot().layout, 'columns');
  assert.deepEqual(workspace.snapshot().groups.map((g) => g.viewMode), ['editor', 'editor']);
  await send(workspace, 'open', { id: 'b' });
  const [left, right] = workspace.snapshot().groups;
  await send(workspace, 'focusGroup', { groupId: left.id });
  await send(workspace, 'open', { id: 'c', disposition: 'browse' });
  assert.deepEqual(workspace.visibleIds(), ['c', 'b']);
  await send(workspace, 'open', { id: 'b', disposition: 'browse' });
  assert.equal(workspace.snapshot().focusedGroupId, left.id);
  assert.deepEqual(workspace.visibleIds(), ['a', 'b']);
  await send(workspace, 'open', { id: 'd', disposition: 'new-tab' });
  await send(workspace, 'moveTab');
  assert.deepEqual(workspace.snapshot().groups[1].tabs.map((t) => t.documentId), ['b', 'd']);
  await send(workspace, 'setView', { mode: 'editor' });
  assert.equal(workspace.snapshot().groups[1].viewMode, 'editor');
  await assert.rejects(send(workspace, 'setView', { mode: 'split' }), /available/);
  await send(workspace, 'toggleLayout');
  assert.deepEqual(ids(workspace), ['a', 'b', 'd']);
  assert.equal(workspace.active().id, 'd'); assert.equal(focused(workspace).viewMode, 'split');
  assert.equal(workspace.snapshot().layout, 'single');
});

test('new panes inherit the focused view and later navigation keeps each pane’s chosen mode', async (t) => {
  for (const creation of ['toggleLayout', 'moveTab']) for (const mode of ['editor', 'preview', 'split']) {
    await t.test(`${creation} from ${mode}`, async () => {
      const { workspace } = fixture();
      await workspace.reset({ viewMode: mode });
      await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
      await send(workspace, creation);
      const [left, right] = workspace.snapshot().groups;
      const expected = mode === 'preview' ? 'preview' : 'editor';
      assert.equal(left.viewMode, expected);
      assert.equal(right.viewMode, expected);
      assert.equal(workspace.snapshot().focusedGroupId, right.id);

      await send(workspace, 'newTab');
      assert.equal(focused(workspace).viewMode, expected);
      await send(workspace, 'open', { id: 'c' });
      assert.equal(focused(workspace).viewMode, expected);
      const opposite = expected === 'editor' ? 'preview' : 'editor';
      await send(workspace, 'setView', { mode: opposite });
      await send(workspace, 'open', { id: 'd' });
      assert.equal(focused(workspace).viewMode, opposite);
      assert.equal(workspace.snapshot().groups[0].viewMode, expected);

      await send(workspace, 'open', { id: 'a', disposition: 'new-tab' });
      assert.equal(workspace.snapshot().focusedGroupId, left.id);
      assert.equal(focused(workspace).viewMode, expected);
      assert.equal(workspace.snapshot().groups[1].viewMode, opposite);
      await send(workspace, 'create', { groupId: right.id, title: 'new-note', extension: 'txt' });
      assert.equal(focused(workspace).viewMode, 'editor');
      assert.equal(workspace.snapshot().groups[0].viewMode, expected);
    });
  }
});

test('safe closing keeps failed or conflicted notes open, then chooses next or previous deterministically', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
  await send(workspace, 'open', { id: 'c', disposition: 'new-tab' });
  const middle = focused(workspace).tabs[1];
  f.failSave(new Error('Disk full'));
  await assert.rejects(send(workspace, 'open', { id: 'd' }), /Disk full/);
  assert.deepEqual(ids(workspace), ['a', 'b', 'c']);
  await assert.rejects(send(workspace, 'closeTab', { tabId: middle.id }), /Disk full/);
  assert.deepEqual(ids(workspace), ['a', 'b', 'c']);
  f.failSave(null); f.docs.get('b').status = 'conflict'; f.docs.get('b').error = 'Choose Keep both';
  await assert.rejects(send(workspace, 'closeTab', { tabId: middle.id }), /Keep both/);
  f.docs.get('b').status = 'saved';
  await send(workspace, 'selectTab', { tabId: middle.id });
  await send(workspace, 'closeTab'); assert.equal(workspace.active().id, 'c');
  await send(workspace, 'closeTab'); assert.equal(workspace.active().id, 'a');
  await send(workspace, 'closeTab'); assert.equal(workspace.active(), null); assert.deepEqual(ids(workspace), []);
  assert.ok(f.docs.has('a')); assert.equal(f.library.active(), null);
});

test('focus and moves retain a document opening lifetime while close/reopen detects again', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
  const a = focused(workspace).tabs[0], b = focused(workspace).tabs[1];
  await send(workspace, 'selectTab', { tabId: a.id });
  await send(workspace, 'selectTab', { tabId: b.id });
  await send(workspace, 'toggleLayout');
  await send(workspace, 'moveTab', { groupId: workspace.snapshot().groups[0].id, tabId: b.id });
  assert.equal(f.counts.get('b'), 1);
  await send(workspace, 'closeTab');
  await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
  assert.equal(f.counts.get('b'), 2);
});

test('blank tabs fill on open/create, empty groups collapse and view defaults restore', async () => {
  const { workspace } = fixture(); await workspace.reset({ viewMode: 'preview' });
  await send(workspace, 'newTab'); assert.deepEqual(ids(workspace), ['a', null]);
  await send(workspace, 'open', { id: 'b' }); assert.deepEqual(ids(workspace), ['a', 'b']);
  await send(workspace, 'toggleLayout');
  await send(workspace, 'create', { title: 'new-note', extension: 'txt' });
  assert.equal(focused(workspace).viewMode, 'editor');
  await send(workspace, 'closeTab');
  assert.equal(workspace.snapshot().layout, 'single');
  assert.equal(focused(workspace).viewMode, 'preview');
});

test('reset starts fresh, restore rebuilds groups, and recovered documents remain visible', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  await send(workspace, 'toggleLayout'); await send(workspace, 'open', { id: 'b' });
  const saved = workspace.snapshot();
  await workspace.reset(); assert.equal(workspace.snapshot().layout, 'single'); assert.deepEqual(ids(workspace), ['b']);
  await workspace.restore(saved); assert.deepEqual(ids(workspace), ['a', 'b']);
  f.docs.get('c').status = 'conflict';
  await workspace.reset(); assert.deepEqual(ids(workspace), ['b', 'c']);
  assert.deepEqual(workspace.visibleIds(), ['b']);
});

test('generation changes reject in-flight and queued navigation before it changes the new workspace', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  f.holdOpen(new Promise((resolve) => { release = resolve; }));
  const originalOpen = f.library.openDocument.bind(f.library);
  f.library.openDocument = async (id) => { started(); return originalOpen(id); };
  const oldGeneration = workspace.snapshot().generation;
  const opening = send(workspace, 'open', { id: 'b' });
  const rejected = assert.rejects(opening, /workspace changed/);
  await began;
  const reset = workspace.reset(); release(); await rejected; await reset;
  await assert.rejects(send(workspace, 'open', { id: 'c', generation: oldGeneration }), /workspace changed/);
  assert.deepEqual(ids(workspace), ['a']);
});

test('background document changes do not broadcast workspace, while removals and late conflicting drafts do', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  await send(workspace, 'open', { id: 'b', disposition: 'new-tab' });
  const count = f.events.length;
  assert.equal(workspace.changed(f.docs.get('a')), true); assert.equal(f.events.length, count);
  const old = f.docs.get('a'); f.docs.delete('a'); workspace.removed('a');
  assert.deepEqual(ids(workspace), ['b']);
  f.docs.set('a', { ...old, status: 'conflict', source: 'late draft' });
  workspace.changed(f.docs.get('a'));
  assert.deepEqual(ids(workspace), ['b', 'a']); assert.equal(workspace.active().source, 'late draft');
});

test('workspace txt opening/focus/reopen integrates with the library detector and creation defaults', async (t) => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-workspace-')));
  const root = path.join(directory, 'notes'); await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'a.md'), '# Start');
  await fs.writeFile(path.join(root, 'b.txt'), '# Heading');
  const future = new Date(Date.now() + 60000); await fs.utimes(path.join(root, 'a.md'), future, future);
  const detections = [];
  const library = createLibrary({ userData: path.join(directory, 'profile'), syntaxDetector: { async detect(source) { detections.push(source); return { format: source.startsWith('# ') ? 'markdown' : 'plain', reason: source.startsWith('# ') ? 'markdown' : 'ambiguous' }; }, async close() {} } });
  t.after(async () => { await library.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  await library.open(root, { txtSyntax: 'org' });
  const workspace = createWorkspace({ library }); await workspace.reset();
  const b = library.getByPath(path.join(root, 'b.txt'));
  await send(workspace, 'open', { id: b.id, disposition: 'new-tab' });
  const [aTab, bTab] = focused(workspace).tabs;
  assert.equal(workspace.active().format, 'markdown'); assert.equal(detections.length, 1);
  await library.updateBuffer(b.id, 'Plain now', 1, workspace.active().revision);
  await send(workspace, 'selectTab', { tabId: aTab.id });
  await send(workspace, 'selectTab', { tabId: bTab.id });
  assert.equal(workspace.active().format, 'markdown'); assert.equal(detections.length, 1);
  await send(workspace, 'closeTab');
  await send(workspace, 'open', { id: b.id, disposition: 'new-tab' });
  assert.equal(workspace.active().format, 'plain'); assert.equal(detections.length, 2);
  await send(workspace, 'create', { title: 'Created', extension: 'txt' });
  assert.equal(workspace.active().format, 'org'); assert.equal(detections.length, 2);
});

test('invalidated in-flight search browsing returns quietly without replacing the origin or publishing stale state', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  let started, release;
  const began = new Promise((resolve) => { started = resolve; });
  f.holdOpen(new Promise((resolve) => { release = resolve; }));
  const original = f.library.openDocument.bind(f.library);
  f.library.openDocument = async (id) => { started(); return original(id); };
  const before = workspace.snapshot(), eventsBefore = f.events.length;
  const pending = send(workspace, 'open', { id: 'b', disposition: 'browse' });
  await began;
  assert.equal(workspace.invalidateBrowse(before.focusedGroupId, before.generation), true);
  release();
  const result = await pending;
  assert.equal(result.document.id, 'a');
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal(f.events.length, eventsBefore);
  assert.equal(f.opened.has('b'), false);
  assert.equal(workspace.invalidateBrowse(before.focusedGroupId, before.generation - 1), false);
});

test('invalid move targets and tab IDs leave the workspace unchanged', async () => {
  const { workspace } = fixture(); await workspace.reset({ viewMode: 'split' });
  const before = workspace.snapshot();
  await assert.rejects(send(workspace, 'moveTab', { targetGroupId: 'missing' }), /other document pane/);
  assert.deepEqual(workspace.snapshot(), before);
  await assert.rejects(send(workspace, 'moveTab', { targetGroupId: before.focusedGroupId }), /other document pane/);
  assert.deepEqual(workspace.snapshot(), before);
  await send(workspace, 'open', { id: 'b', disposition: 'browse' });
  const browsing = workspace.snapshot();
  await assert.rejects(send(workspace, 'closeTab', { tabId: 'missing' }), /no longer open/);
  assert.deepEqual(workspace.snapshot(), browsing);
});

test('a delayed browse command with an older renderer token never starts detection or changes selection', async () => {
  const f = fixture(); const { workspace } = f; await workspace.reset();
  const before = workspace.snapshot();
  workspace.invalidateBrowse(before.focusedGroupId, before.generation, 'renderer:2');
  const result = await send(workspace, 'open', { id: 'b', disposition: 'browse', browseToken: 'renderer:1' });
  assert.equal(result.document.id, 'a');
  assert.deepEqual(workspace.snapshot(), before);
  assert.equal(f.counts.get('b'), undefined);
  await send(workspace, 'open', { id: 'c', disposition: 'browse', browseToken: 'renderer:2' });
  assert.equal(workspace.active().id, 'c');
  assert.equal(f.counts.get('c'), 1);
});
