import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { scanDirectoryGraph, assertGraphLocation, directoryIdentity, pathKey } from '../electron/directory-graph.cjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nvshift-graph-'));
  const directory = await fs.realpath(temporary);
  const root = path.join(directory, 'notes');
  await fs.mkdir(root);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, root };
}
async function write(file, source = 'A note') { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, source); }
const linkDirectory = (target, file) => fs.symlink(target, file, process.platform === 'win32' ? 'junction' : 'dir');
const relativeFiles = (graph) => [...graph.files.values()].map((entry) => path.relative(graph.root, entry.logicalPath).split(path.sep).join('/')).sort();

test('directory graph follows internal and external links, nested links, and exclusions', async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside'), more = path.join(directory, 'more');
  await write(path.join(root, 'ordinary', 'inside.MD'));
  await write(path.join(outside, 'external.org'));
  await write(path.join(outside, '.hidden', 'no.md'));
  await write(path.join(outside, 'assets', 'no.txt'));
  await write(path.join(outside, 'node_modules', 'no.md'));
  await write(path.join(more, 'deep.txt'));
  await write(path.join(outside, 'ignored.json'));
  await linkDirectory(outside, path.join(root, 'linked'));
  await linkDirectory(more, path.join(outside, 'nested'));
  await linkDirectory(path.join(root, 'ordinary'), path.join(root, 'alias'));
  const graph = await scanDirectoryGraph(root);
  assert.deepEqual(relativeFiles(graph), ['linked/external.org', 'linked/nested/deep.txt', 'ordinary/inside.MD']);
  assert.equal(graph.files.get(pathKey(path.join(outside, 'external.org'))).path, path.join(outside, 'external.org'));
  assert.equal(graph.directories.get(pathKey(more)).bindings.length, 2);
  assert.equal(graph.errors.length, 0);
  assert.ok(graph.watchRoots.includes(root));
  assert.ok(graph.watchRoots.includes(outside));
  assert.ok(graph.watchRoots.includes(more));
  await assertGraphLocation(graph, path.join(more, 'deep.txt'));
});

test('cycles and duplicate aliases index each real note once and prefer direct paths', async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await write(path.join(root, 'z-direct', 'one.md'));
  await write(path.join(outside, 'two.md'));
  await linkDirectory(path.join(root, 'z-direct'), path.join(root, 'a-alias'));
  await linkDirectory(outside, path.join(root, 'b-linked'));
  await linkDirectory(outside, path.join(root, 'a-linked'));
  await linkDirectory(root, path.join(outside, 'back-to-library'));
  await linkDirectory(outside, path.join(outside, 'self'));
  const graph = await scanDirectoryGraph(root);
  assert.deepEqual(relativeFiles(graph), ['a-linked/two.md', 'z-direct/one.md']);
  assert.equal(graph.files.size, 2);
  assert.equal(graph.directories.size, 3);
  assert.equal(graph.links.size, 5);
  assert.equal(graph.watchRoots.length, 2);
});

test('lexical linked route selection includes ordinary descendants in the same priority queue', async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await write(path.join(outside, 'z', 'one.md'));
  await linkDirectory(outside, path.join(root, 'a'));
  await linkDirectory(path.join(outside, 'z'), path.join(root, 'a-b'));
  const graph = await scanDirectoryGraph(root);
  assert.deepEqual(relativeFiles(graph), ['a-b/one.md']);
  assert.equal(graph.watchRoots.length, 2);
});

test('visible links can expose a hidden target root while hidden entries remain excluded', async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, '.private-notes');
  await write(path.join(outside, 'visible.md'));
  await write(path.join(outside, '.hidden.md'));
  await linkDirectory(outside, path.join(root, 'journal'));
  const graph = await scanDirectoryGraph(root);
  assert.deepEqual(relativeFiles(graph), ['journal/visible.md']);
});

test('broken links report one error while healthy directories still scan', async (t) => {
  const { root, directory } = await fixture(t);
  await write(path.join(root, 'healthy.md'));
  await linkDirectory(path.join(directory, 'missing'), path.join(root, 'broken'));
  const graph = await scanDirectoryGraph(root);
  assert.deepEqual(relativeFiles(graph), ['healthy.md']);
  assert.equal(graph.errors.length, 1);
  assert.match(graph.errors[0].message, /unavailable/);
  assert.equal(graph.errors[0].path, path.join(root, 'broken'));
  assert.ok(graph.links.has(pathKey(path.join(root, 'broken'))));
});

