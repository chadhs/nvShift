import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import libraryModule from '../electron/library.cjs';
const { createLibrary, atomicReplace, MAX_BYTES } = libraryModule;
const exec = promisify(execFile);

async function fixture(t, files = {}, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-library-'));
  const root = path.join(directory, 'notes');
  const userData = path.join(directory, 'profile');
  await fs.mkdir(root);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  const documents = [], libraries = [], errors = [];
  const library = createLibrary({ userData, onDocument: (document) => documents.push(document), onLibrary: (state) => libraries.push(state), onError: (message) => errors.push(message), ...options });
  t.after(async () => { await library.dispose().catch(() => {}); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, root, userData, library, documents, libraries, errors };
}
async function waitFor(check, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('Timed out waiting for a filesystem update');
}
const searchOne = async (library, query) => (await library.search(query)).results[0];

test('recursive discovery excludes ignored directories and symlinks, reports invalid/large files, and disambiguates paths', async (t) => {
  const f = await fixture(t, { 'one.md': 'alpha', 'nested/one.md': 'beta', 'plain.txt': 'words', 'deep/note.org': '* Org', '.hidden/no.md': 'hidden', 'assets/no.txt': 'asset', 'node_modules/no.md': 'dependency', 'binary.txt': Buffer.from([0xff, 0xfe]) });
  await fs.symlink(path.join(f.root, 'nested'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const huge = await fs.open(path.join(f.root, 'huge.md'), 'w'); await huge.truncate(MAX_BYTES + 1); await huge.close();
  await f.library.open(f.root);
  assert.equal(f.library.snapshot().count, 4);
  assert.equal((await f.library.search('')).total, 4);
  const duplicates = (await f.library.search('one')).results;
  assert.deepEqual(duplicates.map((entry) => entry.relativePath).sort(), ['nested/one.md', 'one.md']);
  assert.equal(f.library.snapshot().errors.length, 2);
  assert.equal(f.libraries.at(-1).indexing, false);
});

test('creation is exclusive, validates portable names, and keeps the note ID through renaming', async (t) => {
  const f = await fixture(t);
  await f.library.open(f.root);
  const note = await f.library.create('Café 世界', 'md');
  assert.equal(note.source, '');
  assert.equal(note.name, 'Café 世界.md');
  assert.equal(await fs.readFile(note.path, 'utf8'), '');
  await assert.rejects(f.library.create('café 世界', 'md'), /already exists/u);
  for (const title of ['../escape', 'CON', 'NUL.txt', 'bad:name', '.hidden', 'trailing.']) await assert.rejects(f.library.create(title, 'md'));
  await f.library.updateBuffer(note.id, 'unique source', 1, note.revision);
  const renamed = await f.library.rename(note.id, 'Renamed');
  assert.equal(renamed.id, note.id);
  assert.equal(renamed.name, 'Renamed.md');
  assert.equal(await fs.readFile(renamed.path, 'utf8'), 'unique source');
  await assert.rejects(fs.access(note.path));
  const other = await f.library.create('Existing', 'md');
  await assert.rejects(f.library.rename(renamed.id, 'Existing'), /already exists/u);
  assert.equal(await fs.readFile(other.path, 'utf8'), '');
});

test('.txt syntax is detected per note and folder preferences affect only creation', async (t) => {
  const f = await fixture(t, { 'a.txt': '# Heading\n', 'b.txt': '#+TITLE: Org\n* Heading\n', 'c.markdown': '# Markdown\n', 'd.org': '* Org\n', 'e.txt': '* Ambiguous\n' });
  await f.library.open(f.root, { defaultExtension: 'txt', txtSyntax: 'markdown' });
  const a = await f.library.activate((await searchOne(f.library, 'a')).id);
  assert.equal(a.format, 'markdown');
  await f.library.setPreferences({ txtSyntax: 'org' });
  assert.equal((await searchOne(f.library, 'a')).format, 'markdown');
  await f.library.activate((await searchOne(f.library, 'b')).id);
  assert.equal((await searchOne(f.library, 'b')).format, 'org');
  assert.equal((await searchOne(f.library, 'e')).format, 'plain');
  assert.equal((await searchOne(f.library, 'c')).format, 'markdown');
  const created = await f.library.create('New');
  assert.equal(created.extension, 'txt');
  assert.equal(created.format, 'org');
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), '# Heading\n');
  await f.library.setPreferences({ txtSyntax: 'plain' });
  assert.equal((await searchOne(f.library, 'a')).format, 'markdown');
  assert.equal(f.library.get(created.id).format, 'org');
});

test('serialized updates and autosave preserve BOM, CRLF, Unicode, and file permissions', async (t) => {
  const f = await fixture(t, { 'windows.txt': '\ufefffirst\r\nsecond\r\n' });
  await fs.chmod(path.join(f.root, 'windows.txt'), 0o640);
  await f.library.open(f.root);
  const initial = f.library.active();
  assert.equal(initial.source, 'first\nsecond\n');
  await Promise.all([
    f.library.updateBuffer(initial.id, 'first\nchanged\n', 1, initial.revision),
    f.library.updateBuffer(initial.id, 'first\nchanged 世界\n', 2, initial.revision),
  ]);
  assert.equal(f.library.get(initial.id).clientVersion, 2);
  await waitFor(async () => (await fs.readFile(initial.path, 'utf8')) === '\ufefffirst\r\nchanged 世界\r\n');
  await waitFor(() => f.library.get(initial.id).status === 'saved');
  if (process.platform !== 'win32') assert.equal((await fs.stat(initial.path)).mode & 0o777, 0o640);
  await f.library.updateBuffer(initial.id, 'stale', 1, initial.revision);
  assert.equal(f.library.get(initial.id).source, 'first\nchanged 世界\n');
  assert.ok(f.documents.some((document) => document?.status === 'saving'));
  assert.equal((await f.library.search('世界')).results[0].id, initial.id);
});

test('clean outside edits reload, incremental add/remove updates search, and activation flushes a draft', async (t) => {
  const f = await fixture(t, { 'a.md': 'original', 'b.md': 'other' });
  await f.library.open(f.root);
  const a = f.library.get((await searchOne(f.library, 'a')).id);
  await fs.writeFile(a.path, 'external change');
  await waitFor(() => f.library.get(a.id)?.source === 'external change');
  await fs.mkdir(path.join(f.root, 'later'));
  await fs.writeFile(path.join(f.root, 'later', 'new.org'), '* Fresh document');
  await waitFor(async () => (await f.library.search('fresh')).total === 1);
  await fs.unlink(path.join(f.root, 'later', 'new.org'));
  await waitFor(async () => (await f.library.search('fresh')).total === 0);
  await f.library.activate(a.id);
  await f.library.updateBuffer(a.id, 'pending text', 1, f.library.get(a.id).revision);
  const b = await searchOne(f.library, 'b');
  await f.library.activate(b.id);
  assert.equal(await fs.readFile(a.path, 'utf8'), 'pending text');
});

test('a disk change before saving pauses autosave and Keep both preserves both versions', async (t) => {
  const f = await fixture(t, { 'conflict.md': 'baseline' });
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, 'my draft', 1, initial.revision);
  await fs.writeFile(initial.path, 'their version');
  const conflict = await f.library.save(initial.id);
  assert.equal(conflict.status, 'conflict');
  assert.equal(conflict.source, 'my draft');
  assert.equal(await fs.readFile(initial.path, 'utf8'), 'their version');
  const copy = await f.library.resolveConflict(initial.id, 'keep-both');
  assert.notEqual(copy.id, initial.id);
  assert.match(copy.name, /conflict/u);
  assert.equal(await fs.readFile(copy.path, 'utf8'), 'my draft');
  assert.equal(await fs.readFile(initial.path, 'utf8'), 'their version');
  assert.equal(f.library.get(initial.id).source, 'their version');
});

