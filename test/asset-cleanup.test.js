import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createLibrary } from '../electron/library.cjs';
import { createAssetCleanup } from '../electron/asset-cleanup.cjs';
import { collectAssetReferences } from '../src/asset-references.js';
import { insertImageBytes } from '../electron/assets.cjs';

const pixel = await fs.readFile(new URL('../build/icons/16x16.png', import.meta.url));
async function fixture({ notes = { 'Note.md': '# Notes\nNo images.' }, assets = ['unused.png'], trash, beforeOpen } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-cleanup-')));
  const root = path.join(base, 'notes'), userData = path.join(base, 'profile'), trashed = [];
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.mkdir(path.join(base, 'trash'));
  for (const [name, source] of Object.entries(notes)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), source);
  }
  for (const name of assets) await fs.writeFile(path.join(root, 'assets', name), pixel);
  await beforeOpen?.({ base, root, userData });
  const library = createLibrary({ userData });
  await library.open(root);
  const events = [], waiters = new Map();
  const makeCleanup = () => createAssetCleanup({ library, userData,
    trashItem: async (file) => {
      if (trash) await trash(file);
      await fs.rename(file, path.join(base, 'trash', path.basename(file))); trashed.push(path.basename(file));
    },
    onProgress(value) {
      events.push(value);
      if (['complete', 'error', 'cancelled'].includes(value.status)) { waiters.get(value.scanId)?.(value); waiters.delete(value.scanId); }
    },
  });
  let cleanup = makeCleanup();
  const scan = () => {
    const { scanId } = cleanup.start();
    return new Promise((resolve) => {
      const previous = events.findLast((event) => event.scanId === scanId && ['complete', 'error', 'cancelled'].includes(event.status));
      if (previous) resolve(previous); else waiters.set(scanId, resolve);
    });
  };
  return { base, root, userData, library, events, trashed,
    get cleanup() { return cleanup; }, scan,
    async restartCleanup() { await cleanup.dispose(); cleanup = makeCleanup(); },
    async recovery(category, value, name = 'record.json') {
      const snapshot = await library.cleanupSnapshot();
      const directory = path.join(snapshot.recoveryRoot, category);
      await fs.mkdir(directory, { recursive: true });
      const file = path.join(directory, name);
      await fs.writeFile(file, JSON.stringify(value)); return file;
    },
    async close() { await cleanup.dispose(); await library.dispose(); await fs.rm(base, { recursive: true, force: true }); },
  };
}
const candidateNames = (scan) => scan.candidates.map((asset) => asset.name).sort();
async function complete(f) { const result = await f.scan(); assert.equal(result.status, 'complete', result.errors.join('; ')); return result; }

test('cleanup protects every reference beyond the preview cap and supports Markdown, Org and plain paths', async () => {
  const assets = Array.from({ length: 130 }, (_, index) => `picture-${index}.png`);
  const source = assets.map((name) => `![Image](assets/${name})`).join('\n\n');
  const f = await fixture({ notes: { 'Note.md': source, 'Text.txt': 'assets/plain%20image.png', 'Org.org': '[[file:assets/org.png][Download]]' }, assets: [...assets, 'plain image.png', 'org.png', 'unused.png'] });
  try {
    const result = await complete(f);
    assert.deepEqual(candidateNames(result), ['unused.png']);
    assert.equal(result.protectedCount, 0);
    const thumbnail = await f.cleanup.thumbnail(result.scanId, result.candidates[0].id);
    assert.match(thumbnail.dataUrl, /^data:image\/png;base64,/);
    await assert.rejects(f.cleanup.thumbnail(result.scanId, '../unused.png'), /Choose an image/);
  } finally { await f.close(); }
});

test('cleanup collector retains shared links, definitions, Unicode, ordinary image file links and ambiguous mentions', async () => {
  const f = await fixture({ assets: ['Café 日本語(1).png', 'shared.png', 'mention.png', 'unused.png'], notes: {
    'nested/First.md': '[Download](../assets/shared.png)\n\n![Picture][image]\n\n[image]: ../assets/Caf%C3%A9%20%E6%97%A5%E6%9C%AC%E8%AA%9E%281%29.png',
    'Second.org': '[[file:assets/shared.png]]\nExample source mentions mention.png.',
  } });
  try { assert.deepEqual(candidateNames(await complete(f)), ['unused.png']); }
  finally { await f.close(); }
});

