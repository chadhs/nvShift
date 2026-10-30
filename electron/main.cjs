// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { app, BrowserWindow, dialog, ipcMain, Menu, shell, session, Tray, nativeImage, globalShortcut, nativeTheme } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { createSettings, validate } = require('./settings.cjs');
const { createShortcutController } = require('./shortcuts.cjs');
const { createLibrary } = require('./library.cjs');
const { createDiagramRenderer } = require('./diagrams.cjs');
const { createResources } = require('./resources.cjs');
const { insertImageBytes, insertImageFiles } = require('./assets.cjs');
const { createAssetCleanup } = require('./asset-cleanup.cjs');
const { MAX_IMAGE_BYTES } = require('./images.cjs');
const { resolveDocumentLink } = require('./links.cjs');
const { configureGraphics } = require('./graphics.cjs');
const { titlebarOptions, updateTitlebar } = require('./titlebar.cjs');

app.setName('nvShift');
app.setAppUserModelId?.('com.chadhs.nvshift');
app.setDesktopName?.('com.chadhs.nvshift.desktop');
configureGraphics(app.commandLine);
// Electron already honors --user-data-dir; an explicit test profile keeps smoke fixtures isolated.
const profileArg = process.argv.find((arg) => arg.startsWith('--user-data-dir='));
if (profileArg) app.setPath('userData', path.resolve(profileArg.slice('--user-data-dir='.length)));
else app.setPath('userData', path.join(app.getPath('appData'), 'nvShift'));
const bootRoot = process.argv.find((arg) => arg.startsWith('--library='))?.slice('--library='.length);
const iconPath = app.isPackaged ? path.join(process.resourcesPath, 'icon.png') : path.join(__dirname, '../build/icons/256x256.png');
const trayDirectory = app.isPackaged ? path.join(process.resourcesPath, 'tray') : path.join(__dirname, '../build');
const page = path.join(__dirname, '../dist/index.html');
const pageURL = pathToFileURL(page).href;
let win, tray, settings, library, resources, diagramRenderer, cleanup;
let quitting = false, quitReady = false, uiReady = false, hiding = false;
let shortcuts;
let pendingFocusSearch = false;
const flushRequests = new Map(), authorizedDrops = new Map();
const locked = app.requestSingleInstanceLock();