test('a renderer edit based on a stale external revision becomes a conflict even after clean reload', async (t) => {
  const f = await fixture(t, { 'race.md': 'baseline' });
  await f.library.open(f.root);
  const initial = f.library.active();
  await fs.writeFile(initial.path, 'external');
  await waitFor(() => f.library.get(initial.id)?.source === 'external');
  const updated = await f.library.updateBuffer(initial.id, 'typed before the reload arrived', 1, initial.revision);
  assert.equal(updated.status, 'conflict');
  await f.library.flush();
  assert.equal(await fs.readFile(initial.path, 'utf8'), 'external');
  await f.library.resolveConflict(initial.id, 'use-disk');
  assert.equal(f.library.get(initial.id).source, 'external');
  const snapshots = await fs.readdir(path.join(f.userData, 'recovery', (await fs.readdir(path.join(f.userData, 'recovery')))[0], 'snapshots'));
  assert.ok(snapshots.length >= 2);
});

test('external deletion retains dirty text and Keep both recreates it as a separate file', async (t) => {
  const f = await fixture(t, { 'deleted.org': '* baseline' });
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, '* recovered', 1, initial.revision);
  await fs.unlink(initial.path);
  assert.equal((await f.library.save(initial.id)).status, 'conflict');
  const copy = await f.library.resolveConflict(initial.id, 'keep-both');
  assert.equal(await fs.readFile(copy.path, 'utf8'), '* recovered');
  await assert.rejects(fs.access(initial.path));
});

