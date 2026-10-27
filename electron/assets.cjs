// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { imageMime, MAX_IMAGE_BYTES } = require('./images.cjs');

const extensions = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg' };
const filenameSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Retain a readable basename without exceeding portable filename limits. */
function imageFilenamePrefix(name) {
  // Import callers supply a basename. Keep reserved backslashes in that name
  // until sanitization rather than treating them as Windows path separators.
  const filename = typeof name === 'string' ? path.posix.basename(name.toWellFormed()).normalize('NFC') : '';
  const stem = filename.slice(0, filename.length - path.posix.extname(filename).length)
    .replace(/[<>:"/\\|?*\p{Cc}\p{Zl}\p{Zp}]/gu, '-')
    .replace(/^[.\s]+|[.\s]+$/gu, '');
  let prefix = '', bytes = 0;
  for (const { segment } of filenameSegments.segment(stem)) {
    const size = Buffer.byteLength(segment, 'utf8');
    if (bytes + size > 120) break;
    prefix += segment; bytes += size;
  }
  return prefix.replace(/[.\s]+$/gu, '') || 'image';
}
const encodeSegment = (segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

function insertionText(note, destination, { platform = process.platform } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const relative = paths.relative(paths.dirname(note.path), destination);
  // Windows has no relative path between drives. The existing resource reader
  // already accepts local file URLs, including Unicode and escaped delimiters.
  const target = paths.isAbsolute(relative)
    ? pathToFileURL(destination, { windows: platform === 'win32' }).href.replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    : relative.split(paths.sep).map(encodeSegment).join('/');
  if (note.format === 'markdown') return `![Image](${target})`;
  if (note.format === 'org') return `[[${target.startsWith('file:') ? '' : 'file:'}${target}]]`;
  return target;
}
/** Copy only verified image bytes into the selected library's own assets directory. */
async function insertImageBytes(root, note, value, name = null, { onCreated = () => {} } = {}) {
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
  const destination = path.join(directory, `${imageFilenamePrefix(name)}-${randomUUID()}${extensions[mime]}`);
  // Register the destination before it exists, so cleanup cannot race the
  // interval between the exclusive write and inserting its editor reference.
  onCreated(destination);
  await fs.writeFile(destination, bytes, { flag: 'wx' });
  return { text: insertionText(note, destination) };
}
async function insertImageFiles(root, note, files, options) {
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
      texts.push((await insertImageBytes(root, note, bytes.subarray(0, total), path.basename(file), options)).text);
    } finally { await handle.close(); }
  }
  return { text: texts.join('\n') };
}
module.exports = { insertImageBytes, insertImageFiles, insertionText, imageFilenamePrefix };
