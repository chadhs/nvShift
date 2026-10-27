import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { insertImageBytes, insertImageFiles, insertionText, imageFilenamePrefix } from '../electron/assets.cjs';
import { createImageReader } from '../electron/images.cjs';
import { resolveLocalPath } from '../electron/local-paths.cjs';
import { renderDocument } from '../src/documents.js';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=', 'base64');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';

test('image insertion copies bytes once per insert and links correctly from nested notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvshift-images-'));
  try {
    await mkdir(path.join(root, 'nested'));
    const note = { path: path.join(root, 'nested', 'note.txt'), format: 'markdown' };
    const first = await insertImageBytes(root, note, png, 'image.png');
    assert.match(first.text, new RegExp(`^!\\[Image\\]\\(\\.\\./assets/image-${uuid}\\.png\\)$`));
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

test('image prefixes retain readable stems and cap complete Unicode characters to 120 UTF-8 bytes', () => {
  assert.equal(imageFilenamePrefix('architecture diagram.png'), 'architecture diagram');
  assert.equal(imageFilenamePrefix('café 日本語.png'), 'café 日本語');
  assert.equal(imageFilenamePrefix('cafe\u0301.png'), 'café');
  assert.equal(imageFilenamePrefix('... sketch:.draft<>"\\|?*\n.png'), 'sketch-.draft--------');
  assert.equal(imageFilenamePrefix('  .. png .. .png'), 'png');
  assert.equal(imageFilenamePrefix('... .png'), 'image');
  assert.equal(imageFilenamePrefix(null), 'image');
  const unicode = imageFilenamePrefix(`${'👩🏽‍💻'.repeat(20)}.png`);
  assert.ok(Buffer.byteLength(unicode, 'utf8') <= 120);
  assert.equal(unicode, '👩🏽‍💻'.repeat(8));
  assert.equal(imageFilenamePrefix(`${'a'.repeat(119)}👩🏽‍💻.png`), 'a'.repeat(119));
  assert.equal(imageFilenamePrefix(`${'a'.repeat(118)} .png`), 'a'.repeat(118));
});

test('dropped image basenames prefix unique assets and preserve original bytes and old filenames', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'nvshift-image-names-'));
  try {
    const note = { path: path.join(root, 'note.md'), format: 'markdown' };
    const input = path.join(root, 'architecture diagram.png');
    await writeFile(input, png);
    const first = await insertImageFiles(root, note, [input]);
    const second = await insertImageFiles(root, note, [input]);
    assert.notEqual(first.text, second.text);
    assert.match(first.text, new RegExp(`^!\\[Image\\]\\(assets/architecture%20diagram-${uuid}\\.png\\)$`));
    let names = await readdir(path.join(root, 'assets'));
    assert.equal(names.length, 2);
    for (const name of names) {
      assert.match(name, new RegExp(`^architecture diagram-${uuid}\\.png$`));
      assert.deepEqual(await readFile(path.join(root, 'assets', name)), png);
    }
    assert.deepEqual(await readFile(input), png);
    await insertImageBytes(root, note, png, 'clipboard.png');
    await insertImageBytes(root, note, png);
    await insertImageBytes(root, note, Buffer.from([255, 216, 255, 224]), 'photo.JPEG');
    names = await readdir(path.join(root, 'assets'));
    assert.ok(names.some((name) => new RegExp(`^clipboard-${uuid}\\.png$`).test(name)));
    assert.ok(names.some((name) => new RegExp(`^image-${uuid}\\.png$`).test(name)));
    assert.ok(names.some((name) => new RegExp(`^photo-${uuid}\\.jpg$`).test(name)));
    const oldName = '11111111-1111-4111-8111-111111111111.png';
    await writeFile(path.join(root, 'assets', oldName), png);
    const doc = { ...note, name: 'note.md', source: `![Old](assets/${oldName})` };
    const reader = createImageReader(doc);
    try {
      const reference = renderDocument(doc).images[0];
      assert.equal((await reader(reference)).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
      assert.deepEqual(await readFile(path.join(root, 'assets', oldName)), png);
    } finally { reader.cancel(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('imports from external physical note paths generate usable Markdown, Org, and configured .txt links', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-linked-image-'));
  const root = path.join(directory, 'library');
  const outside = path.join(directory, 'outside', 'nested');
  await mkdir(root);
  await mkdir(outside, { recursive: true });
  try {
    for (const [extension, format] of [['md', 'markdown'], ['org', 'org'], ['txt', 'markdown'], ['txt', 'org'], ['txt', 'plain']]) {
      const note = { path: path.join(outside, `note.${extension}`), name: `note.${extension}`, format };
      const { text } = await insertImageBytes(root, note, png, 'diagram (draft).png');
      assert.match(text, /\.\.\/\.\.\/library\/assets\/diagram%20%28draft%29-/);
      if (format === 'plain') {
        assert.deepEqual(await readFile(path.resolve(outside, decodeURIComponent(text))), png);
      } else {
        const doc = { ...note, source: text };
        const reader = createImageReader(doc);
        try {
          const reference = renderDocument(doc).images[0];
          assert.ok(reference, text);
          assert.equal((await reader(reference)).dataUrl, `data:image/png;base64,${png.toString('base64')}`);
        } finally { reader.cancel(); }
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Windows same-drive paths remain relative and cross-drive paths use correctly escaped file URLs', () => {
  const destination = 'D:\\notes library\\assets\\café (draft)-image.png';
  const crossDrive = { path: 'C:\\linked notes\\note.txt', format: 'markdown' };
  const url = 'file:///D:/notes%20library/assets/caf%C3%A9%20%28draft%29-image.png';
  assert.equal(insertionText(crossDrive, destination, { platform: 'win32' }), `![Image](${url})`);
  assert.equal(insertionText({ ...crossDrive, format: 'org' }, destination, { platform: 'win32' }), `[[${url}]]`);
  assert.equal(insertionText({ ...crossDrive, format: 'plain' }, destination, { platform: 'win32' }), url);
  assert.equal(resolveLocalPath(crossDrive.path, url, { platform: 'win32' }), destination);
  assert.equal(insertionText({ path: 'D:\\outside\\nested\\note.md', format: 'markdown' }, destination, { platform: 'win32' }), '![Image](../../notes%20library/assets/caf%C3%A9%20%28draft%29-image.png)');
  for (const format of ['markdown', 'org']) {
    const source = insertionText({ ...crossDrive, format }, destination, { platform: 'win32' });
    assert.equal(renderDocument({ name: 'note.txt', format, source }).images[0].target, url);
  }
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
