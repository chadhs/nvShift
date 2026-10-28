// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createLibrary, atomicReplace } from '../electron/library.cjs';
import { resolveDocumentLink } from '../electron/links.cjs';
import { renderDocument } from '../src/documents.js';
import { createImageReader } from '../electron/images.cjs';
import { insertImageBytes } from '../electron/assets.cjs';

const exec = promisify(execFile);
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64');

async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-linked-library-')));
  const root = path.join(directory, 'notes');
  const external = path.join(directory, 'external');
  const alternate = path.join(directory, 'alternate');
  const userData = path.join(directory, 'profile');
  const trash = path.join(directory, 'trash');
  await Promise.all([root, external, alternate, trash].map((folder) => fs.mkdir(folder)));
  const errors = [], documents = [];
  const library = createLibrary({ userData, onError: (error) => errors.push(String(error)), onDocument: (doc) => documents.push(doc), trashItem: (file) => fs.rename(file, path.join(trash, path.basename(file))), ...options });
  t.after(async () => { await library.dispose().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, root, external, alternate, userData, trash, library, errors, documents };
}
async function put(folder, relative, contents) {
  const file = path.join(folder, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
  return file;
}
async function link(target, location) { await fs.symlink(target, location, linkType); }
async function retarget(location, target) { await fs.unlink(location); await link(target, location); }
async function waitFor(check, label = 'filesystem change', timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${label}`);
}
async function result(library, query) { return (await library.search(query)).results[0]; }
async function crashDraft(f, file, source = 'A crash-journaled linked draft') {
  const script = `const fs=require('node:fs'); const {createLibrary}=require(process.argv[3]);
    (async()=>{const library=createLibrary({userData:process.argv[2]});await library.open(process.argv[1]);
      const note=library.getByPath(fs.realpathSync(process.argv[4]));
      if(!note)throw Error('Fixture note missing');
      await library.updateBuffer(note.id,process.argv[5],1,note.revision);process.exit(0);
    })().catch(error=>{console.error(error);process.exit(1)});`;
  await exec(process.execPath, ['-e', script, f.root, f.userData, path.resolve('electron/library.cjs'), file, source], { cwd: process.cwd(), timeout: 15000 });
}
async function journalFile(f) {
  const vaults = await fs.readdir(path.join(f.userData, 'recovery'));
  const directory = path.join(f.userData, 'recovery', vaults[0], 'drafts');
  return path.join(directory, (await fs.readdir(directory)).find((name) => name.endsWith('.json')));
}

test('external directory notes retain logical routes and support .txt syntax, saves, rename, and trash', async (t) => {
  const f = await fixture(t);
  const original = await put(f.external, 'outside.txt', '\ufeff* TODO Outside\r\nLinked text.\r\n');
  const alias = path.join(f.root, 'Work'); await link(f.external, alias);
  await f.library.open(f.root, { txtSyntax: 'org', defaultExtension: 'md' });
  const opened = f.library.active();
  assert.equal(opened.format, 'plain');
  const note = await f.library.setSyntax(opened.id, 'org');
  assert.equal(note.path, original);
  assert.equal(note.relativePath, 'Work/outside.txt');
  assert.equal(note.format, 'org');
  assert.equal((await f.library.resolveIndexedPath(path.join(alias, 'outside.txt'))).id, note.id);
  assert.equal((await f.library.assertWritable(note.id)).id, note.id);
  await f.library.updateBuffer(note.id, '* TODO Edited 世界\n', 1, note.revision);
  await f.library.save(note.id);
  assert.equal(await fs.readFile(original, 'utf8'), '\ufeff* TODO Edited 世界\r\n');
  const renamed = await f.library.rename(note.id, 'Renamed outside');
  assert.equal(renamed.id, note.id);
  assert.equal(renamed.relativePath, 'Work/Renamed outside.txt');
  assert.equal(renamed.path, path.join(f.external, 'Renamed outside.txt'));
  await assert.rejects(fs.access(original));
  const rootNote = await f.library.create('Root capture');
  assert.equal(path.dirname(rootNote.path), f.root);
  await f.library.trash(renamed.id);
  assert.equal(await fs.readFile(path.join(f.trash, 'Renamed outside.txt'), 'utf8'), '\ufeff* TODO Edited 世界\r\n');
  await assert.rejects(fs.access(renamed.path));
  assert.ok((await fs.lstat(alias)).isSymbolicLink());
});

test('duplicate aliases index each file once and keep IDs stable when the preferred alias changes', async (t) => {
  const f = await fixture(t);
  await put(f.root, 'direct/note.md', 'A directidentity note');
  await put(f.external, 'outside.md', 'An externalidentity note');
  await link(path.join(f.root, 'direct'), path.join(f.root, 'AliasDirect'));
  await link(f.external, path.join(f.root, 'WorkZ'));
  await link(f.external, path.join(f.root, 'WorkA'));
  await f.library.open(f.root);
  assert.equal(f.library.snapshot().count, 2);
  assert.equal((await result(f.library, 'directidentity')).relativePath, 'direct/note.md');
  const initial = await result(f.library, 'externalidentity');
  assert.equal(initial.relativePath, 'WorkA/outside.md');
  await fs.unlink(path.join(f.root, 'WorkA'));
  await waitFor(async () => (await result(f.library, 'externalidentity'))?.relativePath === 'WorkZ/outside.md', 'alias removal');
  assert.equal((await result(f.library, 'externalidentity')).id, initial.id);
  await link(f.external, path.join(f.root, 'Work0'));
  await waitFor(async () => (await result(f.library, 'externalidentity'))?.relativePath === 'Work0/outside.md', 'earlier alias addition');
  assert.equal((await result(f.library, 'externalidentity')).id, initial.id);
  assert.equal(f.library.snapshot().count, 2);
  assert.equal(await f.library.resolveIndexedPath(path.join(f.root, 'WorkA', 'outside.md')), null);
});

test('nested links and cycles stay finite, exclusions apply inside targets, and broken links are reported', async (t) => {
  const f = await fixture(t);
  await put(f.root, 'home.md', 'home needle');
  await put(f.external, 'top.md', 'outside needle');
  await put(f.external, '.hidden/no.md', 'hidden needle');
  await put(f.external, 'assets/no.txt', 'asset needle');
  await put(f.alternate, 'node_modules/no.md', 'dependency needle');
  const nested = await put(f.alternate, 'nested.org', '* Deep link needle');
  await fs.mkdir(path.join(f.external, 'sub'));
  await link(f.external, path.join(f.root, 'Projects'));
  await link(f.alternate, path.join(f.external, 'sub', 'Extra'));
  await link(f.root, path.join(f.alternate, 'Back'));
  await link(path.join(f.directory, 'missing'), path.join(f.root, 'Broken'));
  await f.library.open(f.root);
  assert.equal(f.library.snapshot().count, 3);
  const doc = await result(f.library, 'deep');
  assert.equal(doc.relativePath, 'Projects/sub/Extra/nested.org');
  assert.equal(f.library.get(doc.id).path, nested);
  assert.ok(f.library.snapshot().errors.some((error) => error.includes('Broken')));
  assert.equal((await f.library.search('hidden')).total, 0);
  assert.equal((await f.library.search('dependency')).total, 0);
});

test('external changes and newly created nested files stay live, including immediate deletion after discovery', async (t) => {
  const f = await fixture(t);
  const file = await put(f.external, 'live.md', 'old content');
  await link(f.external, path.join(f.root, 'Work'));
  await f.library.open(f.root);
  const initial = f.library.active();
  await fs.writeFile(file, 'new externalvalue');
  await waitFor(() => f.library.get(initial.id)?.source === 'new externalvalue', 'outside edit');
  const added = await put(f.external, 'later/deep/new.md', 'transientnestedneedle');
  await waitFor(async () => (await f.library.search('transientnestedneedle')).total === 1, 'nested directory creation');
  await fs.unlink(added);
  await waitFor(async () => (await f.library.search('transientnestedneedle')).total === 0, 'immediate nested file deletion');
  await fs.unlink(file);
  await waitFor(() => f.library.get(initial.id) === null, 'outside deletion');
});

test('removing and readding a linked folder removes clean notes and restores the same real-file identity', async (t) => {
  const f = await fixture(t);
  const file = await put(f.external, 'clean.md', 'cleanlinkneedle');
  const alias = path.join(f.root, 'Work'); await link(f.external, alias);
  await f.library.open(f.root);
  const initial = f.library.active();
  await fs.unlink(alias);
  await waitFor(() => f.library.get(initial.id) === null, 'linked folder removal');
  assert.equal(await fs.readFile(file, 'utf8'), 'cleanlinkneedle');
  await link(f.external, alias);
  await waitFor(async () => (await f.library.search('cleanlinkneedle')).total === 1, 'linked folder readdition');
  assert.equal((await result(f.library, 'cleanlinkneedle')).id, initial.id);
  await fs.writeFile(file, 'readdedwatchneedle');
  await waitFor(() => f.library.get(initial.id)?.source === 'readdedwatchneedle', 'watching readded target');
});

test('a late renderer edit revives a removed active linked note as a journaled conflict', async (t) => {
  const f = await fixture(t);
  const file = await put(f.external, 'late.md', 'originaltargetbaseline');
  const alias = path.join(f.root, 'Work'); await link(f.external, alias);
  await f.library.open(f.root);
  const initial = f.library.active();
  await fs.unlink(alias);
  await waitFor(async () => f.library.get(initial.id) === null && (await f.library.search('originaltargetbaseline')).total === 0, 'active linked note retirement');
  // An old acknowledgement must not resurrect a clean, no-longer-reachable note.
  await f.library.updateBuffer(initial.id, initial.source, initial.clientVersion, initial.revision).catch(() => {});
  assert.equal(f.library.get(initial.id), null);
  assert.equal(f.library.snapshot().count, 0);
  const source = 'A late renderer draft that must survive';
  const restored = await f.library.updateBuffer(initial.id, source, initial.clientVersion + 1, initial.revision);
  assert.equal(restored.id, initial.id);
  assert.equal(restored.path, file);
  assert.equal(restored.source, source);
  assert.equal(restored.status, 'conflict');
  assert.ok(restored.revision > initial.revision);
  assert.equal(f.library.active()?.id, initial.id);
  await f.library.flush();
  assert.equal(await fs.readFile(file, 'utf8'), 'originaltargetbaseline');
  const journal = JSON.parse(await fs.readFile(await journalFile(f), 'utf8'));
  assert.equal(journal.id, initial.id);
  assert.equal(journal.path, file);
  assert.equal(journal.source, source);
  assert.equal(journal.conflict, true);
  const copy = await f.library.resolveConflict(initial.id, 'keep-both');
  assert.equal(path.dirname(copy.path), f.root);
  assert.equal(await fs.readFile(copy.path, 'utf8'), source);
  assert.equal(await fs.readFile(file, 'utf8'), 'originaltargetbaseline');
});

test('recreating a retired canonical filename advances its revision and rejects a late edit based on the deleted file', async (t) => {
  const f = await fixture(t);
  const file = await put(f.root, 'reused.md', 'deletedfilebaseline');
  await f.library.open(f.root);
  const initial = f.library.active();
  await fs.unlink(file);
  await waitFor(async () => f.library.get(initial.id) === null && (await f.library.search('deletedfilebaseline')).total === 0, 'canonical note retirement');
  await fs.writeFile(file, 'recreatedfilebaseline');
  const replacement = await waitFor(() => {
    const doc = f.library.get(initial.id);
    return doc?.status === 'saved' && doc.source === 'recreatedfilebaseline' ? doc : null;
  }, 'same-ID canonical note recreation');
  assert.equal(replacement.id, initial.id);
  assert.ok(replacement.revision > initial.revision);
  await f.library.updateBuffer(initial.id, initial.source, initial.clientVersion, initial.revision);
  assert.equal(f.library.get(initial.id).source, 'recreatedfilebaseline');
  const source = 'A renderer draft based on the deleted file';
  const conflict = await f.library.updateBuffer(initial.id, source, initial.clientVersion + 1, initial.revision);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.source, source);
  assert.equal(conflict.path, file);
  await f.library.flush();
  assert.equal(await fs.readFile(file, 'utf8'), 'recreatedfilebaseline');
  const journal = JSON.parse(await fs.readFile(await journalFile(f), 'utf8'));
  assert.equal(journal.source, source);
  assert.equal(journal.conflict, true);
});

test('retargeting before saving preserves both disk files and saves Keep both at the library root', async (t) => {
  const f = await fixture(t);
  const oldFile = await put(f.external, 'same.md', 'oldtargetbaseline');
  const newFile = await put(f.alternate, 'same.md', 'newtargetbaseline');
  const alias = path.join(f.root, 'Work'); await link(f.external, alias);
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, 'A preserved local draft', 1, initial.revision);
  await retarget(alias, f.alternate);
  assert.equal((await f.library.save(initial.id)).status, 'conflict');
  assert.equal(await fs.readFile(oldFile, 'utf8'), 'oldtargetbaseline');
  assert.equal(await fs.readFile(newFile, 'utf8'), 'newtargetbaseline');
  assert.equal(f.library.get(initial.id).source, 'A preserved local draft');
  await assert.rejects(f.library.assertWritable(initial.id), /linked|folder|reachable/i);
  await waitFor(async () => (await f.library.search('newtargetbaseline')).total === 1, 'retargeted folder discovery');
  await put(f.alternate, 'newly-watched.md', 'newtargetwatchneedle');
  await waitFor(async () => (await f.library.search('newtargetwatchneedle')).total === 1, 'watching retargeted folder');
  const copy = await f.library.resolveConflict(initial.id, 'keep-both');
  assert.equal(path.dirname(copy.path), f.root);
  assert.equal(await fs.readFile(copy.path, 'utf8'), 'A preserved local draft');
  assert.equal(await fs.readFile(oldFile, 'utf8'), 'oldtargetbaseline');
  assert.equal(await fs.readFile(newFile, 'utf8'), 'newtargetbaseline');
});

test('a link changed during atomic replacement cannot redirect the pending edit', async (t) => {
  let changeDuringWrite = false, alias, replacement;
  const f = await fixture(t, { writeAtomic: async (file, bytes, options) => {
    if (changeDuringWrite) { changeDuringWrite = false; await retarget(alias, replacement); }
    return atomicReplace(file, bytes, options);
  } });
  const oldFile = await put(f.external, 'race.md', 'old disk');
  const newFile = await put(f.alternate, 'race.md', 'new disk');
  alias = path.join(f.root, 'Work'); replacement = f.alternate;
  await link(f.external, alias);
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, 'queued draft', 1, initial.revision);
  changeDuringWrite = true;
  assert.equal((await f.library.save(initial.id)).status, 'conflict');
  assert.equal(f.library.get(initial.id).source, 'queued draft');
  assert.equal(await fs.readFile(oldFile, 'utf8'), 'old disk');
  assert.equal(await fs.readFile(newFile, 'utf8'), 'new disk');
});

test('retargeting a clean note prevents rename and trash from mutating either target', async (t) => {
  let trashes = 0;
  const f = await fixture(t, { trashItem: async () => { trashes++; } });
  const oldFile = await put(f.external, 'safe.md', 'old disk');
  const newFile = await put(f.alternate, 'safe.md', 'new disk');
  const alias = path.join(f.root, 'Work'); await link(f.external, alias);
  await f.library.open(f.root);
  const initial = f.library.active();
  await retarget(alias, f.alternate);
  await assert.rejects(f.library.rename(initial.id, 'Changed name'));
  await assert.rejects(f.library.trash(initial.id));
  assert.equal(trashes, 0);
  assert.equal(await fs.readFile(oldFile, 'utf8'), 'old disk');
  assert.equal(await fs.readFile(newFile, 'utf8'), 'new disk');
  await assert.rejects(fs.access(path.join(f.external, 'Changed name.md')));
  await assert.rejects(fs.access(path.join(f.alternate, 'Changed name.md')));
});

test('a clean directory replacement reloads its new bytes and accepts edits based on the refreshed revision', async (t) => {
  const f = await fixture(t);
  const originalDirectory = path.join(f.external, 'sub');
  const movedDirectory = path.join(f.external, 'moved');
  const file = await put(originalDirectory, 'note.md', 'oldfolderbaseline');
  await link(f.external, path.join(f.root, 'Work'));
  await f.library.open(f.root);
  const initial = f.library.active();
  await fs.rename(originalDirectory, movedDirectory);
  await put(originalDirectory, 'note.md', 'replacementfolderbaseline');
  const refreshed = await waitFor(() => {
    const doc = f.library.get(initial.id);
    return doc?.status === 'saved' && doc.source === 'replacementfolderbaseline' ? doc : null;
  }, 'clean directory replacement reload');
  assert.equal(refreshed.path, file);
  assert.equal(refreshed.relativePath, 'Work/sub/note.md');
  assert.ok(refreshed.revision > initial.revision);
  await f.library.updateBuffer(refreshed.id, 'An edit to the replacement folder', refreshed.clientVersion + 1, refreshed.revision);
  const saved = await f.library.save(refreshed.id);
  assert.equal(saved.status, 'saved');
  assert.equal(await fs.readFile(file, 'utf8'), 'An edit to the replacement folder');
  assert.equal(await fs.readFile(path.join(movedDirectory, 'note.md'), 'utf8'), 'oldfolderbaseline');
  const stale = await f.library.updateBuffer(saved.id, 'Typed against the old folder', saved.clientVersion + 1, initial.revision);
  assert.equal(stale.status, 'conflict');
  await f.library.flush();
  assert.equal(await fs.readFile(file, 'utf8'), 'An edit to the replacement folder');
});

test('a dirty directory replacement preserves both physical files and saves Keep both at the library root', async (t) => {
  const f = await fixture(t);
  const originalDirectory = path.join(f.external, 'sub');
  const movedDirectory = path.join(f.external, 'moved');
  const file = await put(originalDirectory, 'note.md', 'oldfolderbaseline');
  await link(f.external, path.join(f.root, 'Work'));
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, 'My unsaved old-folder draft', 1, initial.revision);
  await fs.rename(originalDirectory, movedDirectory);
  await put(originalDirectory, 'note.md', 'replacementfolderbaseline');
  const conflict = await f.library.save(initial.id);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.source, 'My unsaved old-folder draft');
  assert.equal(await fs.readFile(file, 'utf8'), 'replacementfolderbaseline');
  assert.equal(await fs.readFile(path.join(movedDirectory, 'note.md'), 'utf8'), 'oldfolderbaseline');
  await waitFor(async () => (await f.library.search('oldfolderbaseline')).results.some((entry) => entry.relativePath === 'Work/moved/note.md'), 'replacement topology discovery');
  const copy = await f.library.resolveConflict(initial.id, 'keep-both');
  assert.equal(path.dirname(copy.path), f.root);
  assert.equal(await fs.readFile(copy.path, 'utf8'), 'My unsaved old-folder draft');
  assert.equal(await fs.readFile(file, 'utf8'), 'replacementfolderbaseline');
  assert.equal(await fs.readFile(path.join(movedDirectory, 'note.md'), 'utf8'), 'oldfolderbaseline');
});

test('linked Markdown, Org, and configured .txt resources resolve from the real note location', async (t) => {
  const f = await fixture(t);
  const content = path.join(f.external, 'content');
  await put(f.external, 'media/chart.png', png);
  await put(f.external, 'content/other.md', '# Destination');
  for (const [name, source] of [['read.md', '![Chart](../media/chart.png)\n[Other](other.md#destination)'], ['read.org', '[[file:../media/chart.png]]\n[[file:other.md][Other]]'], ['read.txt', '[[file:../media/chart.png]]']]) await put(content, name, source);
  const alias = path.join(f.root, 'Linked'); await link(content, alias);
  await f.library.open(f.root, { txtSyntax: 'org' });
  for (const name of ['read.md', 'read.org', 'read.txt']) {
    let doc = await f.library.resolveIndexedPath(path.join(alias, name));
    assert.equal(doc.path, path.join(content, name));
    const preview = renderDocument(doc);
    assert.equal(preview.images.length, 1);
    const read = createImageReader(doc);
    try { assert.equal((await read(preview.images[0])).dataUrl, `data:image/png;base64,${png.toString('base64')}`); }
    finally { read.cancel(); }
    if (preview.links.length) {
      const destination = resolveDocumentLink(doc.path, preview.links[0].target);
      assert.equal((await f.library.resolveIndexedPath(destination.file)).id, (await f.library.resolveIndexedPath(path.join(alias, 'other.md'))).id);
    }
    const imported = await insertImageBytes(f.root, doc, png, 'Readable chart.png');
    await f.library.updateBuffer(doc.id, doc.source + '\n' + imported.text, doc.clientVersion + 1, doc.revision);
    doc = await f.library.save(doc.id);
    const inserted = renderDocument(doc).images.at(-1);
    const insertedReader = createImageReader(doc);
    try { assert.ok((await insertedReader(inserted)).dataUrl); }
    finally { insertedReader.cancel(); }
  }
  await f.library.setPreferences({ txtSyntax: 'markdown' });
  assert.equal((await f.library.resolveIndexedPath(path.join(alias, 'read.txt'))).format, 'org');
});

test('a linked target in a hidden physical ancestor remains live through its visible alias', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.directory, '.storage', 'notes');
  const file = await put(target, 'hidden-parent.md', 'before');
  await link(target, path.join(f.root, 'Visible'));
  await f.library.open(f.root);
  const initial = f.library.active();
  assert.equal(initial.relativePath, 'Visible/hidden-parent.md');
  await fs.writeFile(file, 'after hiddenparentneedle');
  await waitFor(() => f.library.get(initial.id)?.source === 'after hiddenparentneedle', 'hidden physical target update');
});

test('watching a linked ancestor still observes a selected library below a hidden directory', async (t) => {
  const f = await fixture(t);
  const selected = path.join(f.directory, '.collection', 'notes');
  const file = await put(selected, 'selected.md', 'selected baseline');
  await put(f.directory, '.collection/private.md', 'muststayhiddenneedle');
  await put(f.external, 'ordinary.md', 'visibleancestorcontent');
  await link(f.directory, path.join(selected, 'Parent'));
  await f.library.open(selected);
  const initial = await result(f.library, 'selected baseline');
  assert.equal(initial.relativePath, 'selected.md');
  assert.equal((await f.library.search('muststayhiddenneedle')).total, 0);
  await fs.writeFile(file, 'selectedafterancestorwatch');
  await waitFor(() => f.library.get(initial.id)?.source === 'selectedafterancestorwatch', 'hidden selected library under ancestor watch');
  const created = await put(selected, 'later/new.md', 'nestedhiddenwatchneedle');
  await waitFor(async () => (await f.library.search('nestedhiddenwatchneedle')).total === 1, 'new selected-library descendant');
  await fs.unlink(created);
  await waitFor(async () => (await f.library.search('nestedhiddenwatchneedle')).total === 0, 'selected-library descendant removal');
});

test('linked crash recovery flushes a draft only when the original target and disk baseline still match', async (t) => {
  const f = await fixture(t);
  const file = await put(f.external, 'crash.md', 'baseline');
  await link(f.external, path.join(f.root, 'Work'));
  await crashDraft(f, file);
  assert.equal(await fs.readFile(file, 'utf8'), 'baseline');
  const journal = JSON.parse(await fs.readFile(await journalFile(f), 'utf8'));
  assert.equal(journal.version, 2);
  assert.equal(journal.path, file);
  assert.equal(journal.logicalPath, path.join(f.root, 'Work', 'crash.md'));
  assert.equal(typeof journal.directoryIdentity, 'string');
  await f.library.open(f.root);
  assert.equal(f.library.active().source, 'A crash-journaled linked draft');
  assert.equal(f.library.active().status, 'dirty');
  await f.library.flush();
  assert.equal(await fs.readFile(file, 'utf8'), 'A crash-journaled linked draft');
});

for (const change of ['outside-edit', 'retarget']) test(`linked crash recovery preserves the original target after ${change}`, async (t) => {
  const f = await fixture(t);
  const oldFile = await put(f.external, 'crash.md', 'old baseline');
  const newFile = await put(f.alternate, 'crash.md', 'new baseline');
  const alias = path.join(f.root, 'Work'); await link(f.external, alias);
  await crashDraft(f, oldFile);
  if (change === 'retarget') await retarget(alias, f.alternate);
  else await fs.writeFile(oldFile, 'outside while stopped');
  await f.library.open(f.root);
  const draft = f.library.active();
  assert.equal(draft.source, 'A crash-journaled linked draft');
  assert.equal(draft.status, 'conflict');
  assert.equal(draft.path, oldFile);
  await f.library.flush();
  assert.equal(await fs.readFile(oldFile, 'utf8'), change === 'retarget' ? 'old baseline' : 'outside while stopped');
  assert.equal(await fs.readFile(newFile, 'utf8'), 'new baseline');
  const copy = await f.library.resolveConflict(draft.id, 'keep-both');
  assert.equal(await fs.readFile(copy.path, 'utf8'), 'A crash-journaled linked draft');
  if (change === 'retarget') assert.equal(path.dirname(copy.path), f.root);
});

test('version-one ordinary-note journals remain recoverable after adding target pins', async (t) => {
  const f = await fixture(t);
  const file = await put(f.root, 'legacy.md', 'baseline');
  await crashDraft(f, file, 'A legacy draft');
  const journal = await journalFile(f);
  const saved = JSON.parse(await fs.readFile(journal, 'utf8'));
  saved.version = 1; delete saved.directoryIdentity; delete saved.logicalPath;
  await fs.writeFile(journal, JSON.stringify(saved));
  await f.library.open(f.root);
  assert.equal(f.library.active().source, 'A legacy draft');
  assert.equal(f.library.active().status, 'dirty');
  await f.library.flush();
  assert.equal(await fs.readFile(file, 'utf8'), 'A legacy draft');
});
