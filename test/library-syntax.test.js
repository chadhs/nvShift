import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLibrary, atomicReplace } from '../electron/library.cjs';
import { createSyntaxDetector } from '../electron/syntax-client.cjs';
import { createSettings } from '../electron/settings.cjs';
import { createResources } from '../electron/resources.cjs';
import { renderDocument } from '../src/documents.js';
import { insertImageBytes } from '../electron/assets.cjs';

const exec = promisify(execFile);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII=', 'base64');
async function fixture(t, files = {}, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-syntax-')));
  const root = path.join(directory, 'notes'), userData = path.join(directory, 'profile');
  await fs.mkdir(root);
  for (const [name, source] of Object.entries(files)) await fs.writeFile(path.join(root, name), source);
  let library = createLibrary({ userData, ...options });
  t.after(async () => { await library.dispose().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, root, userData, get library() { return library; }, async restart(preferences = {}) { await library.dispose(); library = createLibrary({ userData, ...options }); await library.open(root, preferences); } };
}
async function waitFor(check) {
  const end = Date.now() + 6000;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  assert.fail('Timed out waiting for syntax update.');
}
const at = (f, name) => f.library.getByPath(path.join(f.root, name));

test('mixed txt detection is independent of legacy folder preferences and does not modify disk bytes', async (t) => {
  const files = { 'markdown.txt': '\ufeff# Café 日本語\r\n', 'org.txt': '#+TITLE: 世界\n* Heading\n', 'ambiguous.txt': '* Heading\n- list\n', 'conflict.txt': '# Markdown\n#+TITLE: Org\n', 'fixed.md': '#+TITLE: Still Markdown', 'fixed.org': '# Still Org' };
  const f = await fixture(t, files);
  await f.library.open(f.root, { txtSyntax: 'org' });
  for (const [name, format] of [['markdown.txt', 'markdown'], ['org.txt', 'org'], ['ambiguous.txt', 'plain'], ['conflict.txt', 'plain'], ['fixed.md', 'markdown'], ['fixed.org', 'org']]) {
    const note = at(f, name);
    assert.equal(note.format, format);
    assert.equal(note.syntaxMode, name.endsWith('.txt') ? 'auto' : 'fixed');
    assert.equal(await fs.readFile(note.path, 'utf8'), files[name]);
  }
  for (const txtSyntax of ['plain', 'markdown', 'org']) {
    await f.library.setPreferences({ txtSyntax });
    assert.equal(at(f, 'markdown.txt').format, 'markdown');
    assert.equal(at(f, 'ambiguous.txt').format, 'plain');
  }
});

test('creation hints persist locally across preferences, clear evidence, rename, and restart', async (t) => {
  const f = await fixture(t);
  await f.library.open(f.root, { defaultExtension: 'txt', txtSyntax: 'org' });
  let note = await f.library.create('New');
  const id = note.id;
  assert.equal(note.source, ''); assert.equal(note.format, 'org'); assert.equal(note.syntaxMode, 'auto');
  await f.library.setPreferences({ txtSyntax: 'markdown' });
  assert.equal(f.library.get(id).format, 'org');
  assert.equal((await f.library.create('Future')).format, 'markdown');
  note = await f.library.updateBuffer(id, '# Markdown wins\n', 1, note.revision);
  assert.equal(note.format, 'markdown');
  note = await f.library.updateBuffer(id, 'Ordinary prose', 2, note.revision);
  assert.equal(note.format, 'org');
  note = await f.library.updateBuffer(id, '# Markdown\n#+TITLE: Conflict', 3, note.revision);
  assert.equal(note.format, 'plain'); assert.equal(note.syntaxDetection, 'conflicting');
  note = await f.library.updateBuffer(id, 'Ordinary prose', 4, note.revision);
  note = await f.library.rename(id, 'Renamed 世界');
  await f.restart({ txtSyntax: 'plain' });
  const restored = at(f, 'Renamed 世界.txt');
  assert.equal(restored.id, id); assert.equal(restored.format, 'org'); assert.equal(restored.syntaxMode, 'auto');
  assert.equal(await fs.readFile(restored.path, 'utf8'), 'Ordinary prose');
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['Future.txt', 'Renamed 世界.txt']);
  assert.equal(at(f, 'Future.txt').format, 'markdown');
});

