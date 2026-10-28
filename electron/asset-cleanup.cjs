// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { createHash, randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { scanDirectoryGraph, assertGraphLocation } = require('./directory-graph.cjs');
const { readDisk, MAX_BYTES } = require('./library.cjs');
const { documentFormat } = require('./formats.cjs');
const { imageMime, MAX_IMAGE_BYTES } = require('./images.cjs');

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg)$/i;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const MAX_RECOVERY_BYTES = MAX_BYTES * 16;
const key = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const identity = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const directoryIdentity = (stat) => `${stat.dev}:${stat.ino}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const cancelled = () => Object.assign(new Error('Asset scan cancelled.'), { code: 'NVSHIFT_SCAN_CANCELLED' });
const validSource = (source) => typeof source === 'string' && source.isWellFormed() && !source.includes('\0') && Buffer.byteLength(source, 'utf8') <= MAX_BYTES;
const graphSignature = (graph) => JSON.stringify([
  [...graph.directories.values()].map((directory) => [directory.path, directory.identity, directory.bindings]).sort((a, b) => a[0].localeCompare(b[0])),
  [...graph.files.keys()].sort(), [...graph.links].sort(),
]);

class ReferenceWorker {
  constructor(candidates) {
    this.requests = new Map(); this.sequence = 0; this.closed = false;
    this.worker = new Worker(path.join(__dirname, 'asset-cleanup-worker.cjs'), {
      workerData: { candidates }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
    });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => { this.fail(new Error('Asset reference worker did not start.')); void this.close(); }, 15000);
    this.worker.on('message', (message) => {
      if (message.ready) { clearTimeout(this.readyTimer); this.resolveReady(); return; }
      const request = this.requests.get(message.requestId);
      if (!request) return;
      this.requests.delete(message.requestId); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.ids);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', () => { if (!this.closed) this.fail(new Error('Asset reference processing stopped.')); });
  }
  fail(error) {
    clearTimeout(this.readyTimer); this.failure = error; this.rejectReady(error);
    for (const request of this.requests.values()) { clearTimeout(request.timer); request.reject(error); }
    this.requests.clear();
  }
  async collect(document) {
    await this.ready;
    if (this.closed) throw cancelled();
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      const requestId = ++this.sequence;
      const timer = setTimeout(() => { this.fail(new Error('Asset reference processing exceeded 15 seconds.')); void this.close(); }, 15000);
      this.requests.set(requestId, { resolve, reject, timer });
      this.worker.postMessage({ requestId, document });
    });
  }
  async close() { if (this.closed) return; this.closed = true; this.fail(cancelled()); await this.worker.terminate(); }
}

async function regularBytes(file, limit) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit) throw new Error('The file is not a supported regular file.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (identity(opened) !== identity(before)) throw new Error('The file changed while being checked.');
    const chunks = []; let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead; chunks.push(chunk.subarray(0, bytesRead));
    }
    if (total > limit || identity(await handle.stat()) !== identity(before)) throw new Error('The file changed or exceeds its size limit.');
    return { bytes: Buffer.concat(chunks, total), stat: before };
  } finally { await handle.close(); }
}

function createAssetCleanup({ library, userData, trashItem, onProgress = () => {} }) {
  if (!library || typeof userData !== 'string') throw new Error('Asset cleanup needs a note library and recovery directory.');
  const sessions = new Map();
  const importWork = new Set();
  let active = null, disposed = false, trashWork = Promise.resolve();
  const session = (root) => {
    const rootKey = key(root);
    if (!sessions.has(rootKey)) sessions.set(rootKey, { sources: new Map(), bytes: 0, paths: new Set(), all: false, imports: 0, version: 0 });
    return sessions.get(rootKey);
  };
  function assertJob(job) {
    if (disposed || job.cancelled) throw cancelled();
    if (key(library.snapshot().root || '.') !== key(job.root)) throw new Error('The notes folder changed. Scan its assets again.');
  }
  function notify(job, status, extra = {}) {
    onProgress({ scanId: job.id, status, done: job.done || 0, total: job.total || 0, candidates: [], protectedCount: 0, errors: [], ...extra });
  }
  function token(snapshot) {
    return JSON.stringify([snapshot.root, snapshot.generation, snapshot.preferences, snapshot.documents.map((doc) => [doc.id, doc.path, doc.revision, doc.clientVersion])]);
  }
  async function assetDirectory(root) {
    const directory = path.join(root, 'assets');
    let stat;
    try { stat = await fs.lstat(directory); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || key(await fs.realpath(directory)) !== key(directory)) throw new Error('The assets folder must be a regular folder inside the selected notes folder.');
    return { directory, identity: directoryIdentity(stat) };
  }
  async function recoveryFiles(snapshot, job) {
    const files = [];
    for (const [folder, category] of [['drafts', 'live'], ['snapshots', 'backup']]) {
      const directory = path.join(snapshot.recoveryRoot, folder);
      let entries;
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery data is not a regular folder.');
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const entry of entries) {
        assertJob(job);
        if (entry.name.startsWith('.') || !entry.name.endsWith('.json')) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Recovery data contains an invalid record.');
        files.push({ file: path.join(directory, entry.name), category });
      }
    }
    return files;
  }
  async function scanRecoveryRecord(snapshot, record, collectDocument) {
    const { bytes, stat } = await regularBytes(record.file, MAX_RECOVERY_BYTES);
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (![1, 2].includes(data.version) || typeof data.path !== 'string' || !data.path.isWellFormed() || data.path.includes('\0') || !path.isAbsolute(data.path)
      || !documentFormat(data.path) || (data.libraryRoot !== undefined && key(data.libraryRoot) !== key(snapshot.root))) throw new Error('A recovery record could not be checked.');
    const sources = [data.source, data.baseSource, data.buffer, data.disk?.source].filter((source) => source !== undefined);
    if (!sources.length || sources.some((source) => !validSource(source))) throw new Error('A recovery record has invalid source text.');
    for (const source of new Set(sources)) await collectDocument({ path: data.path, source, format: documentFormat(data.path, snapshot.preferences.txtSyntax), category: record.category });
    return { path: record.file, identity: identity(stat) };
  }
  async function recoveryInventory(recoveryRoot) {
    const result = [];
    for (const folder of ['drafts', 'snapshots']) {
      const directory = path.join(recoveryRoot, folder);
      try {
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Recovery data is not a regular folder.');
        const names = (await fs.readdir(directory)).filter((name) => !name.startsWith('.') && name.endsWith('.json')).sort();
        result.push([folder, directoryIdentity(stat), names]);
      } catch (error) { if (error.code === 'ENOENT') result.push([folder, null, []]); else throw error; }
    }
    return JSON.stringify(result);
  }
  async function verifySignatures(signatures, job) {
    for (const record of signatures) {
      assertJob(job);
      const stat = await fs.lstat(record.path);
      if (record.kind === 'link') {
        if (!stat.isSymbolicLink() || identity(stat) !== record.identity || await fs.readlink(record.path) !== record.target) throw new Error('A linked path changed. Scan assets again.');
      } else if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== record.identity) throw new Error('Notes or recovery data changed. Scan assets again.');
    }
  }
  async function collect(job, emit = true) {
    assertJob(job);
    const snapshot = await library.cleanupSnapshot();
    assertJob(job);
    if (!snapshot.root || snapshot.indexing || snapshot.scanning || snapshot.errors.length) throw new Error('The library is still indexing or has unreadable notes. Resolve library errors and scan again.');
    const pins = session(snapshot.root);
    if (pins.imports) throw new Error('An image import is still in progress. Try cleanup after it finishes.');
    const pinVersion = pins.version;
    const initialToken = token(snapshot);
    const graph = await scanDirectoryGraph(snapshot.root);
    if (graph.errors.length) throw new Error(`The library scan is incomplete: ${graph.errors.map((item) => item.message).join('; ')}`);
    const location = await assetDirectory(snapshot.root);
    const candidates = [];
    if (location) {
      const entries = await fs.readdir(location.directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        assertJob(job);
        if (entry.name.startsWith('.') || !entry.isFile() || entry.isSymbolicLink() || !IMAGE.test(entry.name)) continue;
        const file = path.join(location.directory, entry.name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('An asset changed while scanning. Try again.');
        candidates.push({ id: randomUUID(), name: entry.name, path: file, size: stat.size, identity: identity(stat) });
      }
    }
    const signatures = [];
    const assetsByPath = new Map(candidates.map((asset) => [key(asset.path), asset]));
    for (const link of graph.links) {
      const stat = await fs.lstat(link);
      if (!stat.isSymbolicLink()) throw new Error('A linked path changed. Scan assets again.');
      signatures.push({ path: link, identity: identity(stat), kind: 'link', target: await fs.readlink(link) });
      const linkedAsset = assetsByPath.get(key(await fs.realpath(link)));
      if (linkedAsset) (linkedAsset.aliases ??= []).push(path.basename(link));
    }
    const recoveryListing = await recoveryInventory(snapshot.recoveryRoot);
    const recovery = await recoveryFiles(snapshot, job);
    const live = new Set(), backup = new Set(), protectedIds = new Set();
    for (const asset of candidates) if (pins.all || pins.paths.has(key(asset.path))) protectedIds.add(asset.id);
    job.done = 0; job.total = graph.files.size + snapshot.documents.length + recovery.length + pins.sources.size;
    const seen = new Set();
    const worker = new ReferenceWorker(candidates); job.worker = worker;
    const collectDocument = async (document) => {
      assertJob(job);
      const fingerprint = `${document.path}\0${document.format}\0${document.category}\0${digest(document.source)}`;
      if (seen.has(fingerprint)) return;
      seen.add(fingerprint);
      const ids = await worker.collect(document);
      const target = document.category === 'backup' ? backup : document.category === 'undo' ? protectedIds : live;
      for (const id of ids) target.add(id);
    };
    const nextRecord = () => {
      job.done++;
      if (emit && (job.done % 10 === 0 || job.done === job.total)) notify(job, 'scanning');
    };
    try {
      // Read, analyze, and release one file at a time. A long recovery history
      // must not retain its full source corpus in Electron's main process.
      for (const descriptor of graph.files.values()) {
        assertJob(job);
        await assertGraphLocation(graph, descriptor.path, descriptor.directoryIdentity);
        const before = await fs.lstat(descriptor.path);
        const disk = await readDisk(descriptor.path);
        const stat = await fs.lstat(descriptor.path);
        if (identity(before) !== identity(stat)) throw new Error('A note changed while it was read. Scan assets again.');
        await collectDocument({ path: descriptor.path, source: disk.source, format: documentFormat(descriptor.path, snapshot.preferences.txtSyntax), category: 'live' });
        signatures.push({ path: descriptor.path, identity: identity(stat) }); nextRecord();
      }
      for (const doc of snapshot.documents) {
        await collectDocument({ path: doc.path, source: doc.source, format: doc.format, category: 'live' });
        if (typeof doc.baseSource === 'string') await collectDocument({ path: doc.path, source: doc.baseSource, format: doc.format, category: 'live' });
        nextRecord();
      }
      for (const record of recovery) { signatures.push(await scanRecoveryRecord(snapshot, record, collectDocument)); nextRecord(); }
      for (const doc of pins.sources.values()) { await collectDocument({ ...doc, category: 'undo' }); nextRecord(); }
    } finally { await worker.close(); if (job.worker === worker) job.worker = null; }
    assertJob(job);
    if (pins.version !== pinVersion || token(await library.cleanupSnapshot()) !== initialToken) throw new Error('The library changed during the scan. Try again.');
    await verifySignatures(signatures, job);
    const finalGraph = await scanDirectoryGraph(snapshot.root);
    if (finalGraph.errors.length || JSON.stringify([...finalGraph.files.keys()].sort()) !== JSON.stringify([...graph.files.keys()].sort())
      || graphSignature(finalGraph) !== graphSignature(graph)) throw new Error('The library changed during the scan. Try again.');
    const finalLocation = await assetDirectory(snapshot.root);
    if (finalLocation?.identity !== location?.identity) throw new Error('The assets folder changed during the scan. Try again.');
    for (const asset of candidates) {
      const stat = await fs.lstat(asset.path);
      if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== asset.identity) throw new Error('An asset changed during the scan. Try again.');
    }
    if (await recoveryInventory(snapshot.recoveryRoot) !== recoveryListing) throw new Error('Recovery data changed during the scan. Try again.');
    const result = candidates.filter((asset) => !live.has(asset.id) && !protectedIds.has(asset.id))
      .map((asset) => ({ ...asset, category: backup.has(asset.id) ? 'backup' : 'unused' }));
    return { candidates: result, protectedCount: protectedIds.size, signatures, token: initialToken, pinVersion, location, graph, recoveryRoot: snapshot.recoveryRoot, recoveryListing };
  }
  function exposed(result) { return result.candidates.map(({ id, name, size, category }) => ({ id, name, size, category })); }
  function requireScan(id) {
    if (!active || active.id !== id || active.cancelled || active.status !== 'complete') throw new Error('This cleanup review is no longer current. Scan assets again.');
    assertJob(active); return active;
  }
  const controller = {
    start() {
      if (disposed || !library.snapshot().root) throw new Error('Choose a notes folder before scanning assets.');
      if (active) controller.cancel(active.id);
      const job = active = { id: randomUUID(), root: library.snapshot().root, status: 'scanning', cancelled: false, worker: null };
      job.promise = Promise.resolve().then(async () => {
        try {
          notify(job, 'scanning');
          job.result = await collect(job);
          assertJob(job); job.status = 'complete';
          notify(job, 'complete', { candidates: exposed(job.result), protectedCount: job.result.protectedCount });
        } catch (error) {
          job.status = error.code === 'NVSHIFT_SCAN_CANCELLED' ? 'cancelled' : 'error';
          notify(job, job.status, { errors: job.status === 'error' ? [error.message] : [] });
        }
      });
      return { scanId: job.id };
    },
    cancel(id) {
      if (!active || active.id !== id) return;
      active.cancelled = true; active.status = 'cancelled'; void active.worker?.close();
    },
    async protectHistory(id, source) {
      const root = library.snapshot().root;
      const doc = library.get(id);
      if (!root || !doc || !validSource(source)) {
        if (root) { const pins = session(root); pins.all = true; pins.version++; }
        throw new Error('Undo image references could not be protected. Restart nvShift before cleanup.');
      }
      const pins = session(root);
      if (pins.all) return;
      // .txt history may contain plain paths even when its current detection or
      // override selects markup. Retain it for the collector's syntax union.
      if (!/\.txt$/i.test(doc.path) && doc.format !== 'plain' && !/[\\/]|\.(?:png|jpe?g|gif|webp|svg)\b|\[\[|\]\(|\]:|file:/i.test(source)) return;
      const historyKey = `${path.dirname(doc.path)}\0${doc.format}\0${digest(source)}`;
      if (pins.sources.has(historyKey)) return;
      const size = Buffer.byteLength(source, 'utf8');
      pins.version++;
      if (pins.bytes + size > MAX_HISTORY_BYTES || pins.sources.size >= 10000) {
        pins.all = true; pins.sources.clear(); pins.bytes = 0; return;
      }
      pins.sources.set(historyKey, { path: doc.path, source, format: doc.format }); pins.bytes += size;
    },
    beginImport(root) {
      if (!root || disposed) throw new Error('The notes folder is unavailable.');
      const pins = session(root); pins.imports++; pins.version++;
      let resolve;
      const pending = new Promise((done) => { resolve = done; });
      importWork.add(pending);
      let finished = false;
      return () => { if (!finished) { finished = true; pins.imports--; pins.version++; importWork.delete(pending); resolve(); } };
    },
    protectImport(root, file) {
      if (key(path.dirname(file)) !== key(path.join(root, 'assets'))) throw new Error('An imported image must stay in the library assets folder.');
      const pins = session(root); pins.paths.add(key(file)); pins.version++;
    },
    async thumbnail(scanId, assetId) {
      const job = requireScan(scanId);
      const asset = job.result.candidates.find((item) => item.id === assetId);
      if (!asset) throw new Error('Choose an image from the current cleanup review.');
      const location = await assetDirectory(job.root);
      if (!location || location.identity !== job.result.location?.identity) throw new Error('The assets folder changed. Scan again.');
      const { bytes, stat } = await regularBytes(asset.path, MAX_IMAGE_BYTES);
      assertJob(job);
      if (identity(stat) !== asset.identity) throw new Error('The image changed. Scan again.');
      const mime = imageMime(asset.name, bytes);
      return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}` };
    },
    trash(scanId, ids) {
      const work = async () => {
        const job = requireScan(scanId);
        if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || new Set(ids).size !== ids.length) throw new Error('Choose one or more images from the current cleanup review.');
        if (typeof trashItem !== 'function') throw new Error('The system Trash is unavailable.');
        const selected = ids.map((id) => { const item = job.result.candidates.find((asset) => asset.id === id); if (!item) throw new Error('Unknown cleanup image. Scan assets again.'); return item; });
        const fresh = await collect(job, false);
        if (graphSignature(fresh.graph) !== graphSignature(job.result.graph)) throw new Error('The library folders changed. Review a fresh asset scan.');
        const byPath = new Map(fresh.candidates.map((asset) => [key(asset.path), asset]));
        for (const item of selected) {
          const current = byPath.get(key(item.path));
          if (!current || current.identity !== item.identity || current.category !== item.category) throw new Error('An image or its references changed. Review a fresh asset scan.');
        }
        const removed = [], failed = [];
        for (const item of selected) {
          try {
            assertJob(job);
            if (session(job.root).version !== fresh.pinVersion || token(await library.cleanupSnapshot()) !== fresh.token) throw new Error('The library changed. Scan assets again.');
            const graph = await scanDirectoryGraph(job.root);
            if (graph.errors.length || graphSignature(graph) !== graphSignature(fresh.graph)) throw new Error('The library changed. Scan assets again.');
            if (await recoveryInventory(fresh.recoveryRoot) !== fresh.recoveryListing) throw new Error('Recovery data changed. Scan assets again.');
            await verifySignatures(fresh.signatures, job);
            const location = await assetDirectory(job.root);
            if (!location || location.identity !== fresh.location?.identity) throw new Error('The assets folder changed. Scan again.');
            const stat = await fs.lstat(item.path);
            if (!stat.isFile() || stat.isSymbolicLink() || identity(stat) !== item.identity) throw new Error('The image changed. Scan again.');
            await trashItem(item.path); removed.push(item.id);
          } catch (error) { failed.push({ id: item.id, error: error.message }); }
        }
        job.result.candidates = job.result.candidates.filter((item) => !removed.includes(item.id));
        return { removed, failed };
      };
      const next = trashWork.catch(() => {}).then(work); trashWork = next.catch(() => {}); return next;
    },
    async dispose() {
      if (disposed) return; disposed = true;
      if (active) controller.cancel(active.id);
      await active?.promise;
      await trashWork;
      await Promise.all([...importWork]);
    },
  };
  return controller;
}

module.exports = { createAssetCleanup };