test('linked notes resolve relative resources from their real folder and share library assets', async () => {
  const f = await fixture({ assets: ['linked.png', 'unused.png'], beforeOpen: async ({ base, root }) => {
    const outside = path.join(base, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'External.org'), '[[file:../notes/assets/linked.png]]');
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } });
  try {
    assert.deepEqual(candidateNames(await complete(f)), ['unused.png']);
  } finally { await f.close(); }
});

test('the uncapped collector resolves file aliases and raw plain-text paths conservatively', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture({ assets: ['actual.png', 'unused.png'] });
  try {
    const alias = path.join(f.root, 'alias.png');
    await fs.symlink(path.join(f.root, 'assets', 'actual.png'), alias);
    const candidates = ['actual.png', 'unused.png'].map((name) => ({ id: name, name, path: path.join(f.root, 'assets', name) }));
    for (const [format, source] of [['plain', 'alias.png'], ['markdown', '[Alias](alias.png)'], ['org', '[[file:alias.png]]']]) {
      assert.deepEqual(await collectAssetReferences({ path: path.join(f.root, 'Note.txt'), format, source }, candidates), ['actual.png']);
    }
  } finally { await f.close(); }
});

test('extensionless image aliases in plain-text paths and Undo are protected', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture({ notes: { 'Note.txt': 'Ordinary text.' }, assets: ['actual.png', 'unused.png'] });
  try {
    const alias = path.join(f.root, 'image-alias');
    await fs.symlink(path.join(f.root, 'assets', 'actual.png'), alias);
    const candidates = ['actual.png', 'unused.png'].map((name) => ({ id: name, name, path: path.join(f.root, 'assets', name) }));
    assert.deepEqual(await collectAssetReferences({ path: path.join(f.root, 'nested', 'Note.txt'), format: 'plain', source: '../image-alias' }, candidates), ['actual.png']);
    await f.cleanup.protectHistory(f.library.active().id, './image-alias');
    const result = await complete(f);
    assert.deepEqual(candidateNames(result), ['unused.png']); assert.equal(result.protectedCount, 1);
    await f.restartCleanup();
    await f.cleanup.protectHistory(f.library.active().id, 'image-alias');
    assert.deepEqual(candidateNames(await complete(f)), ['unused.png']);
  } finally { await f.close(); }
});

test('active recovery drafts protect assets while older saved snapshots form a separate review category', async () => {
  const f = await fixture({ assets: ['draft.png', 'base.png', 'backup.png', 'unused.png'] });
  try {
    const note = path.join(f.root, 'Note.md');
    await f.recovery('drafts', { version: 1, libraryRoot: f.root, path: note, source: '![Draft](assets/draft.png)', baseSource: '![Base](assets/base.png)' });
    await f.recovery('snapshots', { version: 2, path: note, buffer: 'Old text', disk: { source: '![Old](assets/backup.png)' } });
    const result = await complete(f);
    assert.deepEqual(candidateNames(result), ['backup.png', 'unused.png']);
    assert.equal(result.candidates.find((asset) => asset.name === 'backup.png').category, 'backup');
    assert.equal(result.candidates.find((asset) => asset.name === 'unused.png').category, 'unused');
    const backup = result.candidates.find((asset) => asset.name === 'backup.png');
    assert.deepEqual(await f.cleanup.trash(result.scanId, [backup.id]), { removed: [backup.id], failed: [] });
    assert.deepEqual(f.trashed, ['backup.png']);
  } finally { await f.close(); }
});

test('Undo pins survive folder changes and reset only when the cleanup session restarts', async () => {
  const f = await fixture({ assets: ['undo.png', 'unused.png'] });
  try {
    const note = f.library.active();
    await f.cleanup.protectHistory(note.id, '![Old](assets/undo.png)');
    let result = await complete(f);
    assert.deepEqual(candidateNames(result), ['unused.png']); assert.equal(result.protectedCount, 1);
    const another = path.join(f.base, 'another'); await fs.mkdir(another);
    await f.library.open(another); await f.library.open(f.root);
    result = await complete(f);
    assert.deepEqual(candidateNames(result), ['unused.png']); assert.equal(result.protectedCount, 1);
    await f.restartCleanup();
    assert.deepEqual(candidateNames(await complete(f)), ['undo.png', 'unused.png']);
  } finally { await f.close(); }
});

test('new-note txt syntax preferences never narrow cleanup reference collection', async () => {
  const f = await fixture({ notes: { 'Note.txt': 'assets/keep.png\n[[file:assets/org.png]]\n![md](assets/md.png)' }, assets: ['keep.png', 'org.png', 'md.png', 'unused.png'] });
  try {
    for (const txtSyntax of ['plain', 'org', 'markdown']) {
      await f.library.setPreferences({ txtSyntax });
      assert.deepEqual(candidateNames(await complete(f)), ['unused.png']);
    }
  } finally { await f.close(); }
});

