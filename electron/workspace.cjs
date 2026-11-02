// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { randomUUID } = require('node:crypto');

/** Main-owned tabs and visible documents. Document contents remain library-owned. */
function createWorkspace({ library, onChange = () => {} }) {
  let groups = [], focusedGroupId = null, ratio = .5, generation = 0, revision = 0;
  let singleView = 'editor', queue = Promise.resolve(), owned = new Set();
  const removedTabs = new Map(), browseEpochs = new Map(), browseTokens = new Map();
  const modes = new Set(['editor', 'preview', 'split']);
  const tab = (documentId = null) => ({ id: randomUUID(), documentId });
  const inheritedView = (mode) => mode === 'preview' ? 'preview' : 'editor';
  const group = (viewMode = 'editor') => ({ id: randomUUID(), tabs: [], activeTabId: null, viewMode, preview: null });
  const selected = (g) => g?.tabs.find((item) => item.id === g.activeTabId);
  const displayed = (g) => g?.preview?.documentId ?? selected(g)?.documentId ?? null;
  const focused = () => groups.find((g) => g.id === focusedGroupId) ?? groups[0];
  const refs = () => new Set(groups.flatMap((g) => [...g.tabs.map((item) => item.documentId), g.preview?.documentId]).filter(Boolean));
  const find = (id) => {
    for (const g of groups) { const item = g.tabs.find((item) => item.documentId === id); if (item) return { group: g, tab: item }; }
    return null;
  };
  function snapshot() {
    return { generation, revision, layout: groups.length === 2 ? 'columns' : 'single', focusedGroupId, ratio, singleViewMode: singleView,
      groups: groups.map((g) => ({ id: g.id, activeTabId: g.activeTabId, viewMode: g.viewMode,
        displayedDocumentId: displayed(g), browsing: Boolean(g.preview), tabs: g.tabs.map((item) => ({ ...item })) })) };
  }
  const documents = () => Object.fromEntries([...refs()].map((id) => [id, library.get(id)]).filter(([, doc]) => doc));
  const active = () => { const id = displayed(focused()); return id ? library.get(id) : null; };
  const visibleIds = () => groups.map(displayed).filter(Boolean);
  const result = () => ({ workspace: snapshot(), documents: documents(), document: active() });
  const publish = () => { revision++; onChange(snapshot()); };
  function syncOpened() {
    const next = refs();
    for (const id of owned) if (!next.has(id)) library.releaseDocument(id);
    owned = next;
  }
  function stale() { const error = new Error('The notes folder or workspace changed. Try again.'); error.code = 'NVSHIFT_STALE_WORKSPACE'; return error; }
  function check(ticket) {
    if (ticket.generation !== generation || ticket.root !== library.snapshot().root) throw stale();
    if (ticket.browseGroupId && (ticket.browseEpoch !== (browseEpochs.get(ticket.browseGroupId) ?? 0)
      || (ticket.browseToken !== undefined && ticket.browseToken !== browseTokens.get(ticket.browseGroupId)))) {
      const error = new Error('Search browsing was superseded.'); error.code = 'NVSHIFT_STALE_BROWSE'; throw error;
    }
  }
  const enqueue = (operation) => {
    const next = queue.catch(() => {}).then(operation);
    queue = next;
    return next;
  };
  async function ensure(id, ticket) {
    check(ticket);
    if (typeof id !== 'string' || !library.get(id)) throw new Error('This note is no longer in the selected folder.');
    const doc = await library.openDocument(id); owned.add(id); check(ticket); return doc;
  }
  async function save(id, ticket) {
    check(ticket);
    if (!id || !library.get(id)) return;
    const doc = await library.save(id); check(ticket);
    if (!doc || doc.status !== 'saved') throw new Error(doc?.error || 'Resolve this note’s save conflict before closing or replacing it.');
  }
  async function focusLibrary(ticket) { check(ticket); await library.focusDocument(displayed(focused())); check(ticket); }
  function chooseAfterRemoval(g, index) { g.activeTabId = g.tabs[index]?.id ?? g.tabs[index - 1]?.id ?? null; }
  function compact() {
    if (groups.length === 2 && groups.some((g) => !g.tabs.length)) {
      const keep = groups.find((g) => g.tabs.length) ?? groups[0];
      groups = [keep]; focusedGroupId = keep.id; keep.viewMode = singleView;
    }
    if (!groups.some((g) => g.id === focusedGroupId)) focusedGroupId = groups[0]?.id ?? null;
  }
  async function cancelBrowse(g, ticket) {
    if (!g.preview) return;
    await save(g.preview.documentId, ticket);
    g.preview = null;
  }
  async function commitBrowse(g, ticket) {
    if (!g.preview) return;
    const current = selected(g), preview = g.preview;
    await save(current?.documentId, ticket);
    if (!current || !g.tabs.includes(current)) throw stale();
    current.documentId = preview.documentId; g.preview = null;
  }
  function target(request, capturedGroupId) {
    const g = groups.find((g) => g.id === (request.groupId ?? capturedGroupId));
    if (!g) throw stale(); return g;
  }
  async function open(request, g, ticket) {
    const { id } = request;
    const disposition = request.disposition ?? 'replace';
    if (!['replace', 'new-tab', 'browse'].includes(disposition)) throw new Error('Invalid note opening action.');
    const existing = find(id);
    if (existing) {
      await cancelBrowse(g, ticket);
      if (disposition !== 'browse') {
        await cancelBrowse(existing.group, ticket);
        existing.group.activeTabId = existing.tab.id; focusedGroupId = existing.group.id;
      }
      return;
    }
    if (disposition === 'browse') {
      if (g.preview?.documentId === id) return;
      await save(displayed(g), ticket);
      await ensure(id, ticket);
      if (!selected(g)) { const item = tab(); g.tabs.push(item); g.activeTabId = item.id; }
      g.preview = { documentId: id };
      return;
    }
    await save(displayed(g), ticket);
    await save(selected(g)?.documentId, ticket);
    await ensure(id, ticket);
    g.preview = null;
    if (disposition === 'new-tab' || !selected(g)) { const item = tab(id); g.tabs.push(item); g.activeTabId = item.id; }
    else selected(g).documentId = id;
    focusedGroupId = g.id;
  }
  async function execute(request, ticket, capturedGroupId) {
    check(ticket);
    const g = target(request, capturedGroupId);
    switch (request.type) {
      case 'open': await open(request, g, ticket); break;
      case 'commitBrowse': await commitBrowse(g, ticket); break;
      case 'cancelBrowse': await cancelBrowse(g, ticket); break;
      case 'newTab': {
        await cancelBrowse(g, ticket);
        const item = tab(); g.tabs.push(item); g.activeTabId = item.id; focusedGroupId = g.id;
        break;
      }
      case 'create': {
        await save(displayed(g), ticket); await save(selected(g)?.documentId, ticket);
        const doc = await library.create(request.title, request.extension); check(ticket); owned.add(doc.id);
        g.preview = null;
        if (!selected(g)) { const item = tab(doc.id); g.tabs.push(item); g.activeTabId = item.id; }
        else selected(g).documentId = doc.id;
        g.viewMode = 'editor'; focusedGroupId = g.id;
        break;
      }
      case 'selectTab': {
        const item = g.tabs.find((item) => item.id === request.tabId);
        if (!item) throw new Error('That tab is no longer open.');
        await cancelBrowse(g, ticket); g.activeTabId = item.id; focusedGroupId = g.id;
        break;
      }
      case 'closeTab': {
        if (request.tabId && !g.tabs.some((item) => item.id === request.tabId)) throw new Error('That tab is no longer open.');
        await commitBrowse(g, ticket);
        const index = g.tabs.findIndex((item) => item.id === (request.tabId ?? g.activeTabId));
        if (index < 0) { compact(); break; }
        const item = g.tabs[index]; await save(item.documentId, ticket);
        g.tabs.splice(index, 1); if (g.activeTabId === item.id) chooseAfterRemoval(g, index);
        compact(); break;
      }
      case 'focusGroup': focusedGroupId = g.id; break;
      case 'moveTab': {
        const index = g.tabs.findIndex((item) => item.id === (request.tabId ?? g.activeTabId));
        if (index < 0) throw new Error('That tab is no longer open.');
        const other = request.targetGroupId ? groups.find((next) => next.id === request.targetGroupId)
          : groups.find((next) => next !== g) ?? group(inheritedView(g.viewMode));
        if (!other || other === g) throw new Error('Choose the other document pane.');
        for (const next of [g, other]) if (next.preview) await save(next.preview.documentId, ticket);
        g.preview = null; other.preview = null;
        if (groups.length === 1) {
          if (g.viewMode === 'split') g.viewMode = 'editor';
          groups.push(other);
        }
        const [item] = g.tabs.splice(index, 1); chooseAfterRemoval(g, index);
        other.tabs.push(item); other.activeTabId = item.id; focusedGroupId = other.id; compact();
        break;
      }
      case 'toggleLayout': {
        for (const next of groups) if (next.preview) await save(next.preview.documentId, ticket);
        for (const next of groups) next.preview = null;
        if (groups.length === 1) {
          if (g.viewMode === 'split') g.viewMode = 'editor';
          const right = group(inheritedView(g.viewMode)); groups.push(right); focusedGroupId = right.id; ratio = .5;
        } else {
          const focusedTab = selected(focused());
          const left = groups[0]; left.tabs = groups.flatMap((next) => next.tabs); left.preview = null;
          left.activeTabId = focusedTab?.id ?? left.activeTabId ?? left.tabs[0]?.id ?? null;
          left.viewMode = singleView; groups = [left]; focusedGroupId = left.id;
        }
        break;
      }
      case 'setView':
        if (!modes.has(request.mode) || (groups.length === 2 && request.mode === 'split')) throw new Error('Choose a view available in this layout.');
        g.viewMode = request.mode; if (groups.length === 1) singleView = request.mode;
        break;
      case 'setRatio':
        if (!Number.isFinite(request.ratio) || request.ratio < .1 || request.ratio > .9) throw new Error('Invalid document divider position.');
        ratio = request.ratio; break;
      default: throw new Error('Unknown workspace command.');
    }
    check(ticket); syncOpened();
    // Search previews do not change the library's focused record until commit.
    // Keep the final preview mutation and publication synchronous so cancellation
    // cannot arrive during a focus await after the preview was already installed.
    if (!(request.type === 'open' && request.disposition === 'browse')) await focusLibrary(ticket);
    publish(); return result();
  }
  const controller = {
    snapshot, documents, active, visibleIds,
    invalidateBrowse(groupId = focusedGroupId, expectedGeneration = generation, browseToken) {
      if (expectedGeneration !== generation || !groups.some((g) => g.id === groupId)) return false;
      if (browseToken !== undefined) {
        if (typeof browseToken !== 'string' || browseToken.length > 200) return false;
        browseTokens.set(groupId, browseToken);
      }
      browseEpochs.set(groupId, (browseEpochs.get(groupId) ?? 0) + 1); return true;
    },
    command(request) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) return Promise.reject(new Error('Invalid workspace command.'));
      const capturedGroupId = request.groupId ?? focusedGroupId;
      const browsing = request.type === 'open' && request.disposition === 'browse';
      const expectedGeneration = request.generation ?? generation;
      if (!browsing && expectedGeneration === generation) {
        const ids = ['focusGroup', 'moveTab', 'toggleLayout'].includes(request.type) ? groups.map((g) => g.id) : [capturedGroupId];
        for (const id of ids) controller.invalidateBrowse(id, expectedGeneration);
      }
      if (browsing && request.browseToken !== undefined && (typeof request.browseToken !== 'string' || request.browseToken.length > 200)) return Promise.reject(new Error('Invalid search browsing token.'));
      if (browsing && request.browseToken !== undefined && !browseTokens.has(capturedGroupId)) browseTokens.set(capturedGroupId, request.browseToken);
      const ticket = { generation: expectedGeneration, root: library.snapshot().root,
        ...(browsing ? { browseGroupId: capturedGroupId, browseEpoch: browseEpochs.get(capturedGroupId) ?? 0, browseToken: request.browseToken } : {}) };
      return enqueue(() => execute({ ...request }, ticket, capturedGroupId)).catch((error) => {
        syncOpened(); if (error.code === 'NVSHIFT_STALE_BROWSE') return result(); throw error;
      });
    },
    reset({ viewMode = 'editor' } = {}) {
      const ticket = { generation: ++generation, root: library.snapshot().root };
      return enqueue(async () => {
        check(ticket); singleView = modes.has(viewMode) ? viewMode : 'editor';
        const initial = library.active();
        for (const id of owned) if (id !== initial?.id) library.releaseDocument(id);
        owned.clear(); removedTabs.clear(); browseEpochs.clear(); browseTokens.clear(); groups = [group(singleView)]; focusedGroupId = groups[0].id; ratio = .5;
        const recovered = [...(library.recoveredDocuments?.() ?? []), ...library.documents().filter((doc) => ['dirty', 'conflict', 'error'].includes(doc.status))];
        const ids = [...new Set([initial?.id, ...recovered.map((doc) => doc.id)].filter(Boolean))];
        for (const id of ids) { await ensure(id, ticket); groups[0].tabs.push(tab(id)); }
        groups[0].activeTabId = groups[0].tabs[0]?.id ?? null;
        syncOpened(); await focusLibrary(ticket); publish(); return result();
      });
    },
    restore(saved) {
      const ticket = { generation: ++generation, root: library.snapshot().root };
      return enqueue(async () => {
        check(ticket);
        if (!saved || !Array.isArray(saved.groups) || !saved.groups.length || saved.groups.length > 2) throw new Error('Invalid workspace snapshot.');
        browseEpochs.clear(); browseTokens.clear();
        singleView = modes.has(saved.singleViewMode) ? saved.singleViewMode : singleView;
        const seen = new Set();
        groups = saved.groups.map((previous) => {
          const next = group(modes.has(previous.viewMode) ? previous.viewMode : 'editor'); next.id = previous.id;
          next.tabs = previous.tabs.filter((item) => !item.documentId || (!seen.has(item.documentId) && library.get(item.documentId) && seen.add(item.documentId))).map((item) => ({ ...item }));
          next.activeTabId = next.tabs.some((item) => item.id === previous.activeTabId) ? previous.activeTabId : next.tabs[0]?.id ?? null;
          if (saved.groups.length === 2 && next.viewMode === 'split') next.viewMode = 'editor';
          return next;
        });
        focusedGroupId = groups.some((g) => g.id === saved.focusedGroupId) ? saved.focusedGroupId : groups[0].id;
        ratio = Number.isFinite(saved.ratio) ? Math.max(.1, Math.min(.9, saved.ratio)) : .5;
        for (const id of refs()) await ensure(id, ticket);
        syncOpened(); await focusLibrary(ticket); publish(); return result();
      });
    },
    flush() {
      const ticket = { generation, root: library.snapshot().root };
      return enqueue(async () => { for (const id of refs()) await save(id, ticket); });
    },
    changed(doc) {
      if (!doc) return false;
      if (refs().has(doc.id)) return true;
      const retired = removedTabs.get(doc.id);
      if (retired && ['dirty', 'conflict', 'error'].includes(doc.status)) {
        const g = groups.find((g) => g.id === retired.groupId) ?? focused();
        if (g) {
          g.tabs.push(retired.tab); g.activeTabId = retired.tab.id; focusedGroupId = g.id;
          removedTabs.delete(doc.id); owned.add(doc.id); publish();
          return true;
        }
      }
      return false;
    },
    removed(id) {
      let removed = false;
      for (const g of groups) {
        if (g.preview?.documentId === id) { removedTabs.set(id, { groupId: g.id, tab: tab(id) }); g.preview = null; removed = true; }
        const index = g.tabs.findIndex((item) => item.documentId === id);
        if (index >= 0) { const [item] = g.tabs.splice(index, 1); removedTabs.set(id, { groupId: g.id, tab: item }); if (item.id === g.activeTabId) chooseAfterRemoval(g, index); removed = true; }
      }
      if (removed) { compact(); syncOpened(); publish(); }
    },
  };
  return controller;
}
module.exports = { createWorkspace };
