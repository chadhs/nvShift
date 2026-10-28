// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

expect.setDefaultTimeout?.(12000);
const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-smoke-'));
const root = path.join(directory, 'notes');
const profile = path.join(directory, 'profile');
await mkdir(path.join(root, 'nested'), { recursive: true });
await mkdir(path.join(root, 'other'));
await mkdir(path.join(root, 'assets'));
await mkdir(path.join(root, '.hidden'));
const png = await readFile('build/icons/16x16.png');
await writeFile(path.join(root, 'assets', 'pixel.png'), png);
for (const name of ['cleanup-unused.png', 'cleanup-backup.png', 'cleanup-undo.png', 'cleanup-fail.png', 'cleanup-stale.png']) {
  await writeFile(path.join(root, 'assets', name), png);
}
// A saved historical version must remain reviewable without being mistaken for
// a current note or this session's Undo history.
const canonicalRoot = await realpath(root);
const recoverySnapshots = path.join(profile, 'recovery', createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 24), 'snapshots');
await mkdir(recoverySnapshots, { recursive: true });
const rootIdentity = await stat(canonicalRoot);
const historicalSource = '# Historical version\n![Old image](assets/cleanup-backup.png)';
await writeFile(path.join(recoverySnapshots, 'smoke-cleanup-history.json'), JSON.stringify({
  version: 2, reason: 'before-save', path: path.join(canonicalRoot, 'Welcome.md'),
  logicalPath: path.join(canonicalRoot, 'Welcome.md'), directoryIdentity: `${rootIdentity.dev}:${rootIdentity.ino}`,
  savedAt: Date.now() - 86400000, buffer: historicalSource, bom: false, newline: '\n',
  baseFingerprint: '', disk: { source: historicalSource, bom: false, newline: '\n', fingerprint: '' },
}));
let remoteRequests = 0;
const server = createServer((_request, response) => { remoteRequests++; response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const remote = `http://127.0.0.1:${server.address().port}/image.png`;
await writeFile(path.join(root, 'Welcome.md'), `# Welcome to nvShift\n\nA searchable keyboard notebook.\n\n![Local](assets/pixel.png)\n\n![Remote](${remote})\n\n\`\`\`mermaid\nflowchart LR\nThought --> Note\n\`\`\`\n\n[Org note](Notes.org#org-heading)\n\n<img src=x onerror="window.compromised=true">`);
await writeFile(path.join(root, 'nested', 'duplicate.md'), '# Deep document\nCobalt zeppelin nested match.');
await writeFile(path.join(root, 'other', 'duplicate.org'), '* Other duplicate\nCobalt another match.');
await writeFile(path.join(root, 'Notes.org'), '#+title: Org notebook\n* Org heading\nOrg *emphasis* and [[file:assets/pixel.png]].\n');
const headingSource = 'An introduction before the title.\n\n# Original *heading* 日本語\n\n## Section\n\n[Top](#original-heading-日本語)\n';
await writeFile(path.join(root, 'Headings.md'), headingSource);
await writeFile(path.join(root, 'Lists.org'), '#+TITLE: List notebook\n* Different section\n\n- First');
const txtBytes = Buffer.from('\ufeff* TODO Text syntax\r\nPreserve café 日本語.\r\n');
await writeFile(path.join(root, 'syntax.txt'), txtBytes);
await writeFile(path.join(root, '.hidden', 'excluded.md'), 'Do not index this hidden note.');
await writeFile(path.join(root, 'assets', 'excluded.txt'), 'Do not index asset text.');
const linkedRoot = path.join(directory, 'linked notes');
await mkdir(path.join(linkedRoot, 'assets'), { recursive: true });
await writeFile(path.join(linkedRoot, 'assets', 'pixel.png'), png);
await writeFile(path.join(linkedRoot, 'Linked.md'), '# Linked note\n\nAn external directory note.\n\n![Existing](assets/pixel.png)\n\n[Linked Org](LinkedOrg.org#linked-heading)\n');
await writeFile(path.join(linkedRoot, 'LinkedOrg.org'), '#+title: Linked Org\n* Linked heading\n:PROPERTIES:\n:CUSTOM_ID: linked-heading\n:END:\n[[file:assets/pixel.png]]\n');
await writeFile(path.join(linkedRoot, 'LinkedText.txt'), '* TODO Linked text\n[[file:assets/pixel.png]]\n');
await symlink(linkedRoot, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
await symlink(root, path.join(linkedRoot, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
const executablePath = process.env.NVSHIFT_EXECUTABLE;
const appArgs = executablePath ? [] : ['.'];
const profileArg = `--user-data-dir=${profile}`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app, window;
const errors = [];
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = () => window.locator('#editor .cm-content');
const searchField = () => window.locator('#library-search');
const highlightedResult = () => window.locator('#results .result-item[aria-selected="true"]');
async function expectHighlightedNote() {
  const id = await highlightedResult().getAttribute('data-id');
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).document?.id).toBe(id);
  const extension = await highlightedResult().locator('.result-extension').textContent();
  await expect(window.locator('#note-path')).toHaveText(`duplicate${extension}`);
  await expect(window.locator('#note-title')).toHaveText(extension === '.md' ? 'Deep document' : 'Other duplicate');
  await expect(source()).toContainText(extension === '.md' ? 'Cobalt zeppelin' : 'Cobalt another');
  await expect(searchField()).toBeFocused();
  return id;
}
async function search(query) {
  await window.locator('#library-search').fill(query);
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.search(document.querySelector('#library-search').value))).query).toBe(query);
}
async function openNote(title, heading) {
  await search(title);
  const row = window.locator('#results .result-item').filter({ has: window.getByText(title, { exact: true }) }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).document?.title).toBe(title);
  if (heading !== undefined) await expect(window.locator('#note-title')).toHaveText(heading);
}
async function expectSyntax(format, mode = 'auto') {
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).document?.format).toBe(format);
  await expect(window.locator('#syntax-select')).toBeVisible();
  await expect(window.locator('#syntax-select')).toHaveValue(mode);
  if (mode === 'auto') await expect(window.locator('#syntax-select option[value=auto]')).toHaveText(`Automatic · ${format === 'org' ? 'Org' : format === 'markdown' ? 'Markdown' : 'Plain text'}`);
}
const buffer = () => window.evaluate(async () => (await window.nvShift.initial()).document?.source);
async function replaceSource(text) {
  await source().focus();
  await window.keyboard.press(`${modifier}+a`);
  await window.keyboard.insertText(text);
  await expect.poll(buffer).toBe(text);
}
async function listEnter(before, after) {
  await replaceSource(before);
  await window.keyboard.press(`${modifier}+End`);
  await window.keyboard.press('Enter');
  await expect.poll(buffer).toBe(after);
}
async function setSetting(id, value) {
  if (!await window.locator('#settings-dialog').isVisible()) await window.locator('#appearance-button').click();
  const control = window.locator(id);
  if (typeof value === 'boolean') await control.setChecked(value); else await control.selectOption(value);
}
async function doneSettings() {
  if (await window.locator('#settings-dialog').isVisible()) await window.locator('#settings-done').click();
  await expect(window.locator('#settings-dialog')).toBeHidden();
}
async function waitSaved() { await expect(window.locator('#save-status')).toHaveText('Saved', { timeout: 15000 }); }
const cleanupItem = (name) => window.locator(`#cleanup-dialog .cleanup-item[data-name=${JSON.stringify(name)}]`);
const fileExists = (file) => stat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
async function openCleanup({ wait = true } = {}) {
  await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu()?.items.find((item) => item.label.replaceAll('&', '') === 'File');
    const item = menu?.submenu?.items.find((entry) => entry.label === 'Find unused assets…');
    if (!item || !item.enabled) throw new Error('Find unused assets menu action is unavailable');
    item.click();
  });
  await expect(window.locator('#cleanup-dialog')).toBeVisible();
  if (wait) await expect(window.locator('#cleanup-progress')).toHaveAttribute('data-status', 'complete', { timeout: 30000 });
}
async function rescanCleanup() {
  const previous = await window.locator('#cleanup-dialog').getAttribute('data-scan-id');
  await window.locator('#cleanup-rescan').click();
  await expect.poll(() => window.locator('#cleanup-dialog').getAttribute('data-scan-id')).not.toBe(previous);
  await expect(window.locator('#cleanup-progress')).toHaveAttribute('data-status', 'complete', { timeout: 30000 });
}
async function installAssetTrashFixture() {
  const destination = path.join(directory, 'asset-trash');
  await mkdir(destination, { recursive: true });
  await app.evaluate(async ({ shell }, { destination, root }) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const paths = process.getBuiltinModule('node:path');
    const key = (file) => process.platform === 'win32' ? paths.resolve(file).toLowerCase() : paths.resolve(file);
    globalThis.smokeOriginalAssetTrash = shell.trashItem;
    shell.trashItem = async (file) => {
      if (key(paths.dirname(file)) !== key(paths.join(root, 'assets'))) throw new Error('Asset fixture refused an unexpected path');
      if (paths.basename(file) === 'cleanup-fail.png') throw new Error('Simulated asset trash failure');
      await fs.rename(file, paths.join(destination, paths.basename(file)));
    };
  }, { destination, root: canonicalRoot });
  return destination;
}
async function restoreAssetTrashFixture() {
  await app.evaluate(({ shell }) => {
    if (globalThis.smokeOriginalAssetTrash) shell.trashItem = globalThis.smokeOriginalAssetTrash;
    delete globalThis.smokeOriginalAssetTrash;
  });
}
async function launch({ firstRun = false } = {}) {
  app = await electron.launch({ executablePath, args: [...appArgs, ...(firstRun ? [] : [`--library=${root}`]), profileArg], env, chromiumSandbox: true, timeout: 30000 });
  window = await app.firstWindow();
  window.on('pageerror', (error) => errors.push(error.message));
  if (firstRun) {
    await expect(window.locator('#welcome-choose')).toBeVisible();
    await expect(window.locator('#library-search')).toBeDisabled();
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
    await window.locator('#welcome-choose').click();
  }
  await expect(window.locator('#library-summary')).toContainText('10 notes', { timeout: 20000 });
  await expect(window.locator('#library-search')).toBeEnabled();
}
try {
  await launch({ firstRun: true });
  expect(app.process().spawnargs).not.toContain('--no-sandbox');
  const preferences = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).webContents.getLastWebPreferences());
  expect(preferences.sandbox).toBe(true);
  expect(preferences.contextIsolation).toBe(true);
  expect(preferences.nodeIntegration).toBe(false);
  expect(await window.evaluate(() => typeof window.require)).toBe('undefined');

  await search('cob zepp');
  await expect(window.locator('#results .result-item:not(.create-result)')).toHaveCount(1);
  await expect(window.locator('#results')).toContainText('nested');
  await search('duplicate');
  await expect(window.locator('#results .result-item:not(.create-result)')).toHaveCount(2);

  // Arrow browsing shows each highlighted result without leaving search.
  const duplicateIds = await window.locator('#results .result-item').evaluateAll((elements) => elements.map((element) => element.dataset.id));
  await searchField().press('ArrowDown');
  expect(await expectHighlightedNote()).toBe(duplicateIds[1]);
  await searchField().press('ArrowUp');
  expect(await expectHighlightedNote()).toBe(duplicateIds[0]);
  await searchField().press('ArrowUp');
  expect(await expectHighlightedNote()).toBe(duplicateIds[1]);
  await searchField().press('ArrowDown');
  expect(await expectHighlightedNote()).toBe(duplicateIds[0]);

  // Burst requests must settle on the final row, rather than a stale open.
  await searchField().evaluate((element) => {
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowUp', 'ArrowUp', 'ArrowDown']) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    }
  });
  const enteredId = await expectHighlightedNote();
  await searchField().press('Enter');
  await expect(source()).toBeFocused();
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).document?.id).toBe(enteredId);

  // Starting another browse flushes a just-typed buffer before changing notes.
  const edited = (await window.evaluate(() => window.nvShift.initial())).document;
  await window.keyboard.press(`${modifier}+End`);
  await window.keyboard.insertText('\nKeyboard browse flush marker.');
  await window.keyboard.press(`${modifier}+l`);
  await searchField().press('ArrowDown');
  const otherId = await expectHighlightedNote();
  expect(otherId).not.toBe(edited.id);
  expect(await readFile(edited.path, 'utf8')).toContain('Keyboard browse flush marker.');

  // Browsing respects the current Split/Preview view; Enter chooses editing.
  await window.locator('#view-split').click();
  await window.keyboard.press(`${modifier}+l`);
  await searchField().press('ArrowUp');
  await expectHighlightedNote();
  await expect(window.locator('#workspace')).toHaveAttribute('data-view', 'split');
  await expect(window.locator('#content')).toContainText('Cobalt');
  await expect(window.locator('#document-title')).toHaveText(await window.locator('#note-title').textContent());
  await expect(searchField()).toBeFocused();
  await window.locator('#view-preview').click();
  await window.keyboard.press(`${modifier}+l`);
  await searchField().press('ArrowDown');
  const previewId = await expectHighlightedNote();
  await expect(window.locator('#workspace')).toHaveAttribute('data-view', 'preview');
  await expect(window.locator('#content')).toContainText('Cobalt');
  await searchField().press('Enter');
  await expect(window.locator('#workspace')).toHaveAttribute('data-view', 'editor');
  await expect(source()).toBeFocused();
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).document?.id).toBe(previewId);

  // A Create row is only a proposal until Enter or Mod+Enter confirms it.
  const countBeforeCreate = (await window.evaluate(() => window.nvShift.initial())).library.count;
  await search('Browse planned note');
  await expect(window.locator('#results .create-result')).toBeVisible();
  await searchField().press('ArrowDown');
  await expect(highlightedResult()).toHaveClass(/create-result/);
  await expect(searchField()).toBeFocused();
  expect((await window.evaluate(() => window.nvShift.initial())).library.count).toBe(countBeforeCreate);
  expect((await readdir(root)).includes('Browse planned note.md')).toBe(false);
  await searchField().press(`${modifier}+Enter`);
  await expect(window.locator('#note-path')).toHaveText('Browse planned note.md');
  await expect(source()).toBeFocused();
  expect((await window.evaluate(() => window.nvShift.initial())).library.count).toBe(countBeforeCreate + 1);

  // Typing during a pending browse keeps focus and Enter follows the new query.
  await search('duplicate');
  await expect(window.locator('#results .result-item:not(.create-result)')).toHaveCount(2);
  await searchField().press('ArrowDown');
  await searchField().fill('Welcome.md');
  await expect(window.locator('#results .result-item:not(.create-result)')).toHaveCount(1);
  await expect(window.locator('#results .result-title')).toHaveText('Welcome');
  await expect(searchField()).toBeFocused();
  await expect(searchField()).toHaveValue('Welcome.md');
  await searchField().press('Enter');
  await expect(window.locator('#note-path')).toHaveText('Welcome.md');
  await expect(source()).toBeFocused();

  // Gate one started IPC open so its response arrives after a newer Enter.
  // Electron's pinned test runtime exposes its registered invoke-handler map;
  // no application or preload test hooks are needed, and the handler is restored.
  await search('duplicate');
  await expect(window.locator('#results .result-item:not(.create-result)')).toHaveCount(2);
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('note:open');
    if (typeof original !== 'function') throw new Error('Missing note:open fixture handler');
    const gate = globalThis.smokeBrowseOpen = { original, started: false, release: null };
    ipcMain.removeHandler('note:open');
    ipcMain.handle('note:open', async (...args) => {
      if (!gate.started) {
        gate.started = true;
        await new Promise((resolve) => { gate.release = resolve; });
      }
      return original(...args);
    });
  });
  try {
    await searchField().press('ArrowDown');
    await expect.poll(() => app.evaluate(() => globalThis.smokeBrowseOpen.started)).toBe(true);
    await searchField().fill('Welcome.md');
    await expect(window.locator('#results .result-item:not(.create-result)')).toHaveCount(1);
    await expect(searchField()).toBeFocused();
    await searchField().press('Enter');
    await app.evaluate(() => globalThis.smokeBrowseOpen.release());
    await expect(window.locator('#note-path')).toHaveText('Welcome.md');
    await expect(source()).toBeFocused();
    await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).document?.name).toBe('Welcome.md');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.smokeBrowseOpen;
      gate.release?.();
      ipcMain.removeHandler('note:open');
      ipcMain.handle('note:open', gate.original);
      delete globalThis.smokeBrowseOpen;
    });
  }

  await openNote('Linked', 'Linked note');
  await expect(window.locator('#note-folder')).toHaveText('linked');
  expect((await window.evaluate(() => window.nvShift.initial())).document.path).toBe(await realpath(path.join(linkedRoot, 'Linked.md')));
  await window.locator('#view-split').click();
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(1, { timeout: 15000 });
  await source().click();
  await window.keyboard.press(`${modifier}+End`);
  const linkedDrop = path.join(directory, 'architecture diagram.png');
  await writeFile(linkedDrop, png);
  const linkedBox = await window.locator('#editor').boundingBox();
  const linkedCDP = await window.context().newCDPSession(window);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await linkedCDP.send('Input.dispatchDragEvent', { type, x: linkedBox.x + 60, y: linkedBox.y + 60, data: { items: [], files: [linkedDrop], dragOperationsMask: 1 } });
  await expect(source()).toContainText('../notes/assets/architecture%20diagram-');
  await waitSaved();
  expect(await readFile(path.join(linkedRoot, 'Linked.md'), 'utf8')).toContain('architecture%20diagram-');
  expect((await readdir(path.join(root, 'assets'))).some((name) => /^architecture diagram-[a-f0-9-]+\.png$/.test(name))).toBe(true);
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(2, { timeout: 15000 });
  await window.locator('#content a[data-document-link]').click();
  await expect(window.locator('#note-title')).toHaveText('Linked Org');
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(1, { timeout: 15000 });
  await openNote('LinkedText');
  await expectSyntax('org');
  await expect(window.locator('#note-title')).toHaveText('Linked text');
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(1, { timeout: 15000 });

  await openNote('Welcome', 'Welcome to nvShift');
  await window.locator('#view-split').click();
  await expect(window.locator('#content')).toContainText('searchable keyboard notebook', { timeout: 20000 });
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(2, { timeout: 20000 });
  await expect(window.locator('#content .diagram[data-rendered="true"]')).toHaveCount(1, { timeout: 20000 });
  expect(remoteRequests).toBeGreaterThan(0);
  expect(await window.evaluate(() => window.compromised)).toBeUndefined();
  await expect(window.locator('#content')).toContainText('<img src=x');
  await expect(window.locator('#content img[onerror]')).toHaveCount(0);

  // Content titles work in Editor view, including headings after an introduction.
  // A slow view preference write must not pull focus back after starting search.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get('settings:update');
    const gate = globalThis.smokeViewSettings = { original, started: false, finished: false, release: null };
    ipcMain.removeHandler('settings:update');
    ipcMain.handle('settings:update', async (...args) => {
      if (!gate.started) { gate.started = true; await new Promise((resolve) => { gate.release = resolve; }); }
      try { return await original(...args); } finally { gate.finished = true; }
    });
  });
  try {
    await window.locator('#view-editor').click();
    await expect.poll(() => app.evaluate(() => globalThis.smokeViewSettings.started)).toBe(true);
    await search('Headings');
    await app.evaluate(() => globalThis.smokeViewSettings.release());
    await expect.poll(() => app.evaluate(() => globalThis.smokeViewSettings.finished)).toBe(true);
    await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(searchField()).toBeFocused();
    await expect(searchField()).toHaveValue('Headings');
  } finally {
    await app.evaluate(({ ipcMain }) => {
      const gate = globalThis.smokeViewSettings; gate.release?.();
      ipcMain.removeHandler('settings:update'); ipcMain.handle('settings:update', gate.original);
      delete globalThis.smokeViewSettings;
    });
  }
  await openNote('Headings', 'Original heading 日本語');
  await expect(window.locator('#note-path')).toHaveText('Headings.md');
  await expect(window.locator('#results .result-item[data-active="true"] .result-title')).toHaveText('Headings');
  await replaceSource('Intro.\n\n# Edited *title* 日本語\n\nBody.');
  await expect(window.locator('#note-title')).toHaveText('Edited title 日本語');
  await replaceSource('Body without a title.');
  await expect(window.locator('#note-title')).toHaveText('Headings');
  await replaceSource(headingSource);
  await expect(window.locator('#note-title')).toHaveText('Original heading 日本語');
  await window.locator('#view-split').click();
  await expect(window.locator('#document-title')).toHaveText('Original heading 日本語');
  await expect(window.locator('#content h2')).toHaveCount(0);
  await window.locator('#content a[href="#document-title"]').click();

  // The global filename preference changes presentation while preserving the editor.
  await source().focus();
  await window.keyboard.press(`${modifier}+Home`);
  const selectedLine = headingSource.split('\n')[0];
  await window.keyboard.down('Shift');
  for (let index = 0; index < selectedLine.length; index++) await window.keyboard.press('ArrowRight');
  await window.keyboard.up('Shift');
  const selectedText = () => window.evaluate(() => getSelection()?.toString());
  await expect.poll(selectedText).toBe(selectedLine);
  await setSetting('#filename-headings', true);
  await expect(window.locator('#note-title')).toHaveText('Headings');
  await expect(window.locator('#document-title')).toHaveText('Headings');
  await doneSettings();
  await expect(window.locator('#content h2')).toHaveText('Original heading 日本語');
  await source().focus();
  await expect.poll(selectedText).toBe(selectedLine);
  await window.keyboard.insertText('Selection survived.');
  await expect.poll(buffer).toBe(headingSource.replace('An introduction before the title.', 'Selection survived.'));
  await window.keyboard.press(`${modifier}+z`);
  await expect.poll(buffer).toBe(headingSource);
  await setSetting('#filename-headings', false);
  await doneSettings();
  await expect(window.locator('#note-title')).toHaveText('Original heading 日本語');
  await expect(window.locator('#document-title')).toHaveText('Original heading 日本語');
  await expect(window.locator('#content h2')).toHaveCount(0);

  // Explicit Org TITLE takes precedence over a different level-one heading.
  await openNote('Lists', 'List notebook');
  await expect(window.locator('#document-title')).toHaveText('List notebook');
  await expect(window.locator('#content h2')).toHaveText('Different section');
  await listEnter('- First', '- First\n- ');
  await window.keyboard.press('Enter');
  await expect.poll(buffer).toBe('- First\n');
  await listEnter('  + Nested', '  + Nested\n  + ');
  await listEnter('3) [X] Complete', '3) [X] Complete\n4) [ ] ');
  await replaceSource('- First second');
  await window.keyboard.press('Home');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('ArrowRight');
  await window.keyboard.press('Enter');
  await expect.poll(buffer).toBe('- First\n- second');
  await listEnter('#+begin_src text\n- Literal', '#+begin_src text\n- Literal\n');

  // Vim insert mode uses Org continuation; normal mode and :w retain Vim semantics.
  await replaceSource('- Vim item');
  await setSetting('#vim-mode', true);
  await doneSettings();
  await source().focus();
  await window.keyboard.press('Escape');
  await window.keyboard.type('A');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Second item');
  await window.keyboard.press('Escape');
  await expect.poll(buffer).toBe('- Vim item\n- Second item');
  await window.keyboard.type(':w');
  await window.keyboard.press('Enter');
  await waitSaved();
  expect(await readFile(path.join(root, 'Lists.org'), 'utf8')).toBe('- Vim item\n- Second item');
  await window.keyboard.type('u');
  await expect.poll(buffer).toBe('- Vim item');
  await window.keyboard.press('Enter');
  await expect.poll(buffer).toBe('- Vim item');
  await setSetting('#vim-mode', false);
  await doneSettings();
  await openNote('Welcome', 'Welcome to nvShift');

  for (const [mode, selector, theme] of [['light', '#light-theme', 'light'], ['light', '#light-theme', 'solarized-light'], ['dark', '#dark-theme', 'dark'], ['dark', '#dark-theme', 'solarized-dark']]) {
    await setSetting('#appearance-mode', mode);
    await setSetting(selector, theme);
    await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
    await doneSettings();
    const colors = await window.locator('#editor .cm-editor').evaluate((element) => ({ background: getComputedStyle(element).backgroundColor, paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() }));
    expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
    await window.screenshot({ path: `test-results/${executablePath ? 'packaged' : 'desktop'}-${theme}.png` });
  }
  await setSetting('#sans-serif-headings', true);
  await setSetting('#content-width', 'full');
  await doneSettings();
  await expect(window.locator('html')).toHaveAttribute('data-heading-font', 'sans-serif');
  await expect(window.locator('html')).toHaveAttribute('data-content-width', 'full');
  await expect(window.locator('#toggle-content-width')).toHaveAttribute('aria-pressed', 'true');

  // Existing .txt files detect independently, and defaults affect new notes only.
  await openNote('syntax');
  await expectSyntax('plain');
  await expect(window.locator('#content .plain-preview')).toContainText('* TODO Text syntax');
  await listEnter('- Plain item', '- Plain item\n');
  await replaceSource('* TODO Text syntax\nPreserve café 日本語.\n');
  await waitSaved();
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await setSetting('#txt-syntax', 'org');
  await doneSettings();
  await expectSyntax('plain');
  await search('Created Org text');
  await window.locator('#create-extension').selectOption('txt');
  await searchField().press(`${modifier}+Enter`);
  await expect(window.locator('#note-path')).toHaveText('Created Org text.txt');
  await expectSyntax('org');
  await listEnter('- Created', '- Created\n- ');
  await setSetting('#txt-syntax', 'markdown');
  await doneSettings();
  await expectSyntax('org');
  await window.locator('#rename-note').click();
  await window.locator('#rename-input').fill('Renamed Org text');
  await window.locator('#rename-form').evaluate((element) => element.requestSubmit());
  await expect(window.locator('#note-path')).toHaveText('Renamed Org text.txt');
  await expectSyntax('org');
  await search('Created Markdown text');
  await searchField().press(`${modifier}+Enter`);
  await expect(window.locator('#note-path')).toHaveText('Created Markdown text.txt');
  await expectSyntax('markdown');
  await listEnter('- Created Markdown', '- Created Markdown\n- ');
  await window.locator('#create-extension').selectOption('md');

  await openNote('syntax');
  await expectSyntax('plain');
  // A manual correction preserves the current selection and never rewrites bytes.
  await source().focus();
  await window.keyboard.press(`${modifier}+Home`);
  await window.keyboard.down('Shift');
  for (let index = 0; index < 6; index++) await window.keyboard.press('ArrowRight');
  await window.keyboard.up('Shift');
  await expect.poll(() => window.evaluate(() => getSelection()?.toString())).toBe('* TODO');
  await window.locator('#syntax-select').selectOption('org');
  await expectSyntax('org', 'org');
  await expect.poll(() => window.evaluate(() => getSelection()?.toString())).toBe('* TODO');
  await expect(source()).toBeFocused();
  await expect(window.locator('#note-title')).toHaveText('Text syntax');
  await expect(window.locator('#document-title')).toHaveText('Text syntax');
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await listEnter('- [x] Text item', '- [x] Text item\n- [ ] ');
  await window.locator('#syntax-select').selectOption('markdown');
  await expectSyntax('markdown', 'markdown');
  await source().focus();
  await window.keyboard.press(`${modifier}+z`);
  await expect.poll(buffer).toBe('- [x] Text item');
  await listEnter('- Markdown item', '- Markdown item\n- ');
  await replaceSource('* TODO Text syntax\nPreserve café 日本語.\n');
  await window.locator('#syntax-select').selectOption('auto');
  await expectSyntax('plain');
  await waitSaved();
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);

  // Unsaved detection updates titles, preview, diagrams, and Org Enter together.
  await replaceSource('# Automatic Markdown\n\n```mermaid\nflowchart LR\nA-->B\n```');
  await expectSyntax('markdown');
  await expect(window.locator('#note-title')).toHaveText('Automatic Markdown');
  await expect(window.locator('#document-title')).toHaveText('Automatic Markdown');
  await expect(window.locator('#content .diagram[data-rendered="true"]')).toHaveCount(1, { timeout: 20000 });
  await window.screenshot({ path: `test-results/${executablePath ? 'packaged' : 'desktop'}-syntax-detection.png` });
  await replaceSource('#+TITLE: Automatic Org\n\n- One');
  await expectSyntax('org');
  await expect(window.locator('#note-title')).toHaveText('Automatic Org');
  await expect(window.locator('#document-title')).toHaveText('Automatic Org');
  await source().focus();
  await window.keyboard.press(`${modifier}+End`);
  await window.keyboard.press('Enter');
  await expect.poll(buffer).toBe('#+TITLE: Automatic Org\n\n- One\n- ');
  await setSetting('#vim-mode', true);
  await doneSettings();
  await source().focus();
  await window.keyboard.press('Escape');
  await window.keyboard.type('A');
  await window.locator('#syntax-select').selectOption('org');
  await expectSyntax('org', 'org');
  await source().focus();
  await window.keyboard.type('Second');
  await window.keyboard.press('Enter');
  await window.keyboard.type('Third');
  await window.keyboard.press('Escape');
  await expect.poll(buffer).toBe('#+TITLE: Automatic Org\n\n- One\n- Second\n- Third');
  await window.keyboard.type(':w');
  await window.keyboard.press('Enter');
  await waitSaved();
  await window.keyboard.type('u');
  await expect.poll(buffer).toBe('#+TITLE: Automatic Org\n\n- One\n- Second');
  await setSetting('#vim-mode', false);
  await doneSettings();
  await replaceSource('* TODO Text syntax\nPreserve café 日本語.\n');
  await waitSaved();
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await openNote('LinkedText');
  await expectSyntax('org');
  await expect(window.locator('#note-title')).toHaveText('Linked text');
  await expect(window.locator('#document-title')).toHaveText('Linked text');
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(1, { timeout: 15000 });

  await window.keyboard.press(`${modifier}+l`);
  await window.locator('#library-search').fill('A new thought');
  await expect(window.locator('#results .create-result')).toBeVisible();
  await window.locator('#library-search').press('Enter');
  await expect(window.locator('#note-title')).toHaveText('A new thought');
  await expect(source()).toBeFocused();
  await window.keyboard.type('First draft');
  await window.keyboard.press(`${modifier}+s`);
  await waitSaved();
  expect(await readFile(path.join(root, 'A new thought.md'), 'utf8')).toBe('First draft');

  await setSetting('#vim-mode', true);
  await doneSettings();
  await source().click();
  await window.keyboard.press('Escape');
  await window.keyboard.type('ggI');
  await window.keyboard.type('Vim works. ');
  await window.keyboard.press('Escape');
  await expect(source()).toContainText('Vim works. First draft');
  await window.keyboard.type(':w');
  await window.keyboard.press('Enter');
  await waitSaved();
  expect(await readFile(path.join(root, 'A new thought.md'), 'utf8')).toBe('Vim works. First draft');
  await window.keyboard.type('u');
  await expect(source()).toHaveText('First draft');
  await setSetting('#vim-mode', false);
  await doneSettings();

  // A synthetic file clipboard exercises the actual paste handler without changing the system clipboard.
  const pngCountBeforePaste = (await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length;
  await source().click();
  await window.keyboard.press(`${modifier}+End`);
  await window.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'clipboard.png', { type: 'image/png' });
    const data = new DataTransfer(); data.items.add(file);
    document.querySelector('#editor .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await expect(source()).toContainText('![Image](assets/');
  await expect.poll(async () => (await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(pngCountBeforePaste);
  await waitSaved();
  expect((await readdir(path.join(root, 'assets'))).some((name) => /^clipboard-[a-f0-9-]+\.png$/.test(name))).toBe(true);
  expect((await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(1);

  // CDP uses native file-backed drops, so Electron's webUtils path authorization is exercised.
  const dropped = path.join(directory, 'dropped.png');
  await writeFile(dropped, png);
  const pngCountBeforeDrop = (await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length;
  const box = await window.locator('#editor').boundingBox();
  const cdp = await window.context().newCDPSession(window);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 60, y: box.y + 60, data: { items: [], files: [dropped], dragOperationsMask: 1 } });
  await expect.poll(async () => (await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(pngCountBeforeDrop);
  await expect(source()).toContainText('dropped-');
  await waitSaved();
  expect((await readdir(path.join(root, 'assets'))).some((name) => /^dropped-[a-f0-9-]+\.png$/.test(name))).toBe(true);

  await window.locator('#rename-note').click();
  await window.locator('#rename-input').fill('Renamed thought');
  await window.locator('#rename-input').press('Enter');
  await expect(window.locator('#note-title')).toHaveText('Renamed thought');
  expect(await readFile(path.join(root, 'Renamed thought.md'), 'utf8')).toContain('First draft');

  await writeFile(path.join(root, 'Renamed thought.md'), '# Outside update\nClean reload');
  await expect(source()).toContainText('Clean reload', { timeout: 15000 });
  const local = await window.evaluate(async () => {
    const { document } = await window.nvShift.initial();
    return window.nvShift.updateBuffer(document.id, 'A local conflicting draft', document.clientVersion + 1, document.revision);
  });
  await writeFile(path.join(root, 'Renamed thought.md'), 'The outside version');
  await expect(window.locator('#conflict-banner')).toBeVisible({ timeout: 15000 });
  await expect(source()).toContainText('A local conflicting draft');
  // Conflict drafts remain unsaved, so these headings must come from the buffer.
  await replaceSource('# Unsaved conflict title\nA local conflicting draft');
  await expect(window.locator('#note-title')).toHaveText('Unsaved conflict title');
  await expect(window.locator('#document-title')).toHaveText('Unsaved conflict title');
  expect(await readFile(path.join(root, 'Renamed thought.md'), 'utf8')).toBe('The outside version');
  await window.locator('#keep-both').click();
  await expect(window.locator('#conflict-banner')).toBeHidden();
  expect(await readFile(path.join(root, 'Renamed thought.md'), 'utf8')).toBe('The outside version');
  await expect(source()).toContainText('A local conflicting draft');

  // Opening the same title immediately after typing must open it rather than create it.
  await window.keyboard.press(`${modifier}+l`);
  await window.locator('#library-search').fill('Welcome.md');
  await window.locator('#library-search').press('Enter');
  await expect(window.locator('#note-title')).toHaveText('Welcome to nvShift');
  await expect(window.locator('#message')).toBeHidden();

  // Folder changes flush the old buffer and preserve each folder's creation defaults.
  const secondRoot = path.join(directory, 'second-library');
  await mkdir(secondRoot);
  await writeFile(path.join(secondRoot, 'Second.md'), '# Second library');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, secondRoot);
  await window.locator('#choose-library').click();
  await expect(window.locator('#note-title')).toHaveText('Second library');
  expect((await window.evaluate(() => window.nvShift.initial())).settings.txtSyntax).toBe('plain');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await window.locator('#choose-library').click();
  await expect(window.locator('#note-title')).toHaveText('Second library');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
  await window.locator('#choose-library').click();
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.initial())).library.root).toBe(await realpath(root));
  expect((await window.evaluate(() => window.nvShift.initial())).settings.txtSyntax).toBe('markdown');
  await openNote('Welcome');

  // Simulate a shortcut registration failure without reserving another app's shortcut.
  await app.evaluate(({ globalShortcut }) => { globalThis.originalRegister = globalShortcut.register; globalShortcut.register = () => false; });
  await window.evaluate(() => window.nvShift.updateSettings({ globalShortcut: 'Control+Alt+Shift+F12' }));
  await expect(window.locator('#shortcut-status')).toHaveText('Shortcut unavailable');
  await app.evaluate(({ globalShortcut }) => { globalShortcut.register = globalThis.originalRegister; });
  await window.evaluate(() => window.nvShift.updateSettings({ globalShortcut: '' }));

  // Removing a saved link keeps its image protected by this session's Undo
  // history, while older saved snapshots get a separate cleanup review group.
  await openNote('Browse planned note');
  await replaceSource('![Undo image](assets/cleanup-undo.png)');
  await waitSaved();
  await replaceSource('A note after removing an image link.');
  await waitSaved();
  await openNote('Welcome');
  await openCleanup({ wait: false });
  await window.locator('#cleanup-close').click();
  await expect(window.locator('#cleanup-dialog')).toBeHidden();
  expect(await fileExists(path.join(root, 'assets', 'cleanup-unused.png'))).toBe(true);

  const assetTrash = await installAssetTrashFixture();
  try {
    await openCleanup();
    await expect(window.locator('#cleanup-dialog input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(window.locator('#cleanup-trash')).toBeDisabled();
    await expect(cleanupItem('cleanup-unused.png')).toHaveAttribute('data-category', 'unused');
    await expect(cleanupItem('cleanup-backup.png')).toHaveAttribute('data-category', 'backup');
    await expect(cleanupItem('pixel.png')).toHaveCount(0);
    await expect(cleanupItem('cleanup-undo.png')).toHaveCount(0);
    await expect(window.locator('#cleanup-protected')).toContainText(/Undo|restart/);
    const thumbnail = cleanupItem('cleanup-unused.png').locator('img');
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    await window.screenshot({ path: 'test-results/cleanup-review.png' });

    await window.locator('#cleanup-select-all').click();
    expect(await window.locator('#cleanup-unused input[type="checkbox"]').count()).toBeGreaterThan(0);
    expect(await window.locator('#cleanup-unused input[type="checkbox"]:checked').count()).toBe(await window.locator('#cleanup-unused input[type="checkbox"]').count());
    await expect(window.locator('#cleanup-backups input[type="checkbox"]:checked')).toHaveCount(0);
    await expect(window.locator('#cleanup-selected-total')).not.toContainText('0 selected');
    while (await window.locator('#cleanup-dialog input[type="checkbox"]:checked').count()) await window.locator('#cleanup-dialog input[type="checkbox"]:checked').first().uncheck();
    await cleanupItem('cleanup-backup.png').locator('input').check();
    await expect(window.locator('#cleanup-trash')).toBeEnabled();
    await expect(window.locator('#cleanup-selected-total')).toContainText('1 selected');
    await cleanupItem('cleanup-backup.png').locator('input').uncheck();

    // A batch can succeed partially: a failed Trash operation retains its file.
    await cleanupItem('cleanup-unused.png').locator('input').check();
    await cleanupItem('cleanup-fail.png').locator('input').check();
    await window.locator('#cleanup-trash').click();
    await expect.poll(() => fileExists(path.join(root, 'assets', 'cleanup-unused.png'))).toBe(false);
    expect(await fileExists(path.join(assetTrash, 'cleanup-unused.png'))).toBe(true);
    expect(await fileExists(path.join(root, 'assets', 'cleanup-fail.png'))).toBe(true);
    await expect(cleanupItem('cleanup-unused.png')).toHaveCount(0);
    await expect(cleanupItem('cleanup-fail.png')).toHaveCount(1);
    await expect(window.locator('#cleanup-errors')).toContainText('Simulated asset trash failure');

    await rescanCleanup();
    const staleScan = await window.locator('#cleanup-dialog').getAttribute('data-scan-id');
    const staleId = await cleanupItem('cleanup-stale.png').getAttribute('data-id');
    // A reference introduced after review must prevent even an old opaque-ID
    // removal request from trashing a file that is now needed by a note.
    await writeFile(path.join(root, 'Browse planned note.md'), 'A note with a new [image link](assets/cleanup-stale.png).');
    const staleResult = await window.evaluate(async ({ scanId, id }) => {
      try { return await window.nvShift.trashUnusedAssets(scanId, [id]); }
      catch (error) { return { error: error.message }; }
    }, { scanId: staleScan, id: staleId });
    expect(staleResult.removed ?? []).not.toContain(staleId);
    expect(Boolean(staleResult.error || staleResult.failed?.length)).toBe(true);
    expect(await fileExists(path.join(root, 'assets', 'cleanup-stale.png'))).toBe(true);
    // Wait for the watched disk edit to reach the library before requesting a
    // stable review; the negative request above intentionally races that edit.
    await expect.poll(async () => window.evaluate(async () => (await window.nvShift.search('cleanup stale')).results.some((note) => note.name === 'Browse planned note.md'))).toBe(true);
    await rescanCleanup();
    await expect(cleanupItem('cleanup-stale.png')).toHaveCount(0);

    // An imported image is protected before its link is inserted into a buffer.
    const namesBeforeImport = new Set(await readdir(path.join(root, 'assets')));
    await window.evaluate(async (bytes) => {
      const { document } = await window.nvShift.initial();
      return window.nvShift.insertImage(document.id, new Uint8Array(bytes), 'clipboard.png');
    }, [...png]);
    const importedNames = (await readdir(path.join(root, 'assets'))).filter((name) => !namesBeforeImport.has(name));
    expect(importedNames).toHaveLength(1);
    await rescanCleanup();
    await expect(cleanupItem(importedNames[0])).toHaveCount(0);
    expect(await fileExists(path.join(root, 'assets', importedNames[0]))).toBe(true);
    await window.locator('#cleanup-close').click();
    await expect(window.locator('#cleanup-dialog')).toBeHidden();
  } finally { await restoreAssetTrashFixture(); }

  await setSetting('#filename-headings', true);
  await doneSettings();
  await expect(window.locator('#note-title')).toHaveText('Welcome');
  await expect(window.locator('#document-title')).toHaveText('Welcome');

  await source().click();
  await window.keyboard.type('Close flush marker. ');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(false);
  expect(await readFile(path.join(root, 'Welcome.md'), 'utf8')).toContain('Close flush marker.');
  const executable = await app.evaluate(() => process.execPath);
  const child = spawn(executable, [...appArgs, profileArg], { env, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Second instance exited ${code}`))); });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
  await expect(window.locator('#library-search')).toBeFocused();

  await app.close(); app = null;
  app = await electron.launch({ executablePath, args: [...appArgs, profileArg], env, chromiumSandbox: true, timeout: 30000 });
  window = await app.firstWindow();
  window.on('pageerror', (error) => errors.push(error.message));
  await expect(window.locator('#library-search')).toBeEnabled({ timeout: 20000 });
  await expect(window.locator('html')).toHaveAttribute('data-theme', 'solarized-dark');
  const restored = await window.evaluate(() => window.nvShift.initial());
  expect(restored.library.root).toBe(await realpath(root));
  expect(restored.settings.txtSyntax).toBe('markdown');
  expect(restored.settings.sansSerifHeadings).toBe(true);
  expect(restored.settings.contentWidth).toBe('full');
  expect(restored.settings.filenameHeadings).toBe(true);
  await openNote('Renamed Org text');
  await expectSyntax('org');
  await openNote('syntax');
  await expectSyntax('org', 'org');
  // Undo pins end at app restart. The removed image remains an older-backup
  // candidate, which is explicitly selectable without touching its snapshots.
  const restartedTrash = await installAssetTrashFixture();
  try {
    await openCleanup();
    await expect(cleanupItem('cleanup-undo.png')).toHaveAttribute('data-category', 'backup');
    await expect(window.locator('#cleanup-dialog input[type="checkbox"]:checked')).toHaveCount(0);
    await window.locator('#cleanup-select-all').click();
    await expect(cleanupItem('cleanup-undo.png').locator('input')).not.toBeChecked();
    while (await window.locator('#cleanup-dialog input[type="checkbox"]:checked').count()) await window.locator('#cleanup-dialog input[type="checkbox"]:checked').first().uncheck();
    await cleanupItem('cleanup-undo.png').locator('input').check();
    await window.locator('#cleanup-trash').click();
    await expect.poll(() => fileExists(path.join(root, 'assets', 'cleanup-undo.png'))).toBe(false);
    expect(await fileExists(path.join(restartedTrash, 'cleanup-undo.png'))).toBe(true);
    expect(await fileExists(path.join(recoverySnapshots, 'smoke-cleanup-history.json'))).toBe(true);
    await window.locator('#cleanup-close').click();
  } finally { await restoreAssetTrashFixture(); }
  await openNote('Welcome', 'Welcome');
  await setSetting('#filename-headings', false);
  await doneSettings();
  await expect(window.locator('#note-title')).toHaveText('Welcome to nvShift');
  await window.evaluate(async () => {
    const { document } = await window.nvShift.initial();
    await window.nvShift.updateBuffer(document.id, document.source + '\nRenderer recovery marker', document.clientVersion + 1, document.revision);
  });
  // Exercise renderer-loss recovery without invoking an OS crash reporter.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).webContents.emit('render-process-gone', {}, { reason: 'crashed' }));
  await expect(source()).toContainText('Renderer recovery marker', { timeout: 15000 });
  await waitSaved();
  expect(errors).toEqual([]);
  console.log(`nvShift ${executablePath ? 'packaged' : 'development'} smoke passed: recursive search, arrow-result browsing/focus/flush/latest selection, content headings/unsaved titles/filename preference, keyboard creation, Org list continuation/Vim/:w/undo, all themes, mixed .txt detection/new-note defaults/manual overrides/Undo/Vim/restart, images, asset cleanup/recovery/Undo/Trash/revalidation, Mermaid, external saves/conflicts, rename, settings restart, sandbox, shortcut errors, background/relaunch.`);
} catch (error) {
  console.error('Smoke failure details:', JSON.stringify({ errors, state: await window?.evaluate(async () => {
    const initial = await window.nvShift.initial().then((state) => ({ library: state.library, document: state.document?.name })).catch((failure) => ({ error: failure.message }));
    return { initial, message: document.querySelector('#message-text')?.textContent, summary: document.querySelector('#library-summary')?.textContent, cleanup: document.querySelector('#cleanup-errors')?.textContent };
  }).catch((failure) => ({ error: failure.message })) }));
  await window?.screenshot({ path: `test-results/${executablePath ? 'packaged' : 'desktop'}-failure.png`, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => { app.process().kill('SIGKILL'); });
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