test('a write failure retains the draft and old bytes; disk revalidation catches a race during replacement', async (t) => {
  let fail = true, externalRace = false;
  const f = await fixture(t, { 'safe.md': 'original bytes' }, {
    writeAtomic: async (file, bytes, options) => {
      if (fail) throw new Error('Injected disk failure');
      if (externalRace) { externalRace = false; await fs.writeFile(file, 'outside race'); }
      return atomicReplace(file, bytes, options);
    },
  });
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, 'unsaved', 1, initial.revision);
  await assert.rejects(f.library.save(initial.id), /Injected disk failure/u);
  assert.equal(f.library.get(initial.id).status, 'error');
  assert.equal(await fs.readFile(initial.path, 'utf8'), 'original bytes');
  const recoveryLibraries = await fs.readdir(path.join(f.userData, 'recovery'));
  assert.ok((await fs.readdir(path.join(f.userData, 'recovery', recoveryLibraries[0], 'drafts'))).length > 0);
  fail = false; externalRace = true;
  assert.equal((await f.library.save(initial.id)).status, 'conflict');
  assert.equal(await fs.readFile(initial.path, 'utf8'), 'outside race');
});

test('recovery restores a crash-journaled draft and preserves a divergent disk version', async (t) => {
  const f = await fixture(t, { 'crash.md': 'baseline' });
  const script = `const {createLibrary}=require(process.argv[3]); (async()=>{ const l=createLibrary({userData:process.argv[2]}); await l.open(process.argv[1]); const d=l.active(); await l.updateBuffer(d.id,'crash draft',1,d.revision); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});`;
  await exec(process.execPath, ['-e', script, f.root, f.userData, path.resolve('electron/library.cjs')], { cwd: process.cwd() });
  assert.equal(await fs.readFile(path.join(f.root, 'crash.md'), 'utf8'), 'baseline');
  await fs.writeFile(path.join(f.root, 'crash.md'), 'changed while stopped');
  await f.library.open(f.root);
  assert.equal(f.library.active().source, 'crash draft');
  assert.equal(f.library.active().status, 'conflict');
  assert.equal(await fs.readFile(path.join(f.root, 'crash.md'), 'utf8'), 'changed while stopped');
  const copy = await f.library.resolveConflict(f.library.active().id, 'keep-both');
  assert.equal(await fs.readFile(copy.path, 'utf8'), 'crash draft');
});