test('txt cleanup unions encoded Markdown, Org and plain paths independently of the displayed format', async () => {
  const source = '![Markdown][picture]\n\n[picture]: assets/%6Dd.png\n\n[[file:assets/%6Frg.png][Org]]\n\nassets/%70lain.png';
  const f = await fixture({ notes: { 'Note.txt': source }, assets: ['md.png', 'org.png', 'plain.png', 'unused.png'] });
  try {
    const candidates = ['md.png', 'org.png', 'plain.png', 'unused.png'].map((name) => ({ id: name, name, path: path.join(f.root, 'assets', name) }));
    for (const format of ['plain', 'markdown', 'org']) {
      assert.deepEqual((await collectAssetReferences({ path: path.join(f.root, 'Note.txt'), format, source }, candidates)).sort(), ['md.png', 'org.png', 'plain.png']);
    }
    assert.deepEqual(candidateNames(await complete(f)), ['unused.png']);
    assert.equal(await fs.readFile(path.join(f.root, 'Note.txt'), 'utf8'), source);
  } finally { await f.close(); }
});

test('txt reference union remains uncapped and resolves linked notes from their physical locations', async () => {
  const names = Array.from({ length: 130 }, (_, index) => `picture-${index}.png`);
  const source = names.map((name) => `![Image](../notes/assets/%70${name.slice(1)})`).join('\n\n') + '\n\n[[file:../notes/assets/%6Frg.png]]';
  const f = await fixture({ notes: {}, assets: [...names, 'org.png', 'unused.png'], beforeOpen: async ({ base, root }) => {
    const outside = path.join(base, 'outside'); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'External.txt'), source);
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } });
  try { assert.deepEqual(candidateNames(await complete(f)), ['unused.png']); }
  finally { await f.close(); }
});

test('txt recovery and Undo retain references from other syntax interpretations', async () => {
  const f = await fixture({ notes: { 'Note.txt': 'Current prose.' }, assets: ['draft.png', 'base.png', 'backup.png', 'undo.png', 'unused.png'] });
  try {
    const note = f.library.active();
    await f.recovery('drafts', { version: 2, libraryRoot: f.root, path: note.path,
      source: '[[file:assets/%64raft.png]]', baseSource: '![Base](assets/%62ase.png)' });
    await f.recovery('snapshots', { version: 2, path: note.path, buffer: '![Backup][old]\n\n[old]: assets/%62ackup.png' });
    await f.cleanup.protectHistory(note.id, '[[file:assets/%75ndo.png]]');
    const result = await complete(f);
    assert.deepEqual(candidateNames(result), ['backup.png', 'unused.png']);
    assert.equal(result.candidates.find((asset) => asset.name === 'backup.png').category, 'backup');
    assert.equal(result.protectedCount, 1);
  } finally { await f.close(); }
});

test('txt cleanup resolves extensionless aliases under every syntax interpretation', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture({ assets: ['actual.png', 'unused.png'] });
  try {
    const external = path.join(f.base, 'external'); await fs.mkdir(external);
    await fs.symlink(path.join(f.root, 'assets', 'actual.png'), path.join(external, 'image alias'));
    const candidates = ['actual.png', 'unused.png'].map((name) => ({ id: name, name, path: path.join(f.root, 'assets', name) }));
    const sources = ['[Image](<../external/image%20alias>)', '[[file:../external/image%20alias][Image]]', '../external/image%20alias'];
    for (const format of ['plain', 'markdown', 'org']) {
      for (const source of sources) assert.deepEqual(await collectAssetReferences({ path: path.join(f.root, 'Note.txt'), format, source }, candidates), ['actual.png']);
    }
  } finally { await f.close(); }
});

test('an incomplete alternate txt interpretation blocks asset cleanup', async () => {
  const f = await fixture({ notes: { 'Note.txt': '> '.repeat(200) + '[Image](assets/%75nused.png)' } });
  try {
    const result = await f.scan();
    assert.equal(result.status, 'error'); assert.equal(result.candidates.length, 0);
    assert.match(result.errors.join(' '), /nesting/); assert.deepEqual(f.trashed, []);
  } finally { await f.close(); }
});

