// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const bytes = (value) => value < 1024 ? `${value} B` : value < 1024 * 1024
  ? `${(value / 1024).toFixed(1)} KB` : `${(value / (1024 * 1024)).toFixed(1)} MB`;

/** Review main-owned candidates; the renderer never supplies filesystem paths. */
export function createAssetCleanupUI({ api, beforeScan, onError }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $('#cleanup-dialog');
  let scanId = null, generation = 0, state = null, busy = false, starting = false;
  let waiting = [], actionErrors = [];
  const selected = new Set();
  const visible = new WeakSet(), pendingThumbnails = new WeakSet();
  let observer, thumbnails = [], loading = 0;

  function selectionChanged() {
    const candidates = state?.candidates ?? [];
    const size = candidates.filter((item) => selected.has(item.id)).reduce((total, item) => total + item.size, 0);
    $('#cleanup-selected-total').textContent = `${selected.size} selected · ${bytes(size)}`;
    $('#cleanup-trash').disabled = busy || state?.status !== 'complete' || !selected.size;
    $('#cleanup-select-all').disabled = busy || state?.status !== 'complete' || !candidates.some((item) => item.category === 'unused');
  }
  function errors(messages) {
    $('#cleanup-errors').textContent = messages.filter(Boolean).join('\n');
    $('#cleanup-errors').hidden = !$('#cleanup-errors').textContent;
  }
  function loadThumbnails() {
    while (loading < 3 && thumbnails.length) {
      const { image, id, token, scan } = thumbnails.shift();
      if (token !== generation || scan !== scanId || !dialog.open || !visible.has(image)) { pendingThumbnails.delete(image); continue; }
      loading++;
      void api.assetCleanupThumbnail(scan, id).then((result) => {
        if (token !== generation || scan !== scanId || !image.isConnected || !visible.has(image)) return;
        if (typeof result?.dataUrl === 'string' && /^data:image\//.test(result.dataUrl)) { image.src = result.dataUrl; image.style.opacity = '1'; }
      }).catch(() => { /* A broken thumbnail does not prevent reviewing the file. */ })
        .finally(() => { pendingThumbnails.delete(image); loading--; loadThumbnails(); });
    }
  }
  function renderCandidates() {
    observer?.disconnect(); thumbnails = [];
    $('#cleanup-unused').replaceChildren(); $('#cleanup-backups').replaceChildren();
    const token = generation, scan = scanId;
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const image = entry.target;
        if (!entry.isIntersecting) {
          visible.delete(image); image.removeAttribute('src'); image.style.opacity = '0';
        } else {
          visible.add(image);
          if (!image.hasAttribute('src') && !pendingThumbnails.has(image)) {
            pendingThumbnails.add(image);
            thumbnails.push({ image, id: image.dataset.id, token, scan });
          }
        }
      }
      loadThumbnails();
    }, { root: $('#cleanup-list'), rootMargin: '80px' });
    for (const item of state.candidates ?? []) {
      const row = document.createElement('label');
      row.className = 'cleanup-item'; row.dataset.id = item.id; row.dataset.name = item.name; row.dataset.category = item.category;
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(item.id); checkbox.disabled = busy;
      checkbox.addEventListener('change', () => { if (checkbox.checked) selected.add(item.id); else selected.delete(item.id); selectionChanged(); });
      const picture = document.createElement('span'); picture.className = 'cleanup-picture';
      const image = document.createElement('img'); image.alt = ''; image.width = 48; image.height = 42; image.style.opacity = '0'; image.dataset.id = item.id; picture.append(image);
      const name = document.createElement('span'); name.className = 'cleanup-name'; name.textContent = item.name; name.title = item.name;
      const size = document.createElement('span'); size.className = 'cleanup-size'; size.textContent = bytes(item.size);
      row.append(checkbox, picture, name, size);
      $(item.category === 'backup' ? '#cleanup-backups' : '#cleanup-unused').append(row);
      observer.observe(image);
    }
    for (const selector of ['#cleanup-unused', '#cleanup-backups']) if (!$(selector).children.length) {
      const empty = document.createElement('p'); empty.className = 'cleanup-empty'; empty.textContent = 'No images in this group.'; $(selector).append(empty);
    }
    $('#cleanup-protected').textContent = state.protectedCount
      ? `${state.protectedCount} ${state.protectedCount === 1 ? 'image is' : 'images are'} kept for Undo or recent imports until nvShift restarts.` : '';
    $('#cleanup-protected').hidden = !state.protectedCount;
    selectionChanged();
  }
  function receive(next) {
    if (starting && !scanId) { waiting.push(next); return; }
    if (!dialog.open || next.scanId !== scanId) return;
    state = next;
    $('#cleanup-progress').dataset.status = next.status;
    $('#cleanup-progress').textContent = next.status === 'scanning'
      ? `Checking notes and recovery data…${next.total ? ` ${next.done ?? 0} / ${next.total}` : ''}`
      : next.status === 'complete' ? `${next.candidates?.length ?? 0} images available for review.`
        : next.status === 'cancelled' ? 'Scan cancelled.' : 'Scan incomplete. Nothing will be removed.';
    $('#cleanup-rescan').disabled = busy || next.status === 'scanning';
    errors([...actionErrors, ...(next.errors ?? [])]);
    if (next.status === 'complete') renderCandidates();
    else selectionChanged();
  }
  async function scan({ keepErrors = [] } = {}) {
    const token = ++generation;
    if (scanId) await api.cancelAssetCleanup(scanId).catch(() => {});
    if (token !== generation || !dialog.open) return;
    scanId = null; delete dialog.dataset.scanId; state = null; selected.clear(); waiting = []; actionErrors = keepErrors; starting = true;
    observer?.disconnect(); thumbnails = [];
    $('#cleanup-unused').replaceChildren(); $('#cleanup-backups').replaceChildren();
    $('#cleanup-protected').hidden = true;
    $('#cleanup-progress').dataset.status = 'scanning';
    $('#cleanup-progress').textContent = 'Preparing scan…';
    $('#cleanup-rescan').disabled = true; selectionChanged(); errors(keepErrors);
    try {
      await beforeScan();
      if (token !== generation || !dialog.open) return;
      const result = await api.startAssetCleanup();
      if (token !== generation || !dialog.open) { await api.cancelAssetCleanup(result.scanId); return; }
      scanId = result.scanId; dialog.dataset.scanId = scanId; starting = false;
      for (const next of waiting) receive(next);
      waiting = [];
    } catch (error) {
      if (token !== generation || !dialog.open) return;
      starting = false; state = { status: 'error' }; errors([error.message]);
      $('#cleanup-progress').dataset.status = 'error';
      $('#cleanup-progress').textContent = 'Scan incomplete. Nothing will be removed.';
      $('#cleanup-rescan').disabled = false; selectionChanged();
    }
  }
  function close() {
    generation++; starting = false; waiting = []; observer?.disconnect(); thumbnails = [];
    if (scanId) void api.cancelAssetCleanup(scanId).catch(onError);
    scanId = null; delete dialog.dataset.scanId;
    if (dialog.open) dialog.close();
  }
  $('#cleanup-close').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!busy) close(); });
  $('#cleanup-rescan').addEventListener('click', () => { void scan(); });
  $('#cleanup-select-all').addEventListener('click', () => {
    for (const item of state?.candidates ?? []) if (item.category === 'unused') selected.add(item.id);
    for (const checkbox of dialog.querySelectorAll('.cleanup-item input')) checkbox.checked = selected.has(checkbox.closest('.cleanup-item').dataset.id);
    selectionChanged();
  });
  $('#cleanup-trash').addEventListener('click', async () => {
    if (busy || !selected.size || state?.status !== 'complete') return;
    const requestedScan = scanId, requestedIds = [...selected];
    busy = true; $('#cleanup-close').disabled = true; $('#cleanup-rescan').disabled = true; selectionChanged();
    for (const checkbox of dialog.querySelectorAll('.cleanup-item input')) checkbox.disabled = true;
    try {
      await beforeScan();
      const result = await api.trashUnusedAssets(requestedScan, requestedIds);
      busy = false;
      await scan({ keepErrors: (result.failed ?? []).map((item) => item.error) });
    } catch (error) {
      busy = false; selected.clear(); errors([error.message]);
      for (const checkbox of dialog.querySelectorAll('.cleanup-item input')) checkbox.checked = false;
      state = { ...state, status: 'error' }; $('#cleanup-progress').dataset.status = 'error';
      $('#cleanup-progress').textContent = 'Results changed. Scan again before removing images.';
      $('#cleanup-rescan').disabled = false; selectionChanged();
    } finally { busy = false; $('#cleanup-close').disabled = false; selectionChanged(); }
  });
  api.onAssetCleanup(receive);
  return { open() { if (busy || dialog.open) return; dialog.showModal(); void scan(); }, close };
}
