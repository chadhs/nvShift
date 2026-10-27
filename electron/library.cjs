// SPDX-License-Identifier: BSD-3-Clause
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { pathToFileURL } = require('node:url');
const { scanDirectoryGraph, assertGraphLocation } = require('./directory-graph.cjs');

const MAX_BYTES = 16 * 1024 * 1024;
const EXTENSIONS = new Set(['txt', 'md', 'markdown', 'org']);
const SYNTAXES = new Set(['plain', 'markdown', 'org']);
const AUTOSAVE_MS = 500;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pathKey = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const extensionOf = (file) => path.extname(file).slice(1).toLowerCase();
const titleOf = (file) => path.basename(file).replace(/\.(?:txt|md|markdown|org)$/i, '');
const normalized = (value) => value.normalize('NFC').toLocaleLowerCase();
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
const syntaxFor = (extension, preferences) => extension === 'txt' ? preferences.txtSyntax : extension === 'org' ? 'org' : 'markdown';

function validateTitle(value, extension) {
  if (typeof value !== 'string') throw new Error('Enter a note title.');
  let title = value.trim().normalize('NFC');
  if (title.toLowerCase().endsWith(`.${extension}`)) title = title.slice(0, -extension.length - 1);
  if (!title || title.startsWith('.') || /[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(title) || /[. ]$/u.test(title)) throw new Error('Use a title without path separators, reserved characters, or a trailing dot.');
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(title)) throw new Error('This filename is reserved by Windows. Choose another title.');
  if (Buffer.byteLength(`${title}.${extension}`, 'utf8') > 255) throw new Error('The note title is too long.');
  return title;
}

function serializeSource(source, bom, newline) {
  return Buffer.from(`${bom ? '\ufeff' : ''}${source.replace(/\n/g, newline)}`, 'utf8');
}

/** Read a regular UTF-8 file without following its final symlink or unbounded growth. */
async function readDisk(file) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('The note path is not a regular file.');
  if (before.size > MAX_BYTES) throw new Error('Notes larger than 16 MiB cannot be edited.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Choose a regular UTF-8 note no larger than 16 MiB.');
    const chunks = [];
    let total = 0;
    while (total <= MAX_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    if (total > MAX_BYTES) throw new Error('Notes larger than 16 MiB cannot be edited.');
    const bytes = Buffer.concat(chunks, total);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('The note is not valid UTF-8. Its bytes have not been changed.'); }
    if (text.includes('\u0000')) throw new Error('The note contains binary data and cannot be edited.');
    const bom = text.charCodeAt(0) === 0xfeff;
    if (bom) text = text.slice(1);
    const newline = text.match(/\r\n|\n|\r/u)?.[0] ?? '\n';
    return { source: text.replace(/\r\n|\r/gu, '\n'), bom, newline, fingerprint: digest(bytes), modified: stat.mtimeMs, mode: stat.mode & 0o777, size: bytes.length };
  } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY); await handle.sync(); }
  catch (error) { if (!['EINVAL', 'EPERM', 'EACCES', 'ENOTSUP', 'EBADF', 'EISDIR'].includes(error.code)) throw error; }
  finally { await handle?.close(); }
}

