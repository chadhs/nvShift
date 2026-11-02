// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { createHash } = require('node:crypto');
const { createImageReader } = require('./images.cjs');
const { documentResource, cancelAnalysis } = require('./resource-index.cjs');

/** Resource capabilities are scoped to one main-owned editor buffer revision. */
function createResources(library, diagrams, { visibleIds = () => [library.active()?.id] } = {}) {
  const snapshots = new Map(), readers = new Map(), rendered = new Map(), pending = new Map();
  let cacheBytes = 0, disposed = false;
  const visible = () => new Set(visibleIds() || []);
  function invalidate(id) {
    const previous = snapshots.get(id);
    if (previous) { cancelAnalysis(previous); snapshots.delete(id); }
    readers.get(id)?.read.cancel();
    readers.delete(id);
  }
  function syncVisibility() {
    const ids = visible();
    for (const id of new Set([...snapshots.keys(), ...readers.keys()])) if (!ids.has(id)) invalidate(id);
  }
  function current(id, revision) {
    if (disposed) throw new Error('The note changed.');
    syncVisibility();
    const next = library.get(id);
    if (!next || next.revision !== revision || !visible().has(id)) throw new Error('The note changed.');
    // Library snapshots are detached objects. Reuse one immutable object per
    // buffer revision so image/diagram/link authorization shares its analysis.
    if (snapshots.get(id)?.revision !== revision) { invalidate(id); snapshots.set(id, Object.freeze(next)); }
    return snapshots.get(id);
  }
  function isCurrent(doc) {
    return !disposed && snapshots.get(doc.id) === doc && visible().has(doc.id) && library.get(doc.id)?.revision === doc.revision;
  }
  function assertCurrent(doc) { if (!isCurrent(doc)) throw new Error('The note changed.'); }
  function reader(doc) {
    let item = readers.get(doc.id);
    if (item?.doc !== doc) {
      item?.read.cancel();
      item = { doc, read: createImageReader(doc) };
      readers.set(doc.id, item);
    }
    return item;
  }
  function changed(doc) {
    syncVisibility();
    if (doc?.id && snapshots.get(doc.id)?.revision !== doc.revision) invalidate(doc.id);
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
    changed, syncVisibility,
    async image(id, revision, reference) {
      try {
        const item = reader(current(id, revision));
        const result = await item.read(reference);
        assertCurrent(item.doc);
        return result;
      } catch (error) { return { error: error.message }; }
    },
    async diagram(id, revision, reference, theme) {
      try {
        if (!['light', 'dark', 'solarized-light', 'solarized-dark'].includes(theme)) throw new Error('Invalid diagram appearance.');
        const doc = current(id, revision);
        const { source } = await documentResource(doc, 'diagrams', reference);
        assertCurrent(doc);
        const key = createHash('sha256').update(theme + '\0' + source).digest('hex');
        if (rendered.has(key)) return { svg: rendered.get(key) };
        if (!pending.has(key)) {
          // Diagram jobs and cached SVGs are shared by authorized source and
          // theme, not by pane. Let a job finish for another current or future
          // recipient; each caller must still pass its own lifecycle check.
          const promise = diagrams.render(source, theme, () => !disposed).then((result) => {
            if (result.svg && !disposed) remember(key, result.svg);
            return result;
          }).finally(() => pending.delete(key));
          pending.set(key, promise);
        }
        const result = await pending.get(key);
        assertCurrent(doc);
        return result;
      } catch (error) { return { error: error.message }; }
    },
    async link(id, revision, reference) {
      const doc = current(id, revision);
      const resource = await documentResource(doc, 'links', reference);
      assertCurrent(doc);
      return resource;
    },
    dispose() {
      disposed = true;
      for (const id of [...snapshots.keys()]) invalidate(id);
      snapshots.clear(); readers.clear(); rendered.clear(); pending.clear(); diagrams.cancel();
    },
  };
}
module.exports = { createResources };
