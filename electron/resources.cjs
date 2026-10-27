// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { createHash } = require('node:crypto');
const { createImageReader } = require('./images.cjs');
const { documentResource, cancelAnalysis } = require('./resource-index.cjs');

/** Resource capabilities are scoped to one main-owned editor buffer revision. */
function createResources(library, diagrams) {
  const snapshots = new Map(), readers = new Map(), rendered = new Map(), pending = new Map();
  let cacheBytes = 0, disposed = false;
  function current(id, revision) {
    const next = library.get(id);
    if (!next || next.revision !== revision || library.active()?.id !== id) throw new Error('The note changed.');
    // Library snapshots are detached objects. Reuse one immutable object per
    // buffer revision so image/diagram/link authorization shares its analysis.
    if (snapshots.get(id)?.revision !== revision) snapshots.set(id, Object.freeze(next));
    while (snapshots.size > 2) snapshots.delete(snapshots.keys().next().value);
    return snapshots.get(id);
  }
  function reader(doc) {
    let item = readers.get(doc.id);
    if (item?.doc.revision !== doc.revision) {
      item?.read.cancel();
      item = { doc, read: createImageReader(doc) };
      readers.set(doc.id, item);
      while (readers.size > 2) {
        const key = readers.keys().next().value;
        readers.get(key).read.cancel(); readers.delete(key);
      }
    }
    return item;
  }
  function changed(doc) {
    const previous = snapshots.get(doc?.id);
    let invalidated = false;
    if (previous && previous.revision !== doc?.revision) {
      snapshots.delete(doc.id); invalidated = true;
    }
    const old = readers.get(doc?.id);
    if (old && old.doc.revision !== doc.revision) {
      old.read.cancel(); readers.delete(doc.id); invalidated = true;
    }
    if (invalidated && library.active()?.id === doc.id) cancelAnalysis();
  }
  function remember(key, svg) {
    if (svg.length > 16 * 1024 * 1024) return;
    rendered.set(key, svg); cacheBytes += svg.length;
    while (rendered.size > 40 || cacheBytes > 16 * 1024 * 1024) {
      const first = rendered.keys().next().value;
      cacheBytes -= rendered.get(first).length; rendered.delete(first);
    }
  }
  return {
    changed,
    async image(id, revision, reference) {
      try {
        const item = reader(current(id, revision));
        const result = await item.read(reference);
        current(id, revision);
        return result;
      } catch (error) { return { error: error.message }; }
    },
    async diagram(id, revision, reference, theme) {
      try {
        if (!['light', 'dark', 'solarized-light', 'solarized-dark'].includes(theme)) throw new Error('Invalid diagram appearance.');
        const doc = current(id, revision);
        const { source } = await documentResource(doc, 'diagrams', reference);
        current(id, revision);
        const key = createHash('sha256').update(theme + '\0' + source).digest('hex');
        if (rendered.has(key)) return { svg: rendered.get(key) };
        if (!pending.has(key)) {
          const promise = diagrams.render(source, theme, () => !disposed).then((result) => {
            if (result.svg) remember(key, result.svg);
            return result;
          }).finally(() => pending.delete(key));
          pending.set(key, promise);
        }
        const result = await pending.get(key);
        current(id, revision);
        return result;
      } catch (error) { return { error: error.message }; }
    },
    async link(id, revision, reference) {
      const doc = current(id, revision);
      const resource = await documentResource(doc, 'links', reference);
      current(id, revision);
      return resource;
    },
    dispose() {
      disposed = true;
      for (const item of readers.values()) item.read.cancel();
      snapshots.clear(); readers.clear(); rendered.clear(); pending.clear(); cancelAnalysis(); diagrams.cancel();
    },
  };
}
module.exports = { createResources };