test('imports are protected before their exclusive write and while insertion is still pending', async () => {
  const f = await fixture();
  try {
    const finish = f.cleanup.beginImport(f.root);
    let created;
    try {
      await insertImageBytes(f.root, f.library.active(), pixel, 'New image.png', { onCreated(file) { created = file; f.cleanup.protectImport(f.root, file); } });
      const failed = await f.scan(); assert.equal(failed.status, 'error'); assert.match(failed.errors.join(' '), /import.*progress/i);
    } finally { finish(); }
    const result = await complete(f);
    assert.deepEqual(candidateNames(result), ['unused.png']); assert.equal(result.protectedCount, 1);
    assert.ok(created);
    await f.restartCleanup();
    assert.ok(candidateNames(await complete(f)).some((name) => name.startsWith('New image-')));
  } finally { await f.close(); }
});

test('new live references invalidate a previously reviewed unused asset', async () => {
  const f = await fixture();
  try {
    const result = await complete(f);
    const note = f.library.active();
    await f.library.updateBuffer(note.id, '![Now used](assets/unused.png)', note.clientVersion + 1, note.revision);
    await assert.rejects(f.cleanup.trash(result.scanId, [result.candidates[0].id]), /references changed/);
    assert.deepEqual(f.trashed, []);
  } finally { await f.close(); }
});

test('changed assets, symlink replacements and a symlinked assets directory cannot be removed', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    let result = await complete(f);
    await fs.writeFile(path.join(f.root, 'assets', 'unused.png'), Buffer.concat([pixel, Buffer.from('changed')]));
    await assert.rejects(f.cleanup.trash(result.scanId, [result.candidates[0].id]), /image or its references changed/i);
    result = await complete(f);
    await fs.unlink(path.join(f.root, 'assets', 'unused.png'));
    const external = path.join(f.base, 'original.png'); await fs.writeFile(external, pixel);
    await fs.symlink(external, path.join(f.root, 'assets', 'unused.png'));
    await assert.rejects(f.cleanup.trash(result.scanId, [result.candidates[0].id]), /references changed/);
    await fs.rename(path.join(f.root, 'assets'), path.join(f.base, 'old-assets'));
    await fs.symlink(path.join(f.base, 'old-assets'), path.join(f.root, 'assets'), 'dir');
    const failed = await f.scan(); assert.equal(failed.status, 'error'); assert.match(failed.errors.join(' '), /regular folder/);
    assert.deepEqual(f.trashed, []); assert.deepEqual(await fs.readFile(external), pixel);
  } finally { await f.close(); }
});

test('nested images, image symlinks and non-image files remain outside cleanup', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.root, 'assets', 'nested'));
    await fs.writeFile(path.join(f.root, 'assets', 'nested', 'nested.png'), pixel);
    await fs.writeFile(path.join(f.root, 'assets', 'readme.txt'), 'preserve');
    await fs.symlink(path.join(f.root, 'assets', 'unused.png'), path.join(f.root, 'assets', 'alias.png'));
    assert.deepEqual(candidateNames(await complete(f)), ['unused.png']);
  } finally { await f.close(); }
});

test('invalid recovery and parser failures block cleanup without classifying files unused', async () => {
  const f = await fixture();
  try {
    const record = await f.recovery('snapshots', { version: 2, path: path.join(f.root, 'Note.md'), buffer: 123 });
    let result = await f.scan(); assert.equal(result.status, 'error'); assert.equal(result.candidates.length, 0);
    await fs.unlink(record);
    await fs.writeFile(path.join(f.root, 'broken.md'), '> '.repeat(200) + 'Too deep');
    result = await f.scan(); assert.equal(result.status, 'error'); assert.match(result.errors.join(' '), /nesting/);
    assert.deepEqual(f.trashed, []);
  } finally { await f.close(); }
});

test('individual Trash failures preserve their files and report partial success', async () => {
  const f = await fixture({ assets: ['fail.png', 'good.png'], trash: async (file) => { if (file.endsWith('fail.png')) throw new Error('Trash denied'); } });
  try {
    const result = await complete(f);
    const outcome = await f.cleanup.trash(result.scanId, result.candidates.map((asset) => asset.id));
    assert.equal(outcome.removed.length, 1); assert.equal(outcome.failed.length, 1); assert.match(outcome.failed[0].error, /denied/);
    assert.deepEqual(f.trashed, ['good.png']); await fs.access(path.join(f.root, 'assets', 'fail.png'));
  } finally { await f.close(); }
});