test('trash uses the supplied system operation and never removes a file when trash fails', async (t) => {
  let shouldFail = true;
  const f = await fixture(t, { 'trash.md': 'important' }, { trashItem: async (file) => { if (shouldFail) throw new Error('Trash failed'); await fs.rename(file, `${file}.trashed`); } });
  await f.library.open(f.root);
  const initial = f.library.active();
  await assert.rejects(f.library.trash(initial.id), /Trash failed/u);
  assert.equal(await fs.readFile(initial.path, 'utf8'), 'important');
  assert.equal(f.library.snapshot().count, 1);
  shouldFail = false;
  await f.library.trash(initial.id);
  assert.equal(f.library.snapshot().count, 0);
  assert.equal(await fs.readFile(`${initial.path}.trashed`, 'utf8'), 'important');
});

test('concurrent portable-name collisions create one file and delayed rename events keep the note', async (t) => {
  const f = await fixture(t);
  await f.library.open(f.root);
  const results = await Promise.allSettled([f.library.create('Same', 'md'), f.library.create('SAME', 'md')]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const created = results.find((result) => result.status === 'fulfilled').value;
  const renamed = await f.library.rename(created.id, 'Case Changed');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(f.library.get(renamed.id)?.name, 'Case Changed.md');
  assert.equal((await f.library.search('case')).results[0].id, renamed.id);
  assert.equal(f.library.snapshot().count, 1);
});

test('encoded-size checks and invalid editor text reject edits without changing existing bytes', async (t) => {
  const f = await fixture(t, { 'limit.txt': '\ufeffx\r\n' });
  await f.library.open(f.root);
  const initial = f.library.active();
  await assert.rejects(f.library.updateBuffer(initial.id, '\n'.repeat(MAX_BYTES / 2 + 1), 1, initial.revision), /16 MiB/u);
  await assert.rejects(f.library.updateBuffer(initial.id, 'binary\u0000', 2, initial.revision));
  await assert.rejects(f.library.updateBuffer(initial.id, '\ud800', 3, initial.revision));
  assert.equal(f.library.get(initial.id).source, 'x\n');
  assert.equal(await fs.readFile(initial.path, 'utf8'), '\ufeffx\r\n');
});

test('replacing a note parent with a symlink cannot redirect an autosave outside the library', async (t) => {
  const f = await fixture(t, { 'nested/note.md': 'original' });
  const outside = path.join(f.directory, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'note.md'), 'outside protected');
  await f.library.open(f.root);
  const initial = f.library.active();
  await f.library.updateBuffer(initial.id, 'my preserved draft', 1, initial.revision);
  await fs.rename(path.join(f.root, 'nested'), path.join(f.root, 'backup'));
  await fs.symlink(outside, path.join(f.root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await f.library.save(initial.id).catch(() => {});
  assert.equal(await fs.readFile(path.join(outside, 'note.md'), 'utf8'), 'outside protected');
  assert.equal(f.library.get(initial.id).source, 'my preserved draft');
  assert.ok(['error', 'conflict'].includes(f.library.get(initial.id).status));
});

test('a crash draft based on the unchanged disk is restored and can be flushed normally', async (t) => {
  const f = await fixture(t, { 'crash.txt': 'baseline' });
  const script = `const {createLibrary}=require(process.argv[3]); (async()=>{ const l=createLibrary({userData:process.argv[2]}); await l.open(process.argv[1]); const d=l.active(); await l.updateBuffer(d.id,'recover me',1,d.revision); process.exit(0); })().catch(e=>{console.error(e);process.exit(1)});`;
  await exec(process.execPath, ['-e', script, f.root, f.userData, path.resolve('electron/library.cjs')], { cwd: process.cwd() });
  await f.library.open(f.root);
  assert.equal(f.library.active().source, 'recover me');
  assert.equal(f.library.active().status, 'dirty');
  await f.library.flush();
  assert.equal(await fs.readFile(path.join(f.root, 'crash.txt'), 'utf8'), 'recover me');
  assert.equal(f.library.active().status, 'saved');
});