test('individual file symlinks stay excluded without becoming library errors', { skip: process.platform === 'win32' }, async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside.md');
  await write(outside);
  await fs.symlink(outside, path.join(root, 'linked-file.md'));
  const graph = await scanDirectoryGraph(root);
  assert.equal(graph.files.size, 0);
  assert.equal(graph.errors.length, 0);
});

test('canonical and expected directory identity protect existing notes and sibling creation', async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await write(path.join(outside, 'note.md'));
  await linkDirectory(outside, path.join(root, 'linked'));
  const graph = await scanDirectoryGraph(root);
  const identity = directoryIdentity(await fs.stat(outside));
  assert.equal((await assertGraphLocation(graph, path.join(outside, 'note.md'), identity)).path, outside);
  await assertGraphLocation(graph, path.join(outside, 'new.md'), identity);
  await assert.rejects(assertGraphLocation(graph, path.join(outside, 'new.md'), 'different'), { code: 'NVSHIFT_LOCATION_CHANGED' });
  await assert.rejects(assertGraphLocation(graph, path.join(directory, 'unselected', 'note.md')), { code: 'NVSHIFT_LOCATION_CHANGED' });
});

test('retargeting or removing an alias invalidates the old graph before watcher reconciliation', async (t) => {
  const { root, directory } = await fixture(t);
  const first = path.join(directory, 'first'), second = path.join(directory, 'second');
  await write(path.join(first, 'note.md'));
  await write(path.join(second, 'note.md'));
  const alias = path.join(root, 'linked');
  await linkDirectory(first, alias);
  const graph = await scanDirectoryGraph(root);
  await fs.unlink(alias); await linkDirectory(second, alias);
  await assert.rejects(assertGraphLocation(graph, path.join(first, 'note.md')), { code: 'NVSHIFT_LOCATION_CHANGED' });
  const updated = await scanDirectoryGraph(root);
  await assertGraphLocation(updated, path.join(second, 'note.md'));
  await fs.unlink(alias);
  await assert.rejects(assertGraphLocation(updated, path.join(second, 'note.md')), { code: 'NVSHIFT_LOCATION_CHANGED' });
});

test('same-path directory replacement does not reuse an old location pin', async (t) => {
  const { root } = await fixture(t);
  const folder = path.join(root, 'folder');
  await write(path.join(folder, 'note.md'));
  const graph = await scanDirectoryGraph(root);
  const original = graph.directories.get(pathKey(folder)).identity;
  await fs.rename(folder, path.join(root, 'old-folder'));
  await write(path.join(folder, 'note.md'), 'new location');
  await assert.rejects(assertGraphLocation(graph, path.join(folder, 'note.md')), { code: 'NVSHIFT_LOCATION_CHANGED' });
  const next = await scanDirectoryGraph(root);
  await assert.rejects(assertGraphLocation(next, path.join(folder, 'note.md'), original), { code: 'NVSHIFT_LOCATION_CHANGED' });
});

test('ancestor link retargeting is rejected even when a compensating nested link reaches the same leaf', async (t) => {
  const { root, directory } = await fixture(t);
  const first = path.join(directory, 'first'), second = path.join(directory, 'second'), leaf = path.join(directory, 'leaf');
  await fs.mkdir(first); await fs.mkdir(second);
  await write(path.join(leaf, 'note.md'));
  await linkDirectory(leaf, path.join(first, 'nested'));
  await linkDirectory(leaf, path.join(second, 'nested'));
  const alias = path.join(root, 'linked');
  await linkDirectory(first, alias);
  const graph = await scanDirectoryGraph(root);
  await fs.unlink(alias); await linkDirectory(second, alias);
  assert.equal(await fs.realpath(path.join(alias, 'nested')), leaf);
  await assert.rejects(assertGraphLocation(graph, path.join(leaf, 'note.md')), { code: 'NVSHIFT_LOCATION_CHANGED' });
});

test('a selected canonical library root replaced by a symlink cannot silently select a different tree', async (t) => {
  const { root, directory } = await fixture(t);
  const outside = path.join(directory, 'outside');
  await write(path.join(root, 'original.md'));
  await write(path.join(outside, 'different.md'));
  await scanDirectoryGraph(root);
  await fs.rename(root, path.join(directory, 'original-notes'));
  await linkDirectory(outside, root);
  await assert.rejects(scanDirectoryGraph(root), { code: 'NVSHIFT_LOCATION_CHANGED' });
});
