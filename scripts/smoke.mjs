// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm, symlink } from 'node:fs/promises';
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
  await expect(window.locator('#syntax-label')).toHaveText('PLAIN TEXT');
  await expect(window.locator('#content .plain-preview')).toContainText('* TODO Linked text');

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
  await window.locator('#view-editor').click();
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
  await window.keyboard.press('Shift+End');
  await setSetting('#filename-headings', true);
  await expect(window.locator('#note-title')).toHaveText('Headings');
  await expect(window.locator('#document-title')).toHaveText('Headings');
  await doneSettings();
  await expect(window.locator('#content h2')).toHaveText('Original heading 日本語');
  await source().focus();
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

  await openNote('syntax');
  await expect(window.locator('#syntax-label')).toHaveText('PLAIN TEXT');
  await expect(window.locator('#content .plain-preview')).toContainText('* TODO Text syntax');
  await listEnter('- Plain item', '- Plain item\n');
  await replaceSource('* TODO Text syntax\nPreserve café 日本語.\n');
  await waitSaved();
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await setSetting('#txt-syntax', 'org');
  await doneSettings();
  await expect(window.locator('#syntax-label')).toHaveText('ORG');
  await expect(window.locator('#note-title')).toHaveText('Text syntax');
  await expect(window.locator('#document-title')).toHaveText('Text syntax');
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await listEnter('- [x] Text item', '- [x] Text item\n- [ ] ');
  await replaceSource('* TODO Text syntax\nPreserve café 日本語.\n');
  await waitSaved();
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await openNote('LinkedText');
  await expect(window.locator('#syntax-label')).toHaveText('ORG');
  await expect(window.locator('#note-title')).toHaveText('Linked text');
  await expect(window.locator('#document-title')).toHaveText('Linked text');
  await expect(window.locator('#content .image-preview[data-loaded="true"]')).toHaveCount(1, { timeout: 15000 });
  await openNote('syntax');
  await setSetting('#txt-syntax', 'markdown');
  await doneSettings();
  await expect(window.locator('#syntax-label')).toHaveText('MARKDOWN');
  expect(await readFile(path.join(root, 'syntax.txt'))).toEqual(txtBytes);
  await listEnter('- Markdown item', '- Markdown item\n- ');
  await replaceSource('* TODO Text syntax\nPreserve café 日本語.\n');
  await waitSaved();
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
  expect((await readdir(path.join(root, 'assets'))).some((name) => /^clipboard-[a-f0-9-]+\.png$/.test(name))).toBe(true);
  expect((await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(1);

  // CDP uses native file-backed drops, so Electron's webUtils path authorization is exercised.
  const dropped = path.join(directory, 'dropped.png');
  await writeFile(dropped, png);
  const box = await window.locator('#editor').boundingBox();
  const cdp = await window.context().newCDPSession(window);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 60, y: box.y + 60, data: { items: [], files: [dropped], dragOperationsMask: 1 } });
  await expect.poll(async () => (await readdir(path.join(root, 'assets'))).filter((name) => name.endsWith('.png')).length).toBeGreaterThan(2);
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

  // Folder changes flush the old buffer and preserve each folder's syntax setting.
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
  console.log(`nvShift ${executablePath ? 'packaged' : 'development'} smoke passed: recursive search, content headings/unsaved titles/filename preference, keyboard creation, Org list continuation/Vim/:w/undo, all themes, .txt syntax, images, Mermaid, external saves/conflicts, rename, settings restart, sandbox, shortcut errors, background/relaunch.`);
} finally {
  if (app) await app.close().catch(() => { app.process().kill('SIGKILL'); });
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
