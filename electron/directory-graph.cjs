// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');

const EXTENSIONS = new Set(['txt', 'md', 'markdown', 'org']);
const pathKey = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const directoryIdentity = (stat) => `${stat.dev}:${stat.ino}`;
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const ignored = (name) => name.startsWith('.') || name === 'assets' || name === 'node_modules';
const contains = (directory, file) => {
  const relative = path.relative(directory, file);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const samePath = (left, right) => pathKey(left) === pathKey(right);

/**
 * Discover the library's physical directory graph without expanding cycles.
 * Regular directories are visited before any link, then all linked routes use
 * one lexical priority queue. One canonical directory is read only once.
 */
async function scanDirectoryGraph(selectedRoot) {
  const selected = path.resolve(selectedRoot);
  const selectedStat = await fs.lstat(selected);
  if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()) throw changed('The selected notes folder changed or is no longer available.');
  const root = await fs.realpath(selectedRoot);
  if (!samePath(root, selected)) throw changed('The selected notes folder changed or is no longer available.');
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw changed('The selected notes folder changed or is no longer available.');
  const directories = new Map(), files = new Map(), links = new Set(), errors = [];
  const visitedPaths = new Set(), visitedIdentities = new Set();
  const regular = [{ path: root, logicalPath: root, bindings: [] }];
  const linked = [];
  const report = (file, error) => errors.push({ path: file, message: String(error.message || error) });

  async function queueLink(physical, logical, bindings) {
    links.add(pathKey(physical));
    try {
      const linkStat = await fs.lstat(physical);
      if (!linkStat.isSymbolicLink()) throw new Error('The directory link changed during discovery.');
      const target = await fs.realpath(physical);
      const targetStat = await fs.lstat(target);
      if (!targetStat.isDirectory()) return; // Individual linked files are not notes.
      linked.push({ path: target, logicalPath: logical, bindings: [...bindings, {
        path: physical, logicalPath: logical, target,
        identity: directoryIdentity(targetStat), linkIdentity: directoryIdentity(linkStat),
      }] });
    } catch (error) { report(logical, new Error(`Directory link is unavailable: ${error.message}`)); }
  }

  async function visit(candidate, queue) {
    let physical, stat, entries;
    try {
      physical = await fs.realpath(candidate.path);
      stat = await fs.lstat(physical);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The notes location is not a directory.');
      const key = pathKey(physical);
      const identity = directoryIdentity(stat);
      // Some filesystems report inode zero for every directory. In that case
      // canonical paths still deduplicate aliases without collapsing the tree.
      const visitIdentity = stat.ino === 0 ? `${identity}:${key}` : identity;
      if (visitedPaths.has(key) || visitedIdentities.has(visitIdentity)) return;
      visitedPaths.add(key); visitedIdentities.add(visitIdentity);
      entries = await fs.readdir(physical, { withFileTypes: true });
      const entry = {
        path: physical, logicalPath: candidate.logicalPath, identity,
        bindings: candidate.bindings,
      };
      directories.set(key, entry);
      entries.sort((left, right) => compare(left.name, right.name));
      for (const child of entries) {
        if (ignored(child.name)) continue;
        const file = path.join(physical, child.name);
        const logicalPath = path.join(candidate.logicalPath, child.name);
        if (child.isSymbolicLink()) await queueLink(file, logicalPath, candidate.bindings);
        else if (child.isDirectory()) queue.push({ path: file, logicalPath, bindings: candidate.bindings });
        else if (child.isFile() && EXTENSIONS.has(path.extname(child.name).slice(1).toLowerCase())) {
          files.set(pathKey(file), { path: file, logicalPath, directoryIdentity: identity });
        }
      }
    } catch (error) { report(candidate.logicalPath, error); }
  }

  while (regular.length) {
    regular.sort((left, right) => compare(left.logicalPath, right.logicalPath));
    await visit(regular.shift(), regular);
  }
  while (linked.length) {
    linked.sort((left, right) => compare(left.logicalPath, right.logicalPath));
    await visit(linked.shift(), linked);
  }
  const watchRoots = [];
  const physicalDirectories = [...directories.values()].map((entry) => entry.path)
    .sort((left, right) => left.length - right.length || compare(left, right));
  for (const directory of physicalDirectories) {
    if (!watchRoots.some((ancestor) => contains(ancestor, directory))) watchRoots.push(directory);
  }
  // Keep watching an unreadable library so later permission changes can recover.
  if (!watchRoots.length) watchRoots.push(root);
  return { root, directories, files, links, watchRoots, errors };
}

function changed(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'NVSHIFT_LOCATION_CHANGED';
  return error;
}

/**
 * Validate a pinned physical parent and its complete logical symlink route.
 * This works for an existing note or a not-yet-created sibling filename.
 */
async function assertGraphLocation(graph, file, expectedIdentity) {
  if (!graph || typeof file !== 'string' || !path.isAbsolute(file)) throw changed('The notes location is not available.');
  const parent = path.dirname(path.resolve(file));
  const entry = graph.directories.get(pathKey(parent));
  if (!entry) throw changed('The note folder is no longer reachable from this library. Your draft is preserved.');
  try {
    const physical = await fs.realpath(parent);
    const stat = await fs.lstat(parent);
    if (!samePath(physical, entry.path) || !stat.isDirectory() || stat.isSymbolicLink()
      || directoryIdentity(stat) !== entry.identity
      || (expectedIdentity !== undefined && expectedIdentity !== entry.identity)) {
      throw changed('The note folder changed. Your draft is preserved.');
    }
    for (const binding of entry.bindings ?? []) {
      const linkStat = await fs.lstat(binding.path);
      if (!linkStat.isSymbolicLink() || directoryIdentity(linkStat) !== binding.linkIdentity) throw changed('A linked notes folder changed. Your draft is preserved.');
      const target = await fs.realpath(binding.path);
      const targetStat = await fs.lstat(target);
      if (!samePath(target, binding.target) || !targetStat.isDirectory() || directoryIdentity(targetStat) !== binding.identity
        || !samePath(await fs.realpath(binding.logicalPath), binding.target)) {
        throw changed('A linked notes folder changed. Your draft is preserved.');
      }
    }
    if (!samePath(await fs.realpath(entry.logicalPath), entry.path)) throw changed('The linked notes route changed. Your draft is preserved.');
    return entry;
  } catch (error) {
    if (error.code === 'NVSHIFT_LOCATION_CHANGED') throw error;
    throw changed('The note folder is no longer available. Your draft is preserved.', error);
  }
}

module.exports = { pathKey, directoryIdentity, scanDirectoryGraph, assertGraphLocation };
