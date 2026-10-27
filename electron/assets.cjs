// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { imageMime, MAX_IMAGE_BYTES } = require('./images.cjs');

const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };

function insertionText(note, destination) {
  const relative = path.relative(path.dirname(note.path), destination).split(path.sep).map(encodeURIComponent).join('/');
  if (note.format === 'markdown') return `![Image](${relative})`;
  if (note.format === 'org') return `[[file:${relative}]]`;
  return relative;
}
/** Copy only verified image bytes into the selected library's own assets directory. */
async function insertImageBytes(root, note, value, name = 'pasted.png') {
  if (!root || !note) throw new Error('Open a note before inserting an image.');
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) throw new Error('Invalid image data.');
  if (!value.length || value.length > MAX_IMAGE_BYTES) throw new Error('Images must be no larger than 8 MiB.');
  if (Array.isArray(value) && value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid image data.');
  const bytes = Buffer.from(value);
  const mime = imageMime(typeof name === 'string' ? name : null, bytes);
  const directory = path.join(root, 'assets');
  await fs.mkdir(directory).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The assets location must be a regular folder inside your notes folder.');
  const resolved = await fs.realpath(directory);
  if (resolved !== path.join(await fs.realpath(root), 'assets')) throw new Error('The assets folder must remain inside your notes folder.');
  const destination = path.join(directory, `${randomUUID()}${extensions[mime]}`);
  await fs.writeFile(destination, bytes, { flag: 'wx' });
  return { text: insertionText(note, destination) };
}
async function insertImageFiles(root, note, files) {
  if (!Array.isArray(files) || !files.length || files.length > 20 || files.some((file) => typeof file !== 'string')) throw new Error('Drop between one and twenty image files.');
  const texts = [];
  for (const file of files) {
    const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Choose image files no larger than 8 MiB.');
      const bytes = Buffer.alloc(stat.size + 1);
      let total = 0;
      while (total < bytes.length) {
        const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_IMAGE_BYTES || total > stat.size) throw new Error('The image changed while it was being copied. Try again.');
      texts.push((await insertImageBytes(root, note, bytes.subarray(0, total), path.basename(file))).text);
    } finally { await handle.close(); }
  }
  return { text: texts.join('\n') };
}
module.exports = { insertImageBytes, insertImageFiles, insertionText };
