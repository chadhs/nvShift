// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
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
let remoteRequests = 0;
const server = createServer((_request, response) => { remoteRequests++; response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(png); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const remote = `http://127.0.0.1:${server.address().port}/image.png`;
await writeFile(path.join(root, 'Welcome.md'), `# Welcome to nvShift\n\nA searchable keyboard notebook.\n\n![Local](assets/pixel.png)\n\n![Remote](${remote})\n\n\`\`\`mermaid\nflowchart LR\nThought --> Note\n\`\`\`\n\n[Org note](Notes.org#org-heading)\n\n<img src=x onerror="window.compromised=true">`);
await writeFile(path.join(root, 'nested', 'duplicate.md'), '# Deep document\nCobalt zeppelin nested match.');
await writeFile(path.join(root, 'other', 'duplicate.org'), '* Other duplicate\nCobalt another match.');
await writeFile(path.join(root, 'Notes.org'), '#+title: Org notebook\n* Org heading\nOrg *emphasis* and [[file:assets/pixel.png]].\n');
const txtBytes = Buffer.from('\ufeff* TODO Text syntax\r\nPreserve café 日本語.\r\n');
await writeFile(path.join(root, 'syntax.txt'), txtBytes);
await writeFile(path.join(root, '.hidden', 'excluded.md'), 'Do not index this hidden note.');
await writeFile(path.join(root, 'assets', 'excluded.txt'), 'Do not index asset text.');
const executablePath = process.env.NVSHIFT_EXECUTABLE;
const appArgs = executablePath ? [] : ['.'];
const profileArg = `--user-data-dir=${profile}`;
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app, window;
const errors = [];
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
const source = () => window.locator('#editor .cm-content');
async function search(query) {
  await window.locator('#library-search').fill(query);
  await expect.poll(async () => (await window.evaluate(() => window.nvShift.search(document.querySelector('#library-search').value))).query).toBe(query);
}
async function openNote(title) {
  await search(title);
  const row = window.locator('#results .result-item').filter({ has: window.getByText(title, { exact: true }) }).first();
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.click();
  await expect(window.locator('#note-title')).toHaveText(title);
}
async function setSetting(id, value) {
  if (!await window.locator('#settings-dialog').isVisible()) await window.locator('#appearance-button').click();
  const control = window.locator(id);
  if (typeof value === 'boolean') await control.setChecked(value); else await control.selectOption(value);
}
async function doneSettings() { if (await window.locator('#settings-dialog').isVisible()) await window.locator('#settings-done').click(); }
async function waitSaved() { await expect(window.locator('#save-status')).toHaveText('Saved', { timeout: 15000 }); }
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
  await expect(window.locator('#library-summary')).toContainText('5 notes', { timeout: 20000 });
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

  await openNote('Welcome');
  await window.locator('#view-split').click();
  await expect(window.locator('#content')).toContainText('searchable keyboard notebook', { timeout: 20000 });
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(2, { timeout: 20000 });
  await expect(window.locator('#content .diagram[data-rendered="true"]')).toHaveCount(1, { timeout: 20000 });
  expect(remoteRequests).toBeGreaterThan(0);
  expect(await window.evaluate(() => window.compromised)).toBeUndefined();
  await expect(window.locator('#content')).toContainText('<img src=x');
  await expect(window.locator('#content img[onerror]')).toHaveCount(0);

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

  await openNote('syntax');
  await expect(window.locator('#syntax-label')).toHaveText('PLAIN TEXT');
  await expect(window.locator('#content .plain-preview')).toContainText('* TODO Text syntax');
  await setSetting('#txt-syntax', 'org');
  await doneSettings();
  await expect(window.locator('#syntax-label')).toHaveText('ORG');
  await expect(window.locator('#content h2')).toContainText('Text syntax', { timeout: 15000 });
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await setSetting('#txt-syntax', 'markdown');
  await doneSettings();
  await expect(window.locator('#syntax-label')).toHaveText('MARKDOWN');
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);

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
  await source().click();
  await window.keyboard.press(`${modifier}+End`);
  await window.evaluate((bytes) => {
    const file = new File([new Uint8Array(bytes)], 'clipboard.png', { type: 'image/png' });
    const data = new DataTransfer(); data.items.add(file);
    document.querySelector('#editor .cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [...png]);
  await expect(source()).toContainText('![Image](assets/');
  await waitSaved();
  expect((await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(1);

  // CDP uses native file-backed drops, so Electron's webUtils path authorization is exercised.
  const dropped = path.join(directory, 'dropped.png');
  await writeFile(dropped, png);
  const box = await window.locator('#editor').boundingBox();
  const cdp = await window.context().newCDPSession(window);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 60, y: box.y + 60, data: { items: [], files: [dropped], dragOperationsMask: 1 } });
  await expect.poll(async () => (await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(2);
  await waitSaved();

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
  await window.locator('#keep-both').click();
  await expect(window.locator('#conflict-banner')).toBeHidden();
  expect(await readFile(path.join(root, 'Renamed thought.md'), 'utf8')).toBe('The outside version');
  await expect(source()).toContainText('A local conflicting draft');

  // Opening the same title immediately after typing must open it rather than create it.
  await window.keyboard.press(`${modifier}+l`);
  await window.locator('#library-search').fill('Welcome.md');
  await window.locator('#library-search').press('Enter');
  await expect(window.locator('#note-title')).toHaveText('Welcome');
  await expect(window.locator('#message')).toBeHidden();

  // Folder changes flush the old buffer and preserve each folder's syntax setting.
  const secondRoot = path.join(directory, 'second-library');
  await mkdir(secondRoot);
  await writeFile(path.join(secondRoot, 'Second.md'), '# Second library');
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, secondRoot);
  await window.locator('#choose-library').click();
  await expect(window.locator('#note-title')).toHaveText('Second');
  expect((await window.evaluate(() => window.nvShift.initial())).settings.txtSyntax).toBe('plain');
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await window.locator('#choose-library').click();
  await expect(window.locator('#note-title')).toHaveText('Second');
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
  await openNote('Welcome');
  await window.evaluate(async () => {
    const { document } = await window.nvShift.initial();
    await window.nvShift.updateBuffer(document.id, document.source + '\nRenderer recovery marker', document.clientVersion + 1, document.revision);
  });
  // Exercise renderer-loss recovery without invoking an OS crash reporter.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).webContents.emit('render-process-gone', {}, { reason: 'crashed' }));
  await expect(source()).toContainText('Renderer recovery marker', { timeout: 15000 });
  await waitSaved();
  expect(errors).toEqual([]);
  console.log(`nvShift ${executablePath ? 'packaged' : 'development'} smoke passed: recursive search, keyboard creation, editing, Vim/:w/undo, all themes, .txt syntax, images, Mermaid, external saves/conflicts, rename, settings restart, sandbox, shortcut errors, background/relaunch.`);
} finally {
  if (app) await app.close().catch(() => { app.process().kill('SIGKILL'); });
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