function trusted(event) {
  return event.sender === win?.webContents && event.senderFrame === win?.webContents.mainFrame && event.senderFrame?.url === pageURL;
}
function command(name, extra = {}) { win?.webContents.send('app:command', { command: name, ...extra }); }
function report(error) {
  const message = String(error?.message || error);
  if (win && !win.isDestroyed()) command('error', { message });
  console.error(message);
}
function state() {
  return { settings: settings.snapshot(library.snapshot().root), library: library.snapshot(), document: library.active(), shortcut: shortcuts?.snapshot() };
}
function broadcast() { if (uiReady) win?.webContents.send('app:state', state()); }
function showWindow(focusSearch = true) {
  if (!settings || !library) return;
  if (!win || win.isDestroyed()) createWindow();
  win.restore(); win.show(); win.focus();
  if (focusSearch) {
    if (uiReady) command('focus-search');
    else pendingFocusSearch = true;
  }
}
async function flushRenderer() {
  if (!win || win.isDestroyed() || !uiReady) return;
  const requestId = randomUUID();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { flushRequests.delete(requestId); reject(new Error('The editor is still busy. Please try again.')); }, 10000);
    flushRequests.set(requestId, (error) => { clearTimeout(timer); flushRequests.delete(requestId); if (error) reject(new Error(String(error).slice(0, 500))); else resolve(); });
    command('flush', { requestId });
  });
}
async function flushAll() {
  await flushRenderer();
  await library.flush();
  await settings.flush();
}
async function hideWindow() {
  if (hiding || quitting) return;
  hiding = true;
  try { await flushAll(); win?.hide(); }
  catch (error) { report(error); showWindow(false); }
  finally { hiding = false; }
}
async function quit() {
  if (quitting) return;
  quitting = true;
  try {
    await flushAll();
    await cleanup?.dispose?.();
    await library.dispose();
    resources.dispose();
    await shortcuts?.dispose();
    tray?.destroy();
    quitReady = true;
    app.quit();
  } catch (error) { quitting = false; report(error); showWindow(false); }
}
function endShortcutRecording() {
  if (quitting) return Promise.resolve();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(false);
  return shortcuts?.endRecording();
}
function setTrayImage() {
  if (!tray) return;
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : nativeTheme.shouldUseDarkColors ? 'tray-light.png' : 'tray.png';
  const image = nativeImage.createFromPath(path.join(trayDirectory, file));
  if (!image.isEmpty()) { if (process.platform === 'darwin') image.setTemplateImage(true); tray.setImage(image); }
}
function createTray() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  tray = new Tray(path.join(trayDirectory, file));
  tray.setToolTip('nvShift');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open nvShift', click: () => showWindow() },
    { label: 'Settings', click: () => { showWindow(false); command('settings'); } },
    { type: 'separator' }, { label: 'Quit nvShift', click: () => void quit() },
  ]));
  tray.on('click', () => showWindow());
  setTrayImage();
  nativeTheme.on('updated', setTrayImage);
}
function createWindow() {
  uiReady = false;
  win = new BrowserWindow({
    ...titlebarOptions(), show: false, width: 1280, height: 850, minWidth: 760, minHeight: 520,
    title: 'nvShift', icon: iconPath, backgroundColor: '#f5f4ef',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  const preferences = settings?.snapshot();
  if (preferences) updateTitlebar(win, preferences.mode === 'dark' || (preferences.mode === 'system' && nativeTheme.shouldUseDarkColors) ? preferences.dark : preferences.light);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('render-process-gone', () => {
    uiReady = false;
    void endShortcutRecording();
    resources?.dispose();
    resources = createResources(library, diagramRenderer);
    // Main-owned buffers survive a renderer crash; rebuilding the view restores them.
    if (!quitting && win && !win.isDestroyed()) win.webContents.reload();
  });
  win.on('blur', () => { void endShortcutRecording(); });
  win.webContents.on('destroyed', () => { void endShortcutRecording(); });
  win.on('close', (event) => { if (!quitReady) { event.preventDefault(); void hideWindow(); } });
  win.on('closed', () => { win = null; uiReady = false; });
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.loadFile(page).catch(report);
}
function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Untrusted request.');
    return callback(...args);
  });
}
async function openLibrary(root) {
  await flushAll();
  const canonical = await fs.realpath(root);
  await library.open(canonical, settings.snapshot(canonical));
  await settings.setRoot(canonical);
  broadcast();
  return state();
}
function installHandlers() {
  ipcMain.on('app:renderer-flushed', (event, requestId, error) => { if (trusted(event) && typeof requestId === 'string') flushRequests.get(requestId)?.(error); });
  ipcMain.on('asset:authorize-drop', (event, file) => {
    if (trusted(event) && typeof file === 'string' && file.length < 32768 && !file.includes('\0')) {
      authorizedDrops.set(file, Date.now() + 60000);
      for (const [key, deadline] of authorizedDrops) if (deadline < Date.now()) authorizedDrops.delete(key);
    }
  });
  handle('app:initial', () => state());
  handle('app:ready', () => {
    uiReady = true;
    if (pendingFocusSearch) { pendingFocusSearch = false; command('focus-search'); }
  });
  handle('shortcut:record-start', async () => {
    win.webContents.setIgnoreMenuShortcuts(true);
    await shortcuts.beginRecording();
  });
  handle('shortcut:record-end', endShortcutRecording);
  handle('library:choose', async () => {
    const choice = await dialog.showOpenDialog(win, { title: 'Choose your notes folder', properties: ['openDirectory', 'createDirectory'] });
    return choice.canceled ? null : openLibrary(choice.filePaths[0]);
  });
  handle('library:search', (query) => library.search(query));
  handle('note:create', (title, extension) => library.create(title, extension));
  handle('note:open', (id) => library.activate(id));
  handle('note:update', (id, source, clientVersion, baseRevision) => library.updateBuffer(id, source, clientVersion, baseRevision));
  handle('note:save', (id) => library.save(id));
  handle('note:syntax', (id, mode) => library.setSyntax(id, mode));
  handle('note:rename', (id, title) => library.rename(id, title));
  handle('note:trash', async (id) => { await library.trash(id); return state(); });
  handle('note:conflict', (id, action) => library.resolveConflict(id, action));
  handle('note:reveal', (id) => { const note = library.get(id); if (!note) throw new Error('Choose a note first.'); shell.showItemInFolder(note.path); });
  handle('settings:update', async (patch) => {
    const valid = validate(patch);
    let updated;
    if (Object.hasOwn(valid, 'globalShortcut')) {
      if (Object.keys(valid).length !== 1) throw new Error('Change the global shortcut separately from other settings.');
      updated = await shortcuts.update(valid.globalShortcut);
    } else updated = await settings.update(valid, library.snapshot().root);
    if (Object.hasOwn(patch, 'defaultExtension') || Object.hasOwn(patch, 'txtSyntax')) await library.setPreferences(updated);
    broadcast();
    return updated;
  });
  handle('window:theme', (theme) => updateTitlebar(win, theme));
  handle('asset:cleanup-start', async () => { await flushRenderer(); return cleanup.start(); });
  handle('asset:cleanup-cancel', (scanId) => cleanup.cancel(scanId));
  handle('asset:cleanup-thumbnail', async (scanId, id) => {
    const result = await cleanup.thumbnail(scanId, id);
    const image = nativeImage.createFromDataURL(result.dataUrl);
    if (image.isEmpty()) return result;
    const { width, height } = image.getSize();
    const scale = Math.min(1, 96 / width, 96 / height);
    return { dataUrl: image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }).toDataURL() };
  });
  handle('asset:cleanup-trash', async (scanId, ids) => { await flushRenderer(); return cleanup.trash(scanId, ids); });
  handle('asset:protect-history', (id, source) => cleanup.protectHistory(id, source));
  handle('asset:bytes', async (id, bytes) => {
    const note = await library.assertWritable(id);
    if (!(bytes instanceof Uint8Array) && !Array.isArray(bytes)) throw new Error('Invalid clipboard image.');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Clipboard images must be no larger than 8 MiB.');
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw new Error('The clipboard image could not be read.');
    const root = library.snapshot().root;
    const finish = cleanup.beginImport(root);
    try { return await insertImageBytes(root, note, image.toPNG(), 'clipboard.png', { onCreated: (file) => cleanup.protectImport(root, file) }); }
    finally { finish(); }
  });
  handle('asset:paths', async (id, paths) => {
    if (!Array.isArray(paths) || paths.some((file) => !authorizedDrops.has(file) || authorizedDrops.get(file) < Date.now())) throw new Error('Drop the image files into nvShift again.');
    for (const file of paths) authorizedDrops.delete(file);
    const note = await library.assertWritable(id), root = library.snapshot().root;
    const finish = cleanup.beginImport(root);
    try { return await insertImageFiles(root, note, paths, { onCreated: (file) => cleanup.protectImport(root, file) }); }
    finally { finish(); }
  });
  handle('resource:image', (...args) => resources.image(...args));
  handle('resource:diagram', (...args) => resources.diagram(...args));
  handle('resource:link', async (id, revision, reference) => {
    const resource = await resources.link(id, revision, reference);
    const note = library.get(id);
    const { file, fragment } = resolveDocumentLink(note.path, resource.target);
    const target = await library.resolveIndexedPath(file);
    if (!target) throw new Error('That note is not reachable from the selected notes folder.');
    return { document: await library.activate(target.id), fragment };
  });
  handle('link:external', async (value) => {
    if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid link.');
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Unsupported link.');
    await shell.openExternal(url.href);
  });
}
function installMenu() {
  const fire = (name) => () => { if (!shortcuts?.snapshot().recording) command(name); };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'nvShift', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'Cmd+,', click: fire('settings') }, { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { label: 'Quit nvShift', accelerator: 'Cmd+Q', click: () => void quit() }] }] : []),
    { label: 'File', submenu: [
      { label: 'Search or create note', accelerator: 'CmdOrCtrl+L', click: fire('focus-search') },
      { label: 'Choose notes folder…', accelerator: 'CmdOrCtrl+O', click: fire('choose-library') },
      { label: 'Find unused assets…', click: fire('asset-cleanup') },
      { label: 'Save note', accelerator: 'CmdOrCtrl+S', click: fire('save') },
      { type: 'separator' }, { label: 'Hide window', accelerator: 'CmdOrCtrl+W', click: () => void hideWindow() },
      ...(process.platform === 'darwin' ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: fire('settings') }, { label: 'Quit nvShift', accelerator: 'Ctrl+Q', click: () => void quit() }]),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Find in note', accelerator: 'CmdOrCtrl+F', click: fire('find') },
      { label: 'Cycle editor / split / preview', accelerator: 'CmdOrCtrl+Shift+P', click: fire('cycle-view') },
      { label: 'Folding', submenu: [
        { label: 'Toggle heading', click: fire('toggle-heading') },
        { label: 'Expand all', click: fire('expand-folds') },
      ] },
      { type: 'separator' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
    ] },
    { role: 'windowMenu' },
  ]));
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => showWindow());
  app.on('activate', () => { if (settings) showWindow(); });
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => { if (!quitReady) { event.preventDefault(); void quit(); } });
  app.whenReady().then(async () => {
    settings = await createSettings(app.getPath('userData'));
    library = createLibrary({
      userData: app.getPath('userData'), trashItem: (file) => shell.trashItem(file),
      onDocument: (doc) => { resources?.changed(doc); if (uiReady) { win?.webContents.send('note:changed', doc); if (!doc) broadcast(); } },
      onLibrary: (value) => { if (uiReady) win?.webContents.send('library:changed', value); },
      onError: report,
    });
    cleanup = createAssetCleanup({ library, userData: app.getPath('userData'), trashItem: (file) => shell.trashItem(file),
      onProgress: (value) => { if (uiReady) win?.webContents.send('asset:cleanup', value); } });
    diagramRenderer = createDiagramRenderer();
    resources = createResources(library, diagramRenderer);
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
    const root = bootRoot || settings.lastLibrary();
    if (root) {
      try {
        const canonical = await fs.realpath(root);
        await library.open(canonical, settings.snapshot(canonical));
        await settings.setRoot(canonical);
      } catch (error) { report(error); }
    }
    shortcuts = createShortcutController({
      globalShortcut, settings,
      wayland: process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY)),
      onActivate: () => showWindow(),
      onChange: (value) => {
        if (win && !win.isDestroyed()) win.webContents.setIgnoreMenuShortcuts(value.recording);
        broadcast();
      },
    });
    installHandlers(); installMenu(); createTray();
    await shortcuts.initialize(); createWindow();
  }).catch((error) => { console.error(error); dialog.showErrorBox('nvShift could not start', error.message); quitReady = true; app.quit(); });
}
