import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSettings, DEFAULTS } from '../electron/settings.cjs';

test('settings retain independent appearance choices and library-specific syntax across restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-settings-'));
  try {
    let settings = await createSettings(directory);
    assert.deepEqual(settings.snapshot(), DEFAULTS);
    await settings.setRoot('/notes/one');
    assert.equal(settings.snapshot().filenameHeadings, false);
    await settings.update({ light: 'solarized-light', dark: 'solarized-dark', mode: 'dark', vimMode: true, filenameHeadings: true, defaultExtension: 'txt', txtSyntax: 'org' });
    await settings.setRoot('/notes/two');
    assert.equal(settings.snapshot().txtSyntax, 'plain');
    await settings.update({ txtSyntax: 'markdown' });
    settings = await createSettings(directory);
    assert.equal(settings.lastLibrary(), '/notes/two');
    assert.equal(settings.snapshot('/notes/one').txtSyntax, 'org');
    assert.equal(settings.snapshot('/notes/one').defaultExtension, 'txt');
    assert.equal(settings.snapshot('/notes/two').txtSyntax, 'markdown');
    assert.equal(settings.snapshot().light, 'solarized-light');
    assert.equal(settings.snapshot().dark, 'solarized-dark');
    assert.equal(settings.snapshot().vimMode, true);
    assert.equal(settings.snapshot('/notes/one').filenameHeadings, true);
    assert.equal(settings.snapshot('/notes/two').filenameHeadings, true);
    await assert.rejects(settings.update({ filenameHeadings: 'true' }), /Invalid/);
    await assert.rejects(settings.update({ mode: 'surprise' }), /Invalid/);
    await assert.rejects(settings.update({ lastLibrary: '/unselected' }), /Unknown/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('malformed settings are preserved and defaults remain usable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-settings-'));
  try {
    await writeFile(path.join(directory, 'settings.json'), '{broken');
    const settings = await createSettings(directory);
    assert.deepEqual(settings.snapshot(), DEFAULTS);
    await settings.update({ mode: 'light' });
    assert.equal(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).globals.mode, 'light');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shortcut default migrates once while custom and disabled values survive restart', async () => {
  for (const previous of [undefined, 'CommandOrControl+Shift+Space', 'Control+Alt+K', '']) {
    const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-shortcut-migration-'));
    try {
      await writeFile(path.join(directory, 'settings.json'), JSON.stringify({ version: 1, globals: previous === undefined ? {} : { globalShortcut: previous }, libraries: { '/notes': { txtSyntax: 'org' } }, lastLibrary: '/notes' }));
      let settings = await createSettings(directory);
      const expected = previous === undefined || previous === 'CommandOrControl+Shift+Space' ? 'Control+Alt+Space' : previous;
      assert.equal(settings.snapshot().globalShortcut, expected);
      assert.equal(settings.snapshot().txtSyntax, 'org');
      assert.equal(JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf8')).version, 2);
      settings = await createSettings(directory);
      assert.equal(settings.snapshot().globalShortcut, expected);
      await settings.update({ globalShortcut: 'CommandOrControl+Shift+Space' });
      settings = await createSettings(directory);
      assert.equal(settings.snapshot().globalShortcut, 'CommandOrControl+Shift+Space');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test('failed settings persistence leaves the in-memory profile unchanged and later writes recover', async () => {
  const { mkdir, rename } = await import('node:fs/promises');
  const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-settings-rollback-'));
  try {
    const settings = await createSettings(directory);
    await settings.update({ globalShortcut: 'Control+Alt+K' });
    const file = path.join(directory, 'settings.json');
    await rename(file, `${file}.saved`);
    await mkdir(file);
    await assert.rejects(settings.update({ globalShortcut: 'Control+Alt+L', mode: 'dark' }));
    assert.equal(settings.snapshot().globalShortcut, 'Control+Alt+K');
    assert.equal(settings.snapshot().mode, 'system');
    await rm(file, { recursive: true });
    await rename(`${file}.saved`, file);
    await settings.update({ mode: 'dark' });
    assert.equal(settings.snapshot().globalShortcut, 'Control+Alt+K');
    assert.equal(settings.snapshot().mode, 'dark');
    const restored = await createSettings(directory);
    assert.equal(restored.snapshot().globalShortcut, 'Control+Alt+K');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('concurrent settings writes preserve all accepted changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nvshift-settings-queue-'));
  try {
    const settings = await createSettings(directory);
    await Promise.all([settings.update({ mode: 'dark' }), settings.update({ vimMode: true }), settings.update({ globalShortcut: '' })]);
    const restored = await createSettings(directory);
    assert.equal(restored.snapshot().mode, 'dark');
    assert.equal(restored.snapshot().vimMode, true);
    assert.equal(restored.snapshot().globalShortcut, '');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
