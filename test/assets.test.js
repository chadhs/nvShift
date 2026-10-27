import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { insertImageBytes, insertImageFiles } from '../electron/assets.cjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64');

test('image insertion copies bytes once per insert and links correctly from nested notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvshift-images-'));
  try {
    await mkdir(path.join(root, 'nested'));
    const note = { path: path.join(root, 'nested', 'note.txt'), format: 'markdown' };
    const first = await insertImageBytes(root, note, png, 'image.png');
    assert.match(first.text, /^!\[Image\]\(\.\.\/assets\/[a-f0-9-]+\.png\)$/);
    const file = first.text.slice('![Image]('.length, -1);
    assert.deepEqual(await readFile(path.resolve(path.dirname(note.path), file)), png);
    const second = await insertImageBytes(root, { ...note, format: 'org' }, png, 'image.png');
    assert.match(second.text, /^\[\[file:\.\.\/assets\/.+\.png\]\]$/);
    const plain = await insertImageBytes(root, { ...note, format: 'plain' }, png, 'image.png');
    assert.match(plain.text, /^\.\.\/assets\/[^\n]+\.png$/);
    assert.equal((await readdir(path.join(root, 'assets'))).length, 3);
    await assert.rejects(insertImageBytes(root, note, Buffer.from('bad'), 'bad.png'), /invalid image/);
    await assert.rejects(insertImageBytes(root, note, new Uint8Array(8 * 1024 * 1024 + 1), 'bad.png'), /8 MiB/);
    const input = path.join(root, 'source.png');
    await writeFile(input, png);
    assert.match((await insertImageFiles(root, note, [input])).text, /assets/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an existing symlink cannot redirect asset writes outside the library', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvshift-image-symlink-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'nvshift-image-outside-'));
  try {
    await symlink(outside, path.join(root, 'assets'));
    await assert.rejects(insertImageBytes(root, { path: path.join(root, 'note.md'), format: 'markdown' }, png, 'image.png'), /regular folder/);
    assert.equal((await readdir(outside)).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