test('a newly created note during batch cleanup protects later selected assets', async () => {
  let f, inserted = false;
  f = await fixture({ assets: ['a.png', 'z.png'], trash: async () => {
    if (!inserted) { inserted = true; await fs.writeFile(path.join(f.root, 'New.md'), '![Now needed](assets/z.png)'); }
  } });
  try {
    const result = await complete(f);
    const outcome = await f.cleanup.trash(result.scanId, result.candidates.map((asset) => asset.id));
    assert.deepEqual(f.trashed, ['a.png']); assert.equal(outcome.removed.length, 1); assert.equal(outcome.failed.length, 1);
    await fs.access(path.join(f.root, 'assets', 'z.png'));
  } finally { await f.close(); }
});

test('new recovery records during batch cleanup protect later selected assets', async () => {
  let f, inserted = false;
  f = await fixture({ assets: ['a.png', 'z.png'], trash: async () => {
    if (!inserted) {
      inserted = true;
      await f.recovery('drafts', { version: 2, libraryRoot: f.root, path: path.join(f.root, 'Note.md'), source: '![Draft](assets/z.png)' }, 'new-draft.json');
    }
  } });
  try {
    const result = await complete(f);
    const outcome = await f.cleanup.trash(result.scanId, result.candidates.map((asset) => asset.id));
    assert.deepEqual(f.trashed, ['a.png']); assert.equal(outcome.removed.length, 1); assert.equal(outcome.failed.length, 1);
    await fs.access(path.join(f.root, 'assets', 'z.png'));
  } finally { await f.close(); }
});

test('new unreadable UTF-8 notes make cleanup incomplete without modifying assets', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.root, 'Invalid.md'), Buffer.from([0xc3, 0x28]));
    const result = await f.scan(); assert.equal(result.status, 'error'); assert.match(result.errors.join(' '), /UTF-8/);
    assert.deepEqual(f.trashed, []); await fs.access(path.join(f.root, 'assets', 'unused.png'));
  } finally { await f.close(); }
});

test('large recovery histories stream within a bounded main-process heap', { timeout: 60000 }, async () => {
  const f = await fixture({ notes: { 'Note.txt': 'Current note.' }, assets: ['backup.png', 'unused.png'] });
  try {
    const hash = createHash('sha256').update(f.root).digest('hex').slice(0, 24);
    const snapshots = path.join(f.userData, 'recovery', hash, 'snapshots');
    await fs.mkdir(snapshots, { recursive: true });
    const text = 'assets/backup.png\n' + 'x'.repeat(3 * 1024 * 1024);
    for (let index = 0; index < 48; index++) await fs.writeFile(path.join(snapshots, `${index}.json`), JSON.stringify({ version: 2, path: path.join(f.root, 'Note.txt'), buffer: text + index }));
    const output = execFileSync(process.execPath, ['--max-old-space-size=96', '-e', `
      (async () => {
      const { createLibrary } = await import(${JSON.stringify(new URL('../electron/library.cjs', import.meta.url).href)});
      const { createAssetCleanup } = await import(${JSON.stringify(new URL('../electron/asset-cleanup.cjs', import.meta.url).href)});
      const root = process.argv[1], userData = process.argv[2];
      const library = createLibrary({ userData });
      await library.open(root);
      let resolve;
      const finished = new Promise((done) => { resolve = done; });
      const cleanup = createAssetCleanup({ library, userData, onProgress(event) {
        if (['complete', 'error'].includes(event.status)) resolve(event);
      } });
      try {
        cleanup.start();
        const result = await finished;
        if (result.status !== 'complete') throw new Error(result.errors.join('; '));
        console.log(JSON.stringify(result.candidates.map((asset) => [asset.name, asset.category]).sort()));
      } finally { await cleanup.dispose(); await library.dispose(); }
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `, f.root, f.userData], { encoding: 'utf8', timeout: 50000, maxBuffer: 1024 * 1024 });
    assert.deepEqual(JSON.parse(output), [['backup.png', 'backup'], ['unused.png', 'unused']]);
  } finally { await f.close(); }
});

test('cancelled scans and scans belonging to a previous library cannot remove images', async () => {
  const f = await fixture();
  try {
    const { scanId } = f.cleanup.start(); f.cleanup.cancel(scanId);
    await assert.rejects(f.cleanup.trash(scanId, ['unknown']), /no longer current/);
    const result = await complete(f);
    const other = path.join(f.base, 'other'); await fs.mkdir(other); await f.library.open(other);
    await assert.rejects(f.cleanup.trash(result.scanId, [result.candidates[0].id]), /notes folder changed/);
    assert.deepEqual(f.trashed, []);
  } finally { await f.close(); }
});