/** A same-directory atomic replacement. The callback revalidates disk immediately before rename. */
async function atomicReplace(file, bytes, { mode = 0o600, beforeReplace } = {}) {
  const temporary = path.join(path.dirname(file), `.nvshift-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', mode);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    if (beforeReplace) await beforeReplace();
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

class SearchClient {
  constructor() {
    this.worker = new Worker(new URL('./search-worker.js', pathToFileURL(__filename)), { type: 'module' });
    this.requests = new Map();
    this.counter = 0;
    this.closed = false;
    this.worker.on('message', ({ requestId, result, error }) => {
      const pending = this.requests.get(requestId);
      if (!pending) return;
      this.requests.delete(requestId);
      if (error) pending.reject(new Error(error)); else pending.resolve(result);
    });
    this.worker.on('error', (error) => this.fail(error));
    this.worker.on('exit', (code) => { if (!this.closed) this.fail(new Error(`The search worker stopped (${code}).`)); });
  }
  fail(error) { this.failure = error; for (const pending of this.requests.values()) pending.reject(error); this.requests.clear(); }
  call(method, ...args) {
    if (this.closed) return Promise.reject(new Error('The search index is closed.'));
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const requestId = ++this.counter;
      this.requests.set(requestId, { resolve, reject });
      this.worker.postMessage({ requestId, method, args });
    });
  }
  async close() {
    this.closed = true;
    this.fail(new Error('The search index is closed.'));
    await this.worker.terminate();
  }
}

/**
 * A main-process note library. Callback snapshots are detached from mutable state.
 * @param {{userData:string,onDocument?:Function,onLibrary?:Function,onError?:Function,trashItem?:Function,writeAtomic?:Function}} options
 */
function createLibrary({ userData, onDocument = () => {}, onLibrary = () => {}, onError = () => {}, trashItem, writeAtomic = atomicReplace }) {
  if (typeof userData !== 'string') throw new Error('A recovery-data directory is required.');
  let root = null;
  const watchers = new Map();
  let graph = null;
  let visibleAncestors = new Set();
  let scanning = false;
  let topologyTimer = null;
  let topologyQueue = Promise.resolve();
  let index = null;
  let activeId = null;
  let indexing = false;
  let disposed = false;
  let generation = 0;
  let preferences = { defaultExtension: 'md', txtSyntax: 'plain' };
  const records = new Map();
  const paths = new Map();
  const retired = new Map();
  let retiredActiveId = null;
  const problems = new Map();
  const pendingPaths = new Map();
  const topologyProblems = new Set();
  const watcherTasks = new Set();
  const fileTimers = new Map();
  const reservedNames = new Set();
  const snapshot = () => ({ root, count: records.size, indexing, errors: [...problems.values()].slice(0, 50) });
  const document = (record) => record ? ({ id: record.id, path: record.path, name: record.name, title: record.title, relativePath: record.relativePath, extension: record.extension, format: record.format, source: record.source, revision: record.revision, clientVersion: record.clientVersion, diskFingerprint: record.diskFingerprint, status: record.status, modified: record.modified, ...(record.error ? { error: record.error } : {}) }) : null;
  const emitLibrary = () => onLibrary(snapshot());
  const emitDocument = (record) => onDocument(document(record));
  const errorMessage = (file, error) => `${root ? path.relative(root, file) : path.basename(file)}: ${error.message}`;
  const report = (file, error) => { problems.set(file, errorMessage(file, error)); onError(errorMessage(file, error)); emitLibrary(); };
  const recoveryRoot = () => path.join(userData, 'recovery', digest(root).slice(0, 24));
  const draftPath = (record) => path.join(recoveryRoot(), 'drafts', `${record.id}.json`);
  const dirty = (record) => record.source !== record.baseSource;
  const requireRecord = (id) => { const record = records.get(id); if (!record) throw new Error('This note is no longer in the selected folder.'); return record; };
  const enqueue = (record, operation) => {
    const next = record.queue.then(operation);
    record.queue = next.catch(() => {});
    return next;
  };
  const descriptorFor = (file) => {
    const directory = graph?.directories.get(pathKey(path.dirname(file)));
    return directory ? { path: file, logicalPath: path.join(directory.logicalPath, path.basename(file)), directoryIdentity: directory.identity } : null;
  };
  const recordPath = (record, file, descriptor = descriptorFor(file)) => {
    record.path = file; record.name = path.basename(file); record.title = titleOf(file);
    record.logicalPath = descriptor?.logicalPath ?? record.logicalPath ?? file;
    record.relativePath = path.relative(root, record.logicalPath).split(path.sep).join('/');
    record.extension = extensionOf(file); record.format = syntaxFor(record.extension, preferences);
  };
  const makeRecord = (file, disk, id, descriptor = descriptorFor(file)) => {
    const record = { id: id ?? digest(`${root}\0${path.relative(root, file)}`).slice(0, 32), source: disk.source, baseSource: disk.source, bom: disk.bom, newline: disk.newline, mode: disk.mode ?? 0o600, diskFingerprint: disk.fingerprint, modified: disk.modified ?? Date.now(), revision: 1, externalRevision: 0, clientVersion: 0, status: 'saved', error: '', queue: Promise.resolve(), timer: null, missing: false };
    record.directoryIdentity = descriptor?.directoryIdentity;
    recordPath(record, file, descriptor);
    return record;
  };
  const addRecord = (record) => {
    const previous = retired.get(record.id);
    if (previous) {
      record.revision = Math.max(record.revision, previous.revision + 1);
      record.externalRevision = record.revision;
      record.clientVersion = Math.max(record.clientVersion, previous.clientVersion);
      retired.delete(record.id);
    }
    records.set(record.id, record); paths.set(pathKey(record.path), record.id);
  };
  const removeRecord = async (record, retain = true) => {
    if (retain) {
      retired.set(record.id, record);
      if (activeId === record.id) retiredActiveId = record.id;
      let bytes = [...retired.values()].reduce((total, item) => total + Buffer.byteLength(item.source, 'utf8'), 0);
      for (const [id, item] of retired) {
        if (retired.size <= 32 && bytes <= 32 * 1024 * 1024) break;
        if (id === retiredActiveId) continue;
        bytes -= Buffer.byteLength(item.source, 'utf8'); retired.delete(id);
      }
    } else retired.delete(record.id);
    clearTimeout(record.timer); records.delete(record.id); paths.delete(pathKey(record.path));
    await index.call('remove', record.id);
    if (activeId === record.id && !records.has(record.id)) { activeId = null; emitDocument(null); }
    emitLibrary();
  };
  const updateIndex = (record) => index.call('upsert', document(record));

  async function writeDraft(record) {
    const file = draftPath(record);
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const recovery = { version: 2, libraryRoot: root, id: record.id, path: record.path, logicalPath: record.logicalPath, directoryIdentity: record.directoryIdentity ?? null, source: record.source, baseSource: record.baseSource, baseFingerprint: record.diskFingerprint, bom: record.bom, newline: record.newline, mode: record.mode, modified: record.modified, revision: record.revision, clientVersion: record.clientVersion, conflict: record.status === 'conflict', error: record.error, savedAt: Date.now() };
    await atomicReplace(file, Buffer.from(JSON.stringify(recovery)), { mode: 0o600 });
  }
  async function clearDraft(record) { await fs.unlink(draftPath(record)).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  async function archive(record, disk, reason) {
    const directory = path.join(recoveryRoot(), 'snapshots');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const name = `${record.id}-${Date.now()}-${randomUUID()}.json`;
    const value = { version: 2, reason, path: record.path, logicalPath: record.logicalPath, directoryIdentity: record.directoryIdentity ?? null, savedAt: Date.now(), buffer: record.source, bom: record.bom, newline: record.newline, baseFingerprint: record.diskFingerprint, disk: disk ? { source: disk.source, bom: disk.bom, newline: disk.newline, fingerprint: disk.fingerprint } : null };
    await atomicReplace(path.join(directory, name), Buffer.from(JSON.stringify(value)), { mode: 0o600 });
    const previous = (await fs.readdir(directory)).filter((file) => file.startsWith(`${record.id}-`)).sort().reverse();
    await Promise.all(previous.slice(20).map((file) => fs.unlink(path.join(directory, file))));
  }
  async function conflict(record, message, disk) {
    clearTimeout(record.timer); record.timer = null;
    record.status = 'conflict'; record.error = message; record.missing = !disk;
    await writeDraft(record);
    emitDocument(record); emitLibrary();
    return document(record);
  }
  async function saveRecord(record) {
    clearTimeout(record.timer); record.timer = null;
    if (record.status === 'conflict') return document(record);
    if (!dirty(record)) {
      if (record.status !== 'error') { record.status = 'saved'; record.error = ''; }
      await clearDraft(record); emitDocument(record);
      return document(record);
    }
    try {
      await writeDraft(record);
      await assertSafePath(record.path, record.directoryIdentity);
      let disk;
      try { disk = await readDisk(record.path); }
      catch (error) {
        if (error.code === 'ENOENT') return await conflict(record, 'The note was deleted outside nvShift. Your draft is preserved.', null);
        throw error;
      }
      if (disk.fingerprint !== record.diskFingerprint) return await conflict(record, 'The note changed outside nvShift. Choose Keep both or Use disk.', disk);
      await archive(record, disk, 'before-save');
      record.status = 'saving'; record.error = ''; emitDocument(record);
      const source = record.source;
      await writeAtomic(record.path, serializeSource(source, record.bom, record.newline), {
        mode: record.mode,
        beforeReplace: async () => {
          await assertSafePath(record.path, record.directoryIdentity);
          let latest;
          try { latest = await readDisk(record.path); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!latest || latest.fingerprint !== record.diskFingerprint) {
            const error = new Error('The note changed during saving. Both versions are preserved.');
            error.diskConflict = true; error.disk = latest; throw error;
          }
        },
      });
      const saved = await readDisk(record.path);
      const expected = digest(serializeSource(source, record.bom, record.newline));
      if (saved.fingerprint !== expected) return await conflict(record, 'Another application changed the note immediately after saving. Your draft is preserved.', saved);
      record.diskFingerprint = saved.fingerprint; record.baseSource = source; record.modified = saved.modified;
      record.status = 'saved'; record.error = ''; record.missing = false;
      await clearDraft(record); await updateIndex(record);
      emitDocument(record); emitLibrary();
      return document(record);
    } catch (error) {
      if (error.diskConflict || error.code === 'NVSHIFT_LOCATION_CHANGED') return conflict(record, error.message, error.disk);
      record.status = 'error'; record.error = `Save failed: ${error.message}`;
      await writeDraft(record).catch(() => {});
      emitDocument(record); onError(record.error);
      throw error;
    }
  }
  function scheduleSave(record) {
    clearTimeout(record.timer);
    if (record.status === 'conflict' || !dirty(record)) return;
    record.timer = setTimeout(() => { record.timer = null; void enqueue(record, () => saveRecord(record)).catch(() => {}); }, AUTOSAVE_MS);
  }
  const assertSafePath = (file, identity) => assertGraphLocation(graph, file, identity);
  async function collision(directory, name, ignorePath) {
    const wanted = normalized(name);
    for (const entry of await fs.readdir(directory)) {
      if (normalized(entry) !== wanted) continue;
      if (ignorePath && path.join(directory, entry) === ignorePath) continue;
      throw new Error('A file with this name already exists. Choose another title.');
    }
  }
  async function createFile(title, extension, directory = root, source = '', encoding) {
    if (!root) throw new Error('Choose a notes folder first.');
    extension = String(extension ?? preferences.defaultExtension).replace(/^\./u, '').toLowerCase();
    if (!EXTENSIONS.has(extension)) throw new Error('Choose .md, .markdown, .org, or .txt.');
    title = validateTitle(title, extension);
    const file = path.join(directory, `${title}.${extension}`);
    const reservation = `${pathKey(directory)}\0${normalized(path.basename(file))}`;
    if (reservedNames.has(reservation)) throw new Error('A file with this name already exists. Choose another title.');
    reservedNames.add(reservation);
    try {
      await assertSafePath(file); await collision(directory, path.basename(file));
      const encoded = serializeSource(source, encoding?.bom ?? false, encoding?.newline ?? '\n');
      if (encoded.length > MAX_BYTES) throw new Error('Notes must contain UTF-8 text no larger than 16 MiB.');
      const location = await assertSafePath(file);
      const handle = await fs.open(file, 'wx', 0o600);
      try { await handle.writeFile(encoded); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(directory);
      await assertSafePath(file, location.identity);
      const disk = await readDisk(file);
      const record = makeRecord(file, disk);
      addRecord(record); problems.delete(file); await updateIndex(record); emitLibrary();
      return record;
    } finally { reservedNames.delete(reservation); }
  }
  async function refreshPath(file) {
    if (!root || !EXTENSIONS.has(extensionOf(file))) return;
    const id = paths.get(pathKey(file));
    const record = id ? records.get(id) : null;
    const operation = async () => {
      if (record && (!records.has(record.id) || pathKey(record.path) !== pathKey(file))) return;
      let disk;
      try { await assertSafePath(file, record?.directoryIdentity); disk = await readDisk(file); }
      catch (error) {
        if (error.code === 'ENOENT') {
          problems.delete(file);
          if (record) {
            if (dirty(record) || record.status === 'conflict' || record.status === 'error') await conflict(record, 'The note was deleted outside nvShift. Your draft is preserved.', null);
            else await removeRecord(record);
          }
        } else {
          report(file, error);
          if (record) {
            if (dirty(record)) await conflict(record, `The disk file cannot be reloaded: ${error.message}`, null);
            else { record.status = 'error'; record.error = error.message; emitDocument(record); }
          }
        }
        return;
      }
      problems.delete(file);
      if (!record) {
        const existing = paths.get(pathKey(file));
        if (existing) return;
        const added = makeRecord(file, disk); addRecord(added); await updateIndex(added); emitLibrary();
        return;
      }
      if (!records.has(record.id)) return;
      if (record.diskFingerprint === disk.fingerprint) return;
      if (dirty(record) || record.status === 'conflict') { await conflict(record, 'The note changed outside nvShift. Choose Keep both or Use disk.', disk); return; }
      await archive(record, disk, 'external-change');
      record.source = disk.source; record.baseSource = disk.source; record.bom = disk.bom; record.newline = disk.newline; record.mode = disk.mode;
      record.diskFingerprint = disk.fingerprint; record.modified = disk.modified; record.status = 'saved'; record.error = ''; record.missing = false;
      record.revision++; record.externalRevision = record.revision;
      await updateIndex(record); emitDocument(record); emitLibrary();
    };
    return record ? enqueue(record, operation) : operation();
  }
  function installGraph(next) {
    graph = next;
    visibleAncestors = new Set();
    for (const entry of graph.directories.values()) {
      let directory = entry.path;
      while (true) {
        visibleAncestors.add(pathKey(directory));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    const old = new Map([...topologyProblems].map((file) => [file, problems.get(file)]));
    for (const file of topologyProblems) problems.delete(file);
    topologyProblems.clear();
    for (const error of graph.errors) {
      const message = errorMessage(error.path, new Error(error.message));
      topologyProblems.add(error.path); problems.set(error.path, message);
      if (old.get(error.path) !== message) onError(message);
    }
  }
  function ignoredWatchPath(file) {
    const absolute = path.resolve(file);
    if (visibleAncestors.has(pathKey(absolute))) return false;
    let ancestor = path.dirname(absolute);
    while (!graph?.directories.has(pathKey(ancestor))) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return true;
      ancestor = parent;
    }
    return path.relative(ancestor, absolute).split(path.sep).some((part) => part.startsWith('.') || part === 'assets' || part === 'node_modules');
  }
  async function closeWatchers() {
    for (const timer of fileTimers.values()) clearTimeout(timer);
    fileTimers.clear();
    const previous = [...watchers.values()]; watchers.clear();
    await Promise.all(previous.map((watcher) => watcher.close()));
  }
  async function syncWatchers(currentGeneration) {
    const { watch } = await import('chokidar');
    const desired = new Map(graph.watchRoots.map((file) => [pathKey(file), file]));
    let added = false;
    for (const [key, file] of desired) {
      if (currentGeneration !== generation || disposed) return added;
      if (watchers.has(key)) continue;
      added = true;
      const watcher = watch(file, {
        ignoreInitial: true, followSymlinks: false, atomic: 150,
        // Debounce reads ourselves: a topology scan can discover a new file
        // before Chokidar's pending-add stabilization, which suppresses unlink.
        awaitWriteFinish: false,
        ignored: ignoredWatchPath,
      });
      watchers.set(key, watcher);
      watcher.on('all', (event, changedFile) => {
        if (['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(event)) queueWatcher(changedFile, currentGeneration, event);
      });
      watcher.on('error', (error) => { if (currentGeneration === generation) report(file, error); });
      await new Promise((resolve, reject) => { watcher.once('ready', resolve); watcher.once('error', reject); });
    }
    for (const [key, watcher] of [...watchers]) if (!desired.has(key)) { watchers.delete(key); await watcher.close(); }
    return added;
  }
  function trackWatcherTask(task) {
    watcherTasks.add(task);
    void task.then(() => watcherTasks.delete(task), () => watcherTasks.delete(task));
  }
  function queueWatcher(file, currentGeneration, event = 'change') {
    if (currentGeneration !== generation || disposed) return;
    if (indexing || scanning) { pendingPaths.set(file, event); return; }
    const key = pathKey(file);
    clearTimeout(fileTimers.get(key)); fileTimers.delete(key);
    if (event === 'add' || event === 'change') {
      fileTimers.set(key, setTimeout(() => {
        fileTimers.delete(key); processWatcher(file, currentGeneration, event);
      }, 120));
    } else processWatcher(file, currentGeneration, event);
  }
  function processWatcher(file, currentGeneration, event) {
    if (currentGeneration !== generation || disposed) return;
    if (indexing || scanning) { pendingPaths.set(file, event); return; }
    const task = (async () => {
      let stat;
      try { stat = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (currentGeneration !== generation || disposed) return;
      if (event === 'addDir' || event === 'unlinkDir' || stat?.isDirectory() || stat?.isSymbolicLink()
        || graph?.links.has(pathKey(file)) || graph?.directories.has(pathKey(file))) {
        scheduleTopology(currentGeneration);
      } else if (EXTENSIONS.has(extensionOf(file)) && (descriptorFor(file) || paths.has(pathKey(file)))) await refreshPath(file);
    })().catch((error) => { if (currentGeneration === generation && !disposed) report(file, error); });
    trackWatcherTask(task);
  }
  function drainPending(currentGeneration) {
    const changes = [...pendingPaths]; pendingPaths.clear();
    for (const [file, event] of changes) queueWatcher(file, currentGeneration, event);
  }
  function scheduleTopology(currentGeneration) {
    clearTimeout(topologyTimer);
    topologyTimer = setTimeout(() => {
      topologyTimer = null;
      const task = topologyQueue.catch(() => {}).then(() => reconcileTopology(currentGeneration));
      topologyQueue = task.catch((error) => { if (currentGeneration === generation && !disposed) report(root, error); });
    }, 70);
  }
  async function scanAndWatch(currentGeneration) {
    const next = await scanDirectoryGraph(root);
    if (currentGeneration !== generation || disposed) return false;
    installGraph(next);
    if (await syncWatchers(currentGeneration)) {
      // Rescan after subscription so changes between discovery and watching are not missed.
      const subscribed = await scanDirectoryGraph(root);
      if (currentGeneration !== generation || disposed) return false;
      installGraph(subscribed); await syncWatchers(currentGeneration);
    }
    return currentGeneration === generation && !disposed;
  }
  async function reconcileTopology(currentGeneration) {
    if (currentGeneration !== generation || disposed) return;
    scanning = true;
    try {
      if (!await scanAndWatch(currentGeneration)) return;
      for (const record of [...records.values()]) {
        if (currentGeneration !== generation || disposed) return;
        await enqueue(record, async () => {
          if (!records.has(record.id)) return;
          let descriptor = graph.files.get(pathKey(record.path));
          if (!descriptor && descriptorFor(record.path)) {
            // A new file can arrive while the directory graph is being scanned.
            try {
              await assertSafePath(record.path);
              const stat = await fs.lstat(record.path);
              if (stat.isFile() && !stat.isSymbolicLink()) descriptor = descriptorFor(record.path);
            } catch { /* The location is no longer part of the library. */ }
          }
          if (!descriptor) {
            if (dirty(record) || ['conflict', 'error'].includes(record.status)) await conflict(record, 'The note or linked folder is no longer reachable. Your draft is preserved.', null);
            else await removeRecord(record);
            return;
          }
          graph.files.set(pathKey(record.path), descriptor);
          if (record.directoryIdentity !== descriptor.directoryIdentity) {
            if (dirty(record) || ['conflict', 'error'].includes(record.status)) { await conflict(record, 'The note folder changed. Your draft is preserved.', null); return; }
            await assertSafePath(record.path, descriptor.directoryIdentity);
            const disk = await readDisk(record.path);
            await archive(record, disk, 'external-folder-change');
            record.source = disk.source; record.baseSource = disk.source; record.bom = disk.bom; record.newline = disk.newline; record.mode = disk.mode;
            record.diskFingerprint = disk.fingerprint; record.modified = disk.modified; record.status = 'saved'; record.error = ''; record.missing = false;
            record.directoryIdentity = descriptor.directoryIdentity;
            record.revision++; record.externalRevision = record.revision;
            await updateIndex(record); emitDocument(record);
          }
          const previous = record.relativePath;
          recordPath(record, record.path, descriptor);
          if (previous !== record.relativePath) { await updateIndex(record); emitDocument(record); }
        });
      }
      for (const descriptor of graph.files.values()) {
        if (currentGeneration !== generation || disposed) return;
        if (!paths.has(pathKey(descriptor.path))) await refreshPath(descriptor.path);
      }
      emitLibrary();
    } catch (error) {
      // A failed graph scan cannot silently authorize a new target for queued edits.
      for (const record of records.values()) if (dirty(record)) await enqueue(record, () => conflict(record, error.message, null));
      throw error;
    } finally { scanning = false; if (currentGeneration === generation && !disposed) drainPending(currentGeneration); }
  }
  async function loadGraphFiles() {
    for (const descriptor of graph.files.values()) {
      try {
        await assertSafePath(descriptor.path, descriptor.directoryIdentity);
        addRecord(makeRecord(descriptor.path, await readDisk(descriptor.path), undefined, descriptor));
      } catch (error) { report(descriptor.logicalPath, error); }
    }
  }
  async function restoreDrafts() {
    const directory = path.join(recoveryRoot(), 'drafts');
    let files;
    try { files = await fs.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of files) {
      if (!/^[a-zA-Z0-9-]+\.json$/u.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * 16) throw new Error('Invalid recovery record.');
        const recovery = JSON.parse(await fs.readFile(file, 'utf8'));
        const validPath = typeof recovery.path === 'string' && path.isAbsolute(recovery.path) && !recovery.path.includes('\0');
        const legacy = recovery.version === 1;
        const linked = recovery.version === 2 && typeof recovery.logicalPath === 'string' && inside(root, recovery.logicalPath)
          && (typeof recovery.directoryIdentity === 'string' || recovery.directoryIdentity === null);
        if ((!legacy && !linked) || recovery.libraryRoot !== root || !validPath || (legacy && !inside(root, recovery.path)) || !EXTENSIONS.has(extensionOf(recovery.path)) || typeof recovery.source !== 'string' || !recovery.source.isWellFormed() || recovery.source.includes('\u0000') || Buffer.byteLength(recovery.source, 'utf8') > MAX_BYTES || !/^[a-zA-Z0-9-]+$/u.test(recovery.id)) throw new Error('Invalid recovery record.');
        const descriptor = graph.files.get(pathKey(recovery.path));
        let record = records.get(paths.get(pathKey(recovery.path)));
        const sameLocation = legacy || (descriptor && descriptor.directoryIdentity === recovery.directoryIdentity);
        if (record?.source === recovery.source && !recovery.conflict && sameLocation) { await fs.unlink(file); continue; }
        if (!record) {
          const location = descriptor ?? { logicalPath: recovery.logicalPath ?? recovery.path, directoryIdentity: recovery.directoryIdentity ?? descriptorFor(recovery.path)?.directoryIdentity };
          record = makeRecord(recovery.path, { source: recovery.baseSource ?? '', bom: recovery.bom === true, newline: ['\n', '\r\n', '\r'].includes(recovery.newline) ? recovery.newline : '\n', fingerprint: recovery.baseFingerprint, modified: recovery.modified, mode: recovery.mode }, recovery.id, location);
          record.missing = true; addRecord(record);
        } else if (record.id !== recovery.id) {
          records.delete(record.id); record.id = recovery.id; records.set(record.id, record); paths.set(pathKey(record.path), record.id);
        }
        const sameDisk = !record.missing && sameLocation && record.diskFingerprint === recovery.baseFingerprint;
        if (!legacy) record.directoryIdentity = recovery.directoryIdentity ?? undefined;
        record.source = recovery.source; record.clientVersion = Number.isSafeInteger(recovery.clientVersion) ? recovery.clientVersion : 0;
        record.revision = Math.max(record.revision, Number.isSafeInteger(recovery.revision) ? recovery.revision + 1 : 1);
        record.status = sameDisk && !recovery.conflict ? 'dirty' : 'conflict';
        record.error = record.status === 'conflict' ? 'A recovered draft differs from the disk file. Choose Keep both or Use disk.' : '';
        activeId ??= record.id;
        await writeDraft(record);
        if (record.status === 'dirty') scheduleSave(record);
      } catch (error) { report(file, new Error(`Recovery could not be loaded: ${error.message}`)); }
    }
  }

  const controller = {
    snapshot,
    // Cleanup receives detached, main-owned buffers, including notes which no
    // longer exist on disk but still have a recoverable conflicting draft.
    async cleanupSnapshot() {
      await topologyQueue;
      await Promise.all([...watcherTasks]);
      await Promise.all([...records.values()].map((record) => record.queue));
      return {
        root, generation, indexing, scanning, errors: [...problems.values()],
        preferences: { ...preferences }, recoveryRoot: root ? recoveryRoot() : null,
        documents: [...records.values()].map((record) => ({ ...document(record), baseSource: record.baseSource })),
      };
    },
    active: () => document(records.get(activeId)),
    get: (id) => document(records.get(id)),
    getByPath: (file) => document(records.get(paths.get(pathKey(file)))),
    async resolveIndexedPath(file) {
      try {
        const canonical = await fs.realpath(file);
        const record = records.get(paths.get(pathKey(canonical)));
        if (!record) return null;
        await assertSafePath(record.path, record.directoryIdentity);
        return document(record);
      } catch (error) {
        if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'NVSHIFT_LOCATION_CHANGED'].includes(error.code)) return null;
        throw error;
      }
    },
    async assertWritable(id) {
      const record = requireRecord(id);
      await assertSafePath(record.path, record.directoryIdentity);
      return document(record);
    },
    async open(selectedRoot, selectedPreferences = {}) {
      if (disposed) throw new Error('The note library has been closed.');
      if (typeof selectedRoot !== 'string' || !path.isAbsolute(selectedRoot)) throw new Error('Choose a local notes folder.');
      const canonical = await fs.realpath(selectedRoot);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) throw new Error('Choose a notes folder, not a file.');
      await controller.flush();
      generation++;
      clearTimeout(topologyTimer); topologyTimer = null;
      await closeWatchers();
      await Promise.all([...watcherTasks]);
      await topologyQueue; topologyQueue = Promise.resolve();
      await index?.close(); index = null;
      root = canonical; records.clear(); paths.clear(); retired.clear(); retiredActiveId = null; problems.clear(); pendingPaths.clear(); topologyProblems.clear(); activeId = null;
      preferences = { defaultExtension: EXTENSIONS.has(selectedPreferences.defaultExtension) ? selectedPreferences.defaultExtension : 'md', txtSyntax: SYNTAXES.has(selectedPreferences.txtSyntax) ? selectedPreferences.txtSyntax : 'plain' };
      index = new SearchClient(); indexing = true; emitLibrary();
      const currentGeneration = generation;
      try {
        await scanAndWatch(currentGeneration);
        await loadGraphFiles(); await restoreDrafts();
        await index.call('replaceAll', [...records.values()].map(document));
        indexing = false;
        drainPending(currentGeneration);
        await Promise.all([...watcherTasks]);
        activeId ??= [...records.values()].sort((a, b) => b.modified - a.modified)[0]?.id ?? null;
        emitLibrary(); emitDocument(records.get(activeId));
        return snapshot();
      } catch (error) {
        indexing = false; emitLibrary(); await closeWatchers();
        await index?.close(); index = null; throw error;
      }
    },
    async search(query) { return index ? index.call('search', query) : { results: [], total: 0, query: String(query ?? '') }; },
    async create(title, extension) {
      await controller.flush();
      const record = await createFile(title, extension); activeId = record.id; emitDocument(record);
      return document(record);
    },
    async activate(id) {
      const previous = records.get(activeId);
      if (previous && previous.id !== id) await enqueue(previous, () => saveRecord(previous));
      const record = requireRecord(id); activeId = record.id; emitDocument(record);
      return document(record);
    },
    async updateBuffer(id, source, clientVersion, baseRevision) {
      if (typeof source !== 'string' || !source.isWellFormed() || Buffer.byteLength(source, 'utf8') > MAX_BYTES || source.includes('\u0000')) throw new Error('Notes must contain UTF-8 text no larger than 16 MiB.');
      if (!Number.isSafeInteger(clientVersion) || clientVersion < 0) throw new Error('Invalid editor version.');
      let record = records.get(id);
      if (!record && retired.has(id)) {
        if (clientVersion <= retired.get(id).clientVersion) return document(retired.get(id));
        record = retired.get(id); retired.delete(id);
        record.revision++; record.externalRevision = record.revision;
        record.status = 'conflict'; record.error = 'The note or linked folder disappeared while you were typing. Your draft is preserved.';
        addRecord(record); activeId ??= record.id;
      }
      record ??= requireRecord(id);
      return enqueue(record, async () => {
        if (clientVersion <= record.clientVersion) return document(record);
        activeId ??= record.id;
        const nextSource = source.replace(/\r\n|\r/gu, '\n');
        if (serializeSource(nextSource, record.bom, record.newline).length > MAX_BYTES) throw new Error('The note exceeds 16 MiB with its original newline encoding.');
        const staleExternalBase = Number.isSafeInteger(baseRevision) && baseRevision < record.externalRevision;
        record.source = nextSource; record.clientVersion = clientVersion; record.revision++;
        if (staleExternalBase || record.status === 'conflict') {
          record.status = 'conflict'; record.error = staleExternalBase ? 'The note changed outside nvShift while you were editing. Choose Keep both or Use disk.' : record.error;
        } else { record.status = dirty(record) ? 'dirty' : 'saved'; record.error = ''; }
        try { if (dirty(record) || record.status === 'conflict') await writeDraft(record); else await clearDraft(record); }
        catch (error) { record.status = 'error'; record.error = `Recovery could not be written: ${error.message}`; emitDocument(record); throw error; }
        await updateIndex(record); scheduleSave(record);
        emitDocument(record); emitLibrary();
        return document(record);
      });
    },
    async save(id = activeId) { return enqueue(requireRecord(id), () => saveRecord(requireRecord(id))); },
    async rename(id, value) {
      const record = requireRecord(id);
      return enqueue(record, async () => {
        await saveRecord(record);
        if (record.status !== 'saved') throw new Error('Resolve this note’s save conflict before renaming it.');
        const title = validateTitle(value, record.extension);
        const oldPath = record.path;
        const file = path.join(path.dirname(oldPath), `${title}.${record.extension}`);
        if (file === oldPath) return document(record);
        await assertSafePath(file, record.directoryIdentity); await collision(path.dirname(file), path.basename(file), oldPath);
        await assertSafePath(oldPath, record.directoryIdentity);
        const disk = await readDisk(oldPath);
        if (disk.fingerprint !== record.diskFingerprint) { await conflict(record, 'The note changed before renaming. Choose Keep both or Use disk.', disk); throw new Error(record.error); }
        await archive(record, disk, 'before-rename');
        await assertSafePath(oldPath, record.directoryIdentity);
        // link/unlink is intentionally used instead of an overwrite-capable rename.
        try { await fs.link(oldPath, file); }
        catch (error) {
          if (error.code !== 'EEXIST' || normalized(path.basename(file)) !== normalized(path.basename(oldPath))) throw error;
          const target = await fs.stat(file);
          const original = await fs.stat(oldPath);
          if (target.ino !== original.ino || target.dev !== original.dev) throw error;
          const temporary = path.join(path.dirname(file), `.nvshift-${randomUUID()}.tmp`);
          await fs.rename(oldPath, temporary);
          try { await fs.link(temporary, file); await fs.unlink(temporary); }
          catch (failure) { await fs.rename(temporary, oldPath).catch(() => {}); throw failure; }
        }
        if (await fs.lstat(oldPath).then(() => true, () => false)) {
          // On case-insensitive filesystems, the source spelling now names the destination.
          const entries = await fs.readdir(path.dirname(file));
          if (entries.includes(path.basename(oldPath))) await fs.unlink(oldPath);
        }
        paths.delete(pathKey(oldPath)); recordPath(record, file); paths.set(pathKey(file), record.id);
        record.revision++; record.modified = (await fs.stat(file)).mtimeMs;
        await updateIndex(record); emitDocument(record); emitLibrary();
        return document(record);
      });
    },
    async trash(id) {
      const record = requireRecord(id);
      return enqueue(record, async () => {
        await saveRecord(record);
        if (record.status !== 'saved') throw new Error('Resolve this note’s save conflict before moving it to Trash.');
        if (typeof trashItem !== 'function') throw new Error('The system Trash is unavailable.');
        await assertSafePath(record.path, record.directoryIdentity);
        const disk = await readDisk(record.path);
        if (disk.fingerprint !== record.diskFingerprint) { await conflict(record, 'The note changed before moving it to Trash.', disk); throw new Error(record.error); }
        await archive(record, disk, 'before-trash');
        await assertSafePath(record.path, record.directoryIdentity);
        const latest = await readDisk(record.path);
        if (latest.fingerprint !== record.diskFingerprint) { await conflict(record, 'The note changed before moving it to Trash.', latest); throw new Error(record.error); }
        await trashItem(record.path);
        await clearDraft(record); await removeRecord(record, false);
        return snapshot();
      });
    },
    async resolveConflict(id, action) {
      const record = requireRecord(id);
      return enqueue(record, async () => {
        if (record.status !== 'conflict') return document(record);
        let disk;
        try { const location = await assertSafePath(record.path, record.directoryIdentity); disk = await readDisk(record.path); record.directoryIdentity = location.identity; }
        catch (error) {
          if (error.code === 'NVSHIFT_LOCATION_CHANGED' && action === 'use-disk') {
            // Explicitly discarding the draft can accept a replacement at the
            // same canonical location, but never follow a retargeted alias.
            const descriptor = descriptorFor(record.path);
            if (descriptor) {
              try { await assertSafePath(record.path); disk = await readDisk(record.path); record.directoryIdentity = descriptor.directoryIdentity; recordPath(record, record.path, descriptor); }
              catch (readError) { if (!['ENOENT', 'NVSHIFT_LOCATION_CHANGED'].includes(readError.code)) throw readError; }
            }
          } else if (error.code !== 'ENOENT' && action !== 'keep-both') throw error;
          if (error.code !== 'ENOENT') problems.set(record.path, errorMessage(record.path, error));
        }
        await archive(record, disk, `resolve-${action}`);
        if (action === 'keep-both') {
          let directory = path.dirname(record.path);
          try { await assertSafePath(path.join(directory, 'placeholder.txt'), record.directoryIdentity); } catch { directory = root; }
          const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
          let copy;
          for (let attempt = 0; attempt < 10; attempt++) {
            try { copy = await createFile(`${record.title.slice(0, 100)} (conflict ${stamp}${attempt ? `-${attempt}` : ''})`, record.extension, directory, record.source, record); break; }
            catch (error) { if (!/already exists/u.test(error.message) && error.code !== 'EEXIST') throw error; }
          }
          if (!copy) throw new Error('A conflict copy could not be created. Your draft remains preserved.');
          await clearDraft(record);
          if (disk) {
            record.source = disk.source; record.baseSource = disk.source; record.bom = disk.bom; record.newline = disk.newline; record.mode = disk.mode;
            record.diskFingerprint = disk.fingerprint; record.modified = disk.modified; record.status = 'saved'; record.error = ''; record.missing = false; record.revision++; record.externalRevision = record.revision;
            await updateIndex(record);
          } else await removeRecord(record, false);
          activeId = copy.id; emitDocument(copy); emitLibrary();
          return document(copy);
        }
        if (action !== 'use-disk') throw new Error('Choose Keep both or Use disk.');
        await clearDraft(record);
        if (!disk) { await removeRecord(record, false); return null; }
        record.source = disk.source; record.baseSource = disk.source; record.bom = disk.bom; record.newline = disk.newline; record.mode = disk.mode;
        record.diskFingerprint = disk.fingerprint; record.modified = disk.modified; record.status = 'saved'; record.error = ''; record.missing = false; record.revision++; record.externalRevision = record.revision;
        await updateIndex(record); emitDocument(record); emitLibrary();
        return document(record);
      });
    },
    async setPreferences(patch = {}) {
      if (patch.defaultExtension !== undefined && !EXTENSIONS.has(patch.defaultExtension)) throw new Error('Invalid default note extension.');
      if (patch.txtSyntax !== undefined && !SYNTAXES.has(patch.txtSyntax)) throw new Error('Invalid .txt syntax.');
      preferences = { ...preferences, ...patch };
      const changed = [];
      for (const record of records.values()) {
        const format = syntaxFor(record.extension, preferences);
        if (record.format !== format) { record.format = format; record.revision++; emitDocument(record); changed.push(record); }
      }
      if (index) await Promise.all(changed.map(updateIndex));
      emitLibrary();
      return { ...preferences };
    },
    async flush() {
      const failures = [];
      for (const record of records.values()) {
        clearTimeout(record.timer); record.timer = null;
        try {
          await record.queue;
          if (record.status === 'conflict') await enqueue(record, () => writeDraft(record));
          else if (dirty(record)) await enqueue(record, () => saveRecord(record));
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'Some notes could not be saved. Recovery drafts have been retained.');
    },
    async dispose() {
      if (disposed) return;
      disposed = true; generation++;
      try { await controller.flush(); }
      finally {
        clearTimeout(topologyTimer); topologyTimer = null;
        await closeWatchers();
        await topologyQueue;
        await Promise.all([...watcherTasks]);
        for (const record of records.values()) clearTimeout(record.timer);
        await index?.close(); index = null;
      }
    },
  };
  return controller;
}

module.exports = { createLibrary, MAX_BYTES, validateTitle, readDisk, serializeSource, atomicReplace };
