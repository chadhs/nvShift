const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { documentFormat } = require('./formats.cjs');
const { assertLocalPath } = require('./local-paths.cjs');
const MAX_BYTES = 16 * 1024 * 1024;
const sizeError = () => new Error('Markup Preview supports files up to 16 MiB.');

async function readDocument(filePath) {
  assertLocalPath(filePath);
  if (!documentFormat(filePath)) throw new Error('Choose an .org, .md, or .markdown file.');
  const absolute = assertLocalPath(path.resolve(filePath));
  // A FIFO must not block before we can inspect its file descriptor.
  const handle = await fsp.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Choose a file, not a directory.');
    if (stat.size > MAX_BYTES) throw sizeError();
    const chunks = [];
    let total = 0;
    while (total <= MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total > MAX_BYTES) throw sizeError();
    return { format: documentFormat(filePath), path: absolute, name: path.basename(absolute), source: Buffer.concat(chunks, total).toString('utf8'), modified: stat.mtimeMs, size: total };
  } finally { await handle.close(); }
}

function watchDocument(filePath, onChange, onError, interval = 300) {
  let stopped = false;
  let revision = 0;
  const listener = async () => {
    const current = ++revision;
    try {
      const doc = await readDocument(filePath);
      if (!stopped && current === revision) onChange(doc);
    } catch (error) {
      if (!stopped && current === revision) onError(error);
    }
  };
  // Poll the pathname so atomic editor saves and delete/recreate keep working.
  fs.watchFile(filePath, { interval }, listener);
  // Recheck after subscribing: a save may have landed since the initial open.
  void listener();
  return () => { stopped = true; revision++; fs.unwatchFile(filePath, listener); };
}
module.exports = { readDocument, watchDocument, MAX_BYTES };
