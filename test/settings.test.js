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
