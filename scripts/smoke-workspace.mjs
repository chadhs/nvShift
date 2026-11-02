// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import { _electron as electron, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

expect.setDefaultTimeout?.(12000);
const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-workspace-smoke-'));
const root = path.join(directory, 'notes'), profile = path.join(directory, 'profile');
await mkdir(path.join(root, 'assets'), { recursive: true });
await mkdir(profile);
await mkdir('test-results', { recursive: true });
await writeFile(path.join(profile, 'settings.json'), JSON.stringify({ version: 2, globals: { globalShortcut: '' }, libraries: {}, lastLibrary: null }));
await writeFile(path.join(root, 'assets', 'pixel.png'), await readFile('build/icons/16x16.png'));
const names = ['Alpha', 'Beta', 'Gamma', 'Delta', ...Array.from({ length: 8 }, (_, index) => `Long document ${index + 1} with a filename that must fit without growing the toolbar`)];
for (const [index, name] of names.entries()) await writeFile(path.join(root, `${name}.md`), `# ${name}\n\nDocument body ${index}.\n\n![Image](assets/pixel.png)\n\n\`\`\`mermaid\nflowchart LR\nNode${index}-->Done\n\`\`\`\n`);
const executablePath = process.env.NVSHIFT_EXECUTABLE;
const env = { ...process.env, NVSHIFT_SMOKE_LARGE_WINDOWS: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const args = [...(executablePath ? [] : ['.']), `--library=${root}`, `--user-data-dir=${profile}`];
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
let app, window;
const errors = [];
const state = () => window ? window.evaluate(() => window.nvShift.initial()) : Promise.resolve({});
const group = (id) => window.locator(`.document-group[data-group-id="${id}"]`);
const editor = (id) => group(id).locator('.cm-content');
const field = () => window.locator('#library-search');
const tabCount = (value) => value.workspace.groups.reduce((total, item) => total + item.tabs.length, 0);
const summary = (value) => ({ layout: value.workspace.layout, focusedGroupId: value.workspace.focusedGroupId, groups: value.workspace.groups.map(({ id, activeTabId, viewMode, tabs, displayedDocumentId }) => ({ id, activeTabId, viewMode, tabs, displayedDocumentId })) });
async function launch() {
  app = await electron.launch({ executablePath, args, env, chromiumSandbox: true, timeout: 30000 });
  window = await app.firstWindow();
  window.on('pageerror', (error) => errors.push(error.message));
  await resize(1280);
  await expect(field()).toBeEnabled({ timeout: 20000 });
  await expect.poll(async () => Boolean((await state()).workspace)).toBe(true);
}
async function command(type, extra = {}) {
  const result = await window.evaluate(async ({ type, extra }) => {
    const before = await window.nvShift.initial();
    return window.nvShift.workspace({ type, generation: before.workspace.generation, ...extra });
  }, { type, extra });
  await expect.poll(async () => (await state()).workspace.revision).toBeGreaterThanOrEqual(result.workspace.revision);
  await expect(window.locator('.document-group')).toHaveCount(result.workspace.groups.length);
  await expect(window.locator('#document-tabs [role=tab]')).toHaveCount(tabCount(result));
  return result;
}
async function idFor(name) {
  return window.evaluate(async (name) => (await window.nvShift.search(name)).results.find((doc) => doc.name === `${name}.md`)?.id, name);
}
async function search(name) {
  await field().fill(name);
  const id = await idFor(name);
  expect(id).toBeTruthy();
  await expect(window.locator(`#results .result-item[data-id="${id}"]`)).toBeVisible();
  return id;
}
async function open(name) {
  const id = await search(name);
  await window.locator(`#results .result-item[data-id="${id}"]`).click();
  await expect.poll(async () => (await state()).document?.id).toBe(id);
  return id;
}
async function append(groupId, text) {
  await editor(groupId).focus();
  await window.keyboard.press(`${modifier}+End`);
  await window.keyboard.insertText(text);
}
async function waitSaved() {
  await expect.poll(async () => Object.values((await state()).documents).every((doc) => doc.status === 'saved'), { timeout: 15000 }).toBe(true);
}
async function resize(width) {
  // Resize native content so titlebar overlay geometry matches the CSS viewport.
  // The test-only launch flag permits large windows on smaller macOS CI screens.
  await app.evaluate(({ BrowserWindow }, width) => {
    BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).setContentSize(width, 900);
  }, width);
  await expect.poll(() => window.evaluate(() => innerWidth)).toBe(width);
}
async function layout() {
  return window.evaluate(() => {
    const rect = (element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }; };
    return { toolbar: rect(document.querySelector('.toolbar')), tabs: rect(document.querySelector('#document-tabs')), actions: rect(document.querySelector('.toolbar-actions')),
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      groups: [...document.querySelectorAll('.document-group')].map((element) => ({ ...rect(element), contentY: rect(element.querySelector('.panes')).y })) };
  });
}
try {
  await launch();
  await resize(1280);
  const alpha = await open('Alpha');
  await expect(window.locator('#document-tabs')).toBeHidden();
  const baseline = await layout(); expect(baseline.toolbar.height).toBe(64);
  const help = () => window.locator('#keyboard-help-dialog');
  await expect(window.locator('#toggle-documents .layout-label')).toBeVisible();
  expect(await window.locator('#settings-button').evaluate((node) => node.previousElementSibling.id)).toBe('keyboard-help-button');
  await expect(window.locator('#toggle-documents')).toHaveAttribute('title', /Backslash/);
  for (const width of [2000, 1280, 1100, 1051, 1050, 800, 760]) {
    await resize(width);
    await expect(window.locator('#keyboard-help-button')).toBeVisible();
    if (width > 1050) await expect(window.locator('#toggle-documents .layout-label')).toBeVisible();
    else await expect(window.locator('#toggle-documents .layout-label')).toBeHidden();
    const chrome = await window.evaluate(() => {
      const toolbar = document.querySelector('.toolbar'), actions = document.querySelector('.toolbar-actions'), brand = document.querySelector('.brand');
      return { height: toolbar.getBoundingClientRect().height, right: actions.getBoundingClientRect().right, availableRight: innerWidth - parseFloat(getComputedStyle(toolbar).paddingRight), brandRight: Math.max(...[brand, ...brand.children].map((node) => node.getBoundingClientRect().right)), actionsLeft: actions.getBoundingClientRect().left };
    });
    expect(chrome.height).toBe(64); expect(chrome.right).toBeLessThanOrEqual(chrome.availableRight + 1); expect(chrome.brandRight).toBeLessThanOrEqual(chrome.actionsLeft);
  }
  await resize(1280);
  const originalGroup = (await state()).workspace.focusedGroupId;
  await editor(originalGroup).focus(); await window.keyboard.press(`${modifier}+Home`);
  await window.keyboard.press('Shift+ArrowRight'); await window.keyboard.press('Shift+ArrowRight');
  const selectionBeforeHelp = await window.evaluate(() => getSelection()?.toString());
  await window.locator('#keyboard-help-button').click(); await expect(help()).toBeVisible();
  await window.screenshot({ path: `test-results/keyboard-help-${executablePath ? 'packaged' : 'desktop'}.png` });
  for (const name of ['Search and notes', 'Tabs and panes', 'Editing and views', 'Quick access']) await expect(help().getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(window.locator('#help-global-shortcut')).toHaveText('Disabled');
  await window.keyboard.press('Tab');
  expect(await help().evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  await window.keyboard.press('Escape'); await expect(help()).toBeHidden();
  await expect(editor(originalGroup)).toBeFocused();
  await expect.poll(() => window.evaluate(() => getSelection()?.toString())).toBe(selectionBeforeHelp);
  expect((await state()).workspace.focusedGroupId).toBe(originalGroup);
  await window.keyboard.press(`${modifier}+End`); await window.keyboard.press('?');
  await expect.poll(async () => (await state()).document.source.endsWith('?')).toBe(true); await expect(help()).toBeHidden();
  await window.keyboard.press(`${modifier}+z`);
  await field().fill('Alpha'); await field().press('?'); await expect(field()).toHaveValue('Alpha?'); await expect(help()).toBeHidden();
  await field().fill('Alpha');
  await window.locator('#keyboard-help-button').focus(); await window.keyboard.press('?'); await expect(help()).toBeVisible();
  await window.locator('#close-keyboard-help').click(); await expect(help()).toBeHidden();
  await resize(800); await expect(window.locator('#keyboard-help-button')).toBeVisible();
  await window.locator('#toolbar-more').click();
  await window.locator('#workspace-menu').getByRole('menuitem', { name: 'Keyboard shortcuts' }).click(); await expect(help()).toBeVisible();
  await window.keyboard.press('Escape'); await resize(1280);
  // The configured global binding and its status update while help remains open.
  await window.locator('#keyboard-help-button').click();
  await app.evaluate(({ globalShortcut }) => { globalThis.helpOriginalRegister = globalShortcut.register; globalShortcut.register = () => true; });
  try {
    await window.evaluate(() => window.nvShift.updateSettings({ globalShortcut: 'Control+Alt+Shift+F12' }));
    await expect(window.locator('#help-global-shortcut')).toContainText('F12'); await expect(window.locator('#help-global-status')).toContainText('Available');
    await window.evaluate(() => window.nvShift.updateSettings({ globalShortcut: '' })); await expect(window.locator('#help-global-shortcut')).toHaveText('Disabled');
  } finally { await app.evaluate(({ globalShortcut }) => { globalShortcut.register = globalThis.helpOriginalRegister; delete globalThis.helpOriginalRegister; }); }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).webContents.send('app:state', { shortcut: { accelerator: 'Control+Alt+Space', registered: false, status: 'unavailable', error: 'Shortcut unavailable for this fixture.' } }));
  await expect(window.locator('#help-global-status')).toContainText('Shortcut unavailable');
  await window.keyboard.press('Escape');
  await window.locator('#rename-note').click(); await window.locator('#rename-input').fill('Question'); await window.locator('#rename-input').press('?');
  await expect(window.locator('#rename-input')).toHaveValue('Question?'); await expect(help()).toBeHidden(); await window.locator('#rename-cancel').click();
  await window.evaluate(() => window.nvShift.updateSettings({ vimMode: true }));
  await editor(originalGroup).focus(); await window.keyboard.press('Escape'); await window.keyboard.press('?');
  await expect(group(originalGroup).locator('.cm-vim-panel input')).toBeVisible(); await expect(help()).toBeHidden(); await window.keyboard.press('Escape');
  await window.evaluate(() => window.nvShift.updateSettings({ vimMode: false }));
  await window.locator('#settings-button').click(); await window.locator('#record-shortcut').click(); await window.keyboard.press('?');
  await expect(help()).toBeHidden(); await expect(window.locator('#settings-dialog')).toBeVisible(); await window.locator('#settings-done').click();

  const menu = () => window.locator('#workspace-menu');
  const betaResultId = await search('Beta');
  const betaResult = window.locator(`#results .result-item[data-id="${betaResultId}"]`);
  // A full secondary-click gesture must leave the menu open after release.
  await betaResult.click({ button: 'right' });
  await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(menu()).toBeVisible();
  // A search refresh replaces the invoking DOM node, but not the captured action.
  await window.evaluate(() => { const field = document.querySelector('#library-search'); field.value = 'Gamma'; field.dispatchEvent(new Event('input', { bubbles: true })); });
  await expect(window.locator('#results')).toContainText('Gamma');
  await expect(menu()).toBeVisible();
  await menu().getByRole('menuitem', { name: 'Open in new tab' }).click();
  await expect.poll(async () => (await state()).document?.id).toBe(betaResultId);
  expect((await state()).workspace.groups[0].tabs.map((tab) => tab.documentId)).toEqual([alpha, betaResultId]);
  await expect(menu()).toBeHidden();
  await window.keyboard.press(`${modifier}+w`);
  await expect.poll(async () => (await state()).document?.id).toBe(alpha);
  await search('Beta'); await field().focus();
  await window.keyboard.press('Shift+F10'); await expect(menu()).toBeVisible();
  await window.keyboard.press('Escape'); await expect(menu()).toBeHidden(); await expect(field()).toBeFocused();
  await betaResult.click({ button: 'right' }); await field().click(); await expect(menu()).toBeHidden();
  await betaResult.click({ button: 'right' });
  await betaResult.click({ button: 'right' }); await expect(menu().getByRole('menuitem')).toHaveCount(1);
  await window.evaluate(() => window.dispatchEvent(new Event('blur'))); await expect(menu()).toBeHidden();
  const edge = await window.evaluate(() => ({ clientX: innerWidth - 1, clientY: innerHeight - 1 }));
  await betaResult.dispatchEvent('contextmenu', edge); await expect(menu()).toBeVisible();
  const menuBox = await menu().boundingBox(), viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  expect(menuBox.x).toBeGreaterThanOrEqual(0); expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width); expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
  await window.keyboard.press('Escape');
  await command('focusGroup'); await editor((await state()).workspace.focusedGroupId).focus();
  await window.keyboard.press(`${modifier}+t`);
  await expect.poll(async () => tabCount(await state())).toBe(2);
  await expect(field()).toBeFocused();
  const beta = await open('Beta');
  expect(tabCount(await state())).toBe(2);
  await expect.poll(async () => window.locator('.tab-overflow:visible').count()).toBe(0);
  const alphaTabButton = window.locator('#document-tabs [role=tab]').first();
  await alphaTabButton.click({ button: 'right' }); await expect(menu()).toBeVisible();
  await expect(menu().getByRole('menuitem', { name: 'Move to other pane' })).toBeVisible();
  await window.keyboard.press('Escape'); await expect(menu()).toBeHidden();
  const gamma = await open('Gamma');
  expect(tabCount(await state())).toBe(2);
  expect(Object.values((await state()).documents).some((doc) => doc.id === alpha)).toBe(true);
  expect((await layout()).groups[0].contentY).toBe(baseline.groups[0].contentY);

  // Arrow browsing displays the result without losing the original tab on an explicit new-tab open.
  const delta = await search('Delta');
  await field().press('ArrowDown');
  await expect.poll(async () => (await state()).workspace.groups[0].browsing).toBe(true);
  await expect.poll(async () => (await state()).document?.id).toBe(delta);
  await field().press(`${modifier}+Shift+Enter`);
  await expect.poll(async () => tabCount(await state())).toBe(3);
  expect((await state()).workspace.groups[0].tabs.map((tab) => tab.documentId)).toEqual([alpha, gamma, delta]);
  await window.keyboard.press(`${modifier}+w`);
  await expect.poll(async () => tabCount(await state())).toBe(2);
  await expect.poll(async () => (await state()).document?.id).toBe(gamma);
  await search('Delta'); await field().press('ArrowDown');
  await expect.poll(async () => (await state()).document?.id).toBe(delta);
  await field().press('Escape');
  await expect.poll(async () => (await state()).document?.id).toBe(gamma);
  await open('Alpha'); expect(tabCount(await state())).toBe(2);
  await window.keyboard.press('Control+Tab');
  await expect.poll(async () => (await state()).document?.id).toBe(gamma);
  await window.keyboard.press('Control+Shift+Tab');
  await expect.poll(async () => (await state()).document?.id).toBe(alpha);

  await window.locator('#toggle-documents').click();
  await expect.poll(async () => (await state()).workspace.layout).toBe('columns');
  let value = await state();
  const leftId = value.workspace.groups[0].id, rightId = value.workspace.groups[1].id;
  expect(value.workspace.focusedGroupId).toBe(rightId);
  await expect(window.locator('#toggle-documents .layout-label')).toBeHidden();
  await expect(group(rightId).getByText('Search for a reference note', { exact: true })).toBeVisible();
  await expect(group(rightId).getByText(/Switch panes with/)).toBeVisible();
  await expect(window.locator('.tab-group-label')).toHaveCount(0);
  expect(value.workspace.groups[0].displayedDocumentId).toBe(alpha);
  expect(value.workspace.groups[1].viewMode).toBe('editor');
  await expect(field()).toBeFocused();
  await open('Beta');
  expect((await state()).workspace.groups[0].displayedDocumentId).toBe(alpha);
  // The context action keeps its original pane even if main focus changes while open.
  await command('focusGroup', { groupId: leftId });
  const contextDelta = await search('Delta');
  await window.locator(`#results .result-item[data-id="${contextDelta}"]`).click({ button: 'right' });
  await expect(menu()).toBeVisible();
  await command('focusGroup', { groupId: rightId });
  await menu().getByRole('menuitem', { name: 'Open in new tab' }).click();
  await expect.poll(async () => (await state()).workspace.groups[0].displayedDocumentId).toBe(contextDelta);
  expect((await state()).workspace.groups[1].displayedDocumentId).toBe(beta);
  await window.keyboard.press(`${modifier}+w`);
  await expect.poll(async () => (await state()).workspace.groups[0].displayedDocumentId).toBe(gamma);
  await command('open', { groupId: leftId, id: alpha });
  await command('setView', { groupId: rightId, mode: 'editor' });
  await append(rightId, 'Right pane marker.');
  await expect.poll(async () => (await state()).documents[beta]?.source.includes('Right pane marker.')).toBe(true);
  const rightSource = (await state()).documents[beta].source;
  await window.locator('#keyboard-help-button').click(); await expect(help()).toBeVisible();
  await window.keyboard.press(`${modifier}+1`);
  expect((await state()).workspace.focusedGroupId).toBe(rightId);
  await window.keyboard.press('Escape'); await expect(editor(rightId)).toBeFocused();
  expect((await state()).workspace.focusedGroupId).toBe(rightId);
  await window.keyboard.press(`${modifier}+1`);
  await expect.poll(async () => (await state()).workspace.focusedGroupId).toBe(leftId);
  await append(leftId, 'Left pane marker.');
  await expect.poll(async () => (await state()).documents[alpha]?.source.includes('Left pane marker.')).toBe(true);
  expect((await state()).documents[beta].source).toBe(rightSource);
  await window.keyboard.press(`${modifier}+z`);
  await expect.poll(async () => (await state()).documents[alpha]?.source.includes('Left pane marker.')).toBe(false);
  await append(leftId, 'Move history marker.');
  await expect.poll(async () => (await state()).documents[alpha]?.source.includes('Move history marker.')).toBe(true);
  value = await state();
  const alphaTab = value.workspace.groups[0].tabs.find((tab) => tab.documentId === alpha);
  await command('moveTab', { groupId: leftId, tabId: alphaTab.id });
  await expect.poll(async () => (await state()).workspace.groups[1].displayedDocumentId).toBe(alpha);
  await editor(rightId).focus(); await window.keyboard.press(`${modifier}+z`);
  await expect.poll(async () => (await state()).documents[alpha]?.source.includes('Move history marker.')).toBe(false);
  expect((await state()).documents[beta].source).toBe(rightSource);

  await command('setView', { groupId: leftId, mode: 'preview' });
  await command('setView', { groupId: rightId, mode: 'preview' });
  for (const paneId of [leftId, rightId]) {
    await expect(group(paneId).locator('.image-preview img[src^="data:image/"]')).toHaveCount(1, { timeout: 20000 });
    await expect(group(paneId).locator('.diagram[data-rendered="true"]')).toHaveCount(1, { timeout: 20000 });
  }
  await expect(window.locator('#view-split')).toBeDisabled();
  expect((await layout()).groups[0].contentY).toBe(baseline.groups[0].contentY);

  // Long filenames and overflowing tabs must use horizontal space, never another toolbar row.
  for (const name of names.slice(4)) await command('open', { groupId: leftId, id: await idFor(name), disposition: 'new-tab' });
  await window.evaluate((id) => window.nvShift.rename(id, 'Reference document with a long name'), beta);
  for (const width of [2000, 1280, 1050, 800, 760]) {
    await resize(width);
    await window.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const boxes = await layout();
    expect(boxes.toolbar.height).toBe(64);
    await expect(window.locator('#keyboard-help-button')).toBeVisible();
    await expect(window.locator('#toggle-documents .layout-label')).toBeHidden();
    const helpBox = await window.locator('#keyboard-help-button').boundingBox(), settingsBox = await window.locator('#settings-button').boundingBox();
    expect(helpBox.x + helpBox.width).toBeLessThanOrEqual(settingsBox.x + 1);
    if (width === 2000) await expect(window.locator('.tab-overflow').last()).toBeHidden();
    if (width === 760) await expect(window.locator('.tab-overflow').last()).toBeVisible();
    for (const list of await window.locator('.tab-list').all()) {
      const strip = await list.boundingBox(), tab = await list.locator('[aria-selected=true]').locator('..').boundingBox();
      expect(tab.x).toBeGreaterThanOrEqual(strip.x - 1); expect(tab.x + tab.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
    }
    expect(boxes.groups).toHaveLength(2);
    expect(boxes.groups[0].width).toBeGreaterThanOrEqual(239);
    expect(boxes.groups[1].width).toBeGreaterThanOrEqual(239);
    expect(Math.abs(boxes.groups[0].y - boxes.groups[1].y)).toBeLessThan(1);
    expect(boxes.groups[0].right).toBeLessThanOrEqual(boxes.groups[1].x + 1);
    expect(boxes.tabs.right).toBeLessThanOrEqual(boxes.actions.x + 1);
    expect(boxes.actions.bottom).toBeLessThanOrEqual(boxes.toolbar.bottom + 1);
    expect(boxes.scrollWidth).toBeLessThanOrEqual(boxes.width + 1);
    await window.screenshot({ path: `test-results/workspace-${executablePath ? 'packaged' : 'desktop'}-${width}.png` });
  }
  await resize(1280);
  await window.evaluate((id) => window.nvShift.rename(id, 'Beta'), beta);
  await expect(window.locator('.tab-overflow').first()).toBeVisible();
  await expect(window.locator('.tab-overflow').last()).toBeHidden();
  await expect(window.locator('.tab-overflow').first()).toHaveText('⋯');
  await window.locator('.tab-overflow').first().click();
  await expect(window.locator('#workspace-menu')).toBeVisible();
  await expect(window.locator('#workspace-menu button')).toHaveCount((await state()).workspace.groups[0].tabs.length);
  await window.keyboard.press('Escape');
  await waitSaved();
  await expect(window.locator('.tab-overflow').last()).toBeHidden();
  const beforeHide = summary(await state());
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).close());
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(false);
  await app.evaluate(({ BrowserWindow }) => { const main = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')); main.show(); main.focus(); });
  expect(summary(await state())).toEqual(beforeHide);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).webContents.emit('render-process-gone', {}, { reason: 'crashed' }));
  await expect(field()).toBeEnabled({ timeout: 20000 });
  await expect.poll(async () => summary(await state())).toEqual(beforeHide);

  // Turning the split off preserves every tab and the selected document.
  const countBeforeMerge = tabCount(await state());
  const documentBeforeMerge = (await state()).document.id;
  await window.locator('#toggle-documents').click();
  await expect.poll(async () => (await state()).workspace.layout).toBe('single');
  expect(tabCount(await state())).toBe(countBeforeMerge);
  await expect(window.locator('#toggle-documents .layout-label')).toBeVisible();
  expect((await state()).document.id).toBe(documentBeforeMerge);
  await app.close(); app = null;
  await launch();
  await expect.poll(async () => (await state()).workspace.layout).toBe('single');
  expect(tabCount(await state())).toBe(1);
  await expect(window.locator('.tab-overflow:visible')).toHaveCount(0);
  await window.keyboard.press(`${modifier}+w`);
  await expect.poll(async () => tabCount(await state())).toBe(0);
  await expect(window.locator('#welcome')).toBeVisible();
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().endsWith('/index.html')).isVisible())).toBe(true);
  expect(errors).toEqual([]);
  console.log(`nvShift ${executablePath ? 'packaged' : 'development'} workspace smoke passed: explicit tabs/replacement/browse checkpoint/cancel/dedup, tab shortcuts, independent editing and moving undo history, concurrent preview images/diagrams, 64px toolbar at five widths, overflow, hide/reload preservation, merge, fresh restart, and last-tab close.`);
} catch (error) {
  console.error('Workspace smoke failure:', JSON.stringify({ errors, state: await state().catch((failure) => ({ error: failure.message })), message: await window?.locator('#message-text').textContent().catch(() => null) }));
  await window?.screenshot({ path: `test-results/workspace-${executablePath ? 'packaged' : 'desktop'}-failure.png`, timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close().catch(() => { app.process().kill('SIGKILL'); });
  await rm(directory, { recursive: true, force: true });
}