test('manual modes persist through case-only rename and restart; automatic resumes current-content detection', async (t) => {
  const f = await fixture(t, { 'Note.txt': '# Markdown\n', 'Fixed.org': '#+TITLE: Org' });
  await f.library.open(f.root);
  let note = at(f, 'Note.txt');
  const original = await fs.readFile(note.path);
  for (const syntaxMode of ['plain', 'markdown', 'org']) {
    const revision = note.revision;
    note = await f.library.setSyntax(note.id, syntaxMode);
    assert.equal(note.syntaxMode, syntaxMode); assert.equal(note.format, syntaxMode);
    assert.ok(note.revision > revision);
    assert.deepEqual(await fs.readFile(note.path), original);
  }
  note = await f.library.rename(note.id, 'note');
  const id = note.id;
  await f.restart();
  note = at(f, 'note.txt');
  assert.equal(note.id, id); assert.equal(note.syntaxMode, 'org'); assert.equal(note.format, 'org');
  note = await f.library.setSyntax(id, 'auto');
  assert.equal(note.format, 'markdown'); assert.equal(note.syntaxMode, 'auto');
  await assert.rejects(f.library.setSyntax(id, 'html'), /Choose/);
  await assert.rejects(f.library.setSyntax(at(f, 'Fixed.org').id, 'plain'), /Only .txt/);
});

test('external edits, unsaved edits, and stale client versions keep source, format, and resources aligned', async (t) => {
  const f = await fixture(t, { 'Note.txt': '# Markdown' });
  await f.library.open(f.root);
  let note = at(f, 'Note.txt');
  await fs.writeFile(note.path, '#+TITLE: 外から\n[[file:chart.png]]');
  await fs.writeFile(path.join(f.root, 'chart.png'), png);
  await waitFor(() => f.library.get(note.id).format === 'org');
  note = f.library.get(note.id);
  assert.equal(renderDocument(note).title, '外から');
  const resources = createResources(f.library, { render: async () => { throw new Error('Unexpected diagram'); }, cancel() {} });
  t.after(() => resources.dispose());
  await f.library.activate(note.id);
  const oldRevision = note.revision;
  const updated = await f.library.updateBuffer(note.id, '# Unsaved Markdown\n![Image](chart.png)', 1, note.revision);
  assert.equal(updated.format, 'markdown'); assert.equal(renderDocument(updated).title, 'Unsaved Markdown');
  assert.equal(await fs.readFile(note.path, 'utf8'), '#+TITLE: 外から\n[[file:chart.png]]');
  const preview = renderDocument(updated);
  assert.equal(preview.images.length, 1);
  assert.match((await resources.image(updated.id, updated.revision, preview.images[0])).dataUrl, /^data:image\/png/);
  assert.match((await resources.image(note.id, oldRevision, preview.images[0])).error, /changed/);
  const stale = await f.library.updateBuffer(note.id, '#+TITLE: Stale', 0, oldRevision);
  assert.equal(stale.format, 'markdown'); assert.equal(stale.source, updated.source);
});

