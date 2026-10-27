const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { resolveLocalPath } = require('./local-paths.cjs');
const { MAX_IMAGE_LINKS } = require('./formats.cjs');
const { documentResource } = require('./resource-index.cjs');
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_TIMEOUT_MS = 15_000;
const MAX_IMAGE_REDIRECTS = 5;

function imageMime(file, bytes) {
  const ext = file === null ? null : path.extname(file).toLowerCase();
  if ((ext === null || ext === '.png') && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if ((ext === null || ['.jpg', '.jpeg'].includes(ext)) && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if ((ext === null || ext === '.gif') && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if ((ext === null || ext === '.webp') && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  const svg = bytes.subarray(0, 4096).toString('utf8');
  if (ext === '.svg' && /<svg(?:\s|>)/i.test(svg)) return 'image/svg+xml';
  if (ext === null && /^\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE\s+svg\b[^>]*>\s*)?<svg(?:\s|>)/i.test(svg)) return 'image/svg+xml';
  throw new Error('Unsupported or invalid image.');
}

function remoteUrl(target, base) {
  let url;
  try { url = new URL(target, base); } catch { throw new Error('Invalid remote image URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Remote images require HTTP or HTTPS.');
  if (url.username || url.password) throw new Error('Remote image URLs cannot contain credentials.');
  return url;
}

async function remoteBytes(url, available, consume, fetchImage, signal) {
  for (let redirects = 0; ; redirects++) {
    signal.throwIfAborted();
    const response = await fetchImage(url.href, { redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      if (redirects >= MAX_IMAGE_REDIRECTS) throw new Error('Remote image exceeds five redirects.');
      const location = response.headers.get('location');
      if (!location) throw new Error('Remote image redirect has no destination.');
      url = remoteUrl(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Remote image returned HTTP ${response.status}.`);
    }
    const length = Number(response.headers.get('content-length'));
    if (length > MAX_IMAGE_BYTES || length > available()) {
      await response.body?.cancel();
      throw new Error(length > MAX_IMAGE_BYTES ? 'Image exceeds 8 MiB.' : 'Image limit reached for this document.');
    }
    if (!response.body) throw new Error('Remote image has no data.');
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) throw new Error('Image exceeds 8 MiB.');
        consume(value.byteLength);
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
  }
}

// Bind reads to actual links in one document revision, never renderer-supplied paths.
function createImageReader(doc, { fetch: fetchImage = globalThis.fetch, timeoutMs = IMAGE_TIMEOUT_MS } = {}) {
  let remaining = MAX_DOCUMENT_IMAGE_BYTES;
  let localQueue = Promise.resolve(), remoteQueue = Promise.resolve();
  const cache = new Map();
  const lifecycle = new AbortController();
  const current = () => { if (lifecycle.signal.aborted) throw new Error('The document changed.'); };
  const read = async (request) => {
    try {
      current();
      if (!request || !Number.isSafeInteger(request.start) || !Number.isSafeInteger(request.end) || request.start < 0 || request.end > doc.source.length || request.end <= request.start || request.end - request.start > 8192) throw new Error('Invalid image reference.');
      const reference = doc.source.slice(request.start, request.end);
      if (reference !== request.reference) throw new Error('The document changed. Reopen it to reload images.');
      const { target } = await documentResource(doc, 'images', request);
      current();
      if (!target) throw new Error('Unsupported image link.');
      const url = /^https?:\/\//i.test(target) ? remoteUrl(target) : null;
      const file = url ? null : resolveLocalPath(doc.path, target);
      const key = url ? url.href : file;
      if (cache.has(key)) return await cache.get(key);
      if (cache.size >= MAX_IMAGE_LINKS) throw new Error('Image limit reached for this document.');
      const loading = (url ? remoteQueue : localQueue).then(async () => {
        current();
        // Charge bytes before retaining them, across both concurrent queues.
        let held = 0, retained = false;
        const consume = (bytes) => {
          if (bytes > remaining) throw new Error('Image limit reached for this document.');
          remaining -= bytes; held += bytes;
        };
        try {
          if (url) {
            const controller = new AbortController();
            const signal = AbortSignal.any([lifecycle.signal, controller.signal]);
            const timer = setTimeout(() => controller.abort(new Error('Remote image timed out.')), timeoutMs);
            try {
              const content = await remoteBytes(url, () => remaining, consume, fetchImage, signal);
              current();
              signal.throwIfAborted();
              const mime = imageMime(null, content);
              retained = true;
              return { dataUrl: `data:${mime};base64,${content.toString('base64')}` };
            } catch (error) {
              current();
              if (controller.signal.aborted) throw new Error('Remote image timed out.');
              throw new Error(error.message === 'fetch failed' ? 'Remote image could not be downloaded.' : error.message);
            } finally { clearTimeout(timer); controller.abort(); }
          }
          const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error('The image path is not a file.');
            if (stat.size > MAX_IMAGE_BYTES) throw new Error('Image exceeds 8 MiB.');
            if (stat.size > remaining) throw new Error('Image limit reached for this document.');
            consume(stat.size);
            // Read one extra byte to detect growth without an unbounded readFile.
            const bytes = Buffer.alloc(stat.size + 1);
            let total = 0;
            while (total < bytes.length) {
              current();
              const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
              if (!bytesRead) break;
              total += bytesRead;
            }
            if (total > stat.size) throw new Error('The image changed while loading. Reopen the document to retry.');
            const content = bytes.subarray(0, total);
            current();
            const mime = imageMime(file, content);
            remaining += held - total; held = total;
            retained = true;
            return { dataUrl: `data:${mime};base64,${content.toString('base64')}` };
          } finally { await handle.close(); }
        } finally { if (!retained) remaining += held; }
      }).catch((error) => ({ error: error.code === 'ENOENT' ? 'Image not found.' : error.code === 'EACCES' ? 'Image is not readable.' : error.message }));
      cache.set(key, loading);
      if (url) remoteQueue = loading; else localQueue = loading;
      return await loading;
    } catch (error) {
      return { error: error.message };
    }
  };
  read.cancel = () => { lifecycle.abort(); cache.clear(); };
  return read;
}

module.exports = { createImageReader, imageMime, MAX_IMAGE_BYTES, MAX_DOCUMENT_IMAGE_BYTES, IMAGE_TIMEOUT_MS, MAX_IMAGE_REDIRECTS };