test('serial async detection and writable snapshots use the latest queued buffer for image insertion', async (t) => {
  const detector = createSyntaxDetector();
  let release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { 'Note.txt': 'Plain' }, { syntaxDetector: {
    async detect(source) { if (source === '# Slow Markdown') { started(); await gate; } return detector.detect(source); },
    close: () => detector.close(),
  } });
  await f.library.open(f.root);
  const note = at(f, 'Note.txt');
  const first = f.library.updateBuffer(note.id, '# Slow Markdown', 1, note.revision);
  await began;
  const pending = f.library.get(note.id);
  assert.equal(pending.source, 'Plain'); assert.equal(pending.revision, note.revision); assert.equal(pending.format, 'plain');
  const second = f.library.updateBuffer(note.id, '#+TITLE: Newest Org', 2, note.revision);
  const writable = f.library.assertWritable(note.id);
  release();
  assert.equal((await first).format, 'markdown');
  const latest = await second;
  assert.equal(latest.format, 'org');
  const image = await insertImageBytes(f.root, await writable, png, 'Diagram.png');
  assert.match(image.text, /^\[\[file:/);
  assert.equal(f.library.get(note.id).source, '#+TITLE: Newest Org');
});

test('crash recovery retains txt overrides, creation hints, and divergent disk content', async (t) => {
  const f = await fixture(t);
  const script = `const { createLibrary } = require(process.argv[3]); (async () => {
    const library = createLibrary({ userData: process.argv[2] });
    await library.open(process.argv[1], { txtSyntax: 'org' });
    const note = await library.create('Crash', 'txt');
    await library.setSyntax(note.id, 'markdown');
    await library.updateBuffer(note.id, 'Draft prose', 1, note.revision);
    process.exit(0);
  })().catch(error => { console.error(error); process.exit(1); });`;
  await exec(process.execPath, ['-e', script, f.root, f.userData, path.resolve('electron/library.cjs')]);
  await fs.writeFile(path.join(f.root, 'Crash.txt'), 'Outside prose');
  await f.library.open(f.root, { txtSyntax: 'plain' });
  const recovered = f.library.active();
  assert.equal(recovered.source, 'Draft prose'); assert.equal(recovered.format, 'markdown');
  assert.equal(recovered.syntaxMode, 'markdown'); assert.equal(recovered.status, 'conflict');
  const copy = await f.library.resolveConflict(recovered.id, 'keep-both');
  assert.equal(copy.format, 'markdown'); assert.equal(copy.syntaxMode, 'markdown');
  const auto = await f.library.setSyntax(copy.id, 'auto');
  assert.equal(auto.format, 'org');
  assert.equal(await fs.readFile(path.join(f.root, 'Crash.txt'), 'utf8'), 'Outside prose');
});

test('legacy txt preferences migrate into creation defaults without reinterpreting existing files', async (t) => {
  const f = await fixture(t, { 'Existing.txt': 'Plain prose' });
  await fs.mkdir(f.userData);
  await fs.writeFile(path.join(f.userData, 'settings.json'), JSON.stringify({ version: 1, lastLibrary: f.root, globals: {}, libraries: { [f.root]: { defaultExtension: 'txt', txtSyntax: 'org' } } }));
  const settings = await createSettings(f.userData);
  await f.library.open(f.root, settings.snapshot(f.root));
  assert.equal(at(f, 'Existing.txt').format, 'plain');
  assert.equal((await f.library.create('New')).format, 'org');
});

test('detection failure keeps drafts journaled, visibly falls back, and still autosaves', async (t) => {
  const detector = createSyntaxDetector();
  const warnings = [];
  const f = await fixture(t, { 'Note.txt': 'Original' }, { onError: (message) => warnings.push(message), syntaxDetector: {
    detect: (source) => source.includes('Failure') ? Promise.reject(new Error('Injected worker failure')) : detector.detect(source),
    close: () => detector.close(),
  } });
  await f.library.open(f.root);
  let note = at(f, 'Note.txt');
  note = await f.library.updateBuffer(note.id, '# Failure draft', 1, note.revision);
  assert.equal(note.format, 'plain'); assert.equal(note.syntaxDetection, 'unavailable');
  assert.equal(note.status, 'dirty'); assert.match(note.syntaxWarning, /Injected worker failure/);
  const [recoveryDirectory] = await fs.readdir(path.join(f.userData, 'recovery'));
  const journal = JSON.parse(await fs.readFile(path.join(f.userData, 'recovery', recoveryDirectory, 'drafts', `${note.id}.json`), 'utf8'));
  assert.equal(journal.source, '# Failure draft');
  await waitFor(async () => (await fs.readFile(note.path, 'utf8')) === '# Failure draft');
  await waitFor(() => f.library.get(note.id).status === 'saved');
  assert.ok(warnings.some((message) => message.includes('Format detection failed')));
  note = await f.library.updateBuffer(note.id, '# Recovered detector', 2, note.revision);
  assert.equal(note.format, 'markdown'); assert.equal(note.syntaxWarning, '');
});

test('a crash during detection recovers the already-journaled source', async (t) => {
  const f = await fixture(t, { 'Note.txt': 'Original' });
  const script = `const { createLibrary } = require(process.argv[3]); const { createSyntaxDetector } = require(process.argv[4]); (async () => {
    const detector = createSyntaxDetector();
    const library = createLibrary({ userData: process.argv[2], syntaxDetector: {
      detect(source) { if (source === '# In-flight draft') process.exit(0); return detector.detect(source); }, close: () => detector.close(),
    } });
    await library.open(process.argv[1]); const note = library.active();
    await library.updateBuffer(note.id, '# In-flight draft', 1, note.revision);
    throw new Error('Expected process to stop during detection');
  })().catch(error => { console.error(error); process.exit(1); });`;
  await exec(process.execPath, ['-e', script, f.root, f.userData, path.resolve('electron/library.cjs'), path.resolve('electron/syntax-client.cjs')]);
  assert.equal(await fs.readFile(path.join(f.root, 'Note.txt'), 'utf8'), 'Original');
  await f.library.open(f.root);
  assert.equal(f.library.active().source, '# In-flight draft'); assert.equal(f.library.active().format, 'markdown');
});

test('reopening a library drains queued syntax writes before loading its state', async (t) => {
  let block = false, release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { 'Note.txt': '# Markdown' }, { writeSyntaxAtomic: async (...args) => {
    if (block) { started(); await gate; }
    return atomicReplace(...args);
  } });
  await f.library.open(f.root);
  const note = at(f, 'Note.txt');
  block = true;
  const change = f.library.setSyntax(note.id, 'org');
  await began;
  const reopen = f.library.open(f.root);
  await new Promise((resolve) => setTimeout(resolve, 50));
  block = false; release();
  await change; await reopen;
  assert.equal(at(f, 'Note.txt').syntaxMode, 'org'); assert.equal(at(f, 'Note.txt').format, 'org');
  await f.library.setSyntax(note.id, 'plain');
  await f.restart();
  assert.equal(at(f, 'Note.txt').syntaxMode, 'plain');
});

test('failed syntax preference writes roll back ordinary and case-only renames', async (t) => {
  let fail = false;
  const f = await fixture(t, { 'Note.txt': 'Important bytes' }, { writeSyntaxAtomic: async (...args) => {
    if (fail) throw new Error('Injected syntax-state write failure');
    return atomicReplace(...args);
  } });
  await f.library.open(f.root);
  let note = at(f, 'Note.txt');
  note = await f.library.setSyntax(note.id, 'org');
  fail = true;
  for (const title of ['Other', 'note']) {
    await assert.rejects(f.library.rename(note.id, title), /Injected syntax-state/);
    assert.deepEqual(await fs.readdir(f.root), ['Note.txt']);
    assert.equal(await fs.readFile(note.path, 'utf8'), 'Important bytes');
    assert.equal(f.library.get(note.id).name, 'Note.txt');
    await f.library.flush();
  }
  fail = false;
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(f.library.snapshot().count, 1, JSON.stringify((await f.library.search('')).results));
  note = await f.library.rename(note.id, 'Other');
  await f.restart();
  assert.equal(at(f, 'Other.txt').id, note.id); assert.equal(at(f, 'Other.txt').syntaxMode, 'org');
});
