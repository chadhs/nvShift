// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULTS = Object.freeze({
  mode: 'system', light: 'light', dark: 'dark', sansSerifHeadings: false,
  contentWidth: 'reading', filenameHeadings: false, vimMode: false, viewMode: 'editor',
  defaultExtension: 'md', txtSyntax: 'plain',
  globalShortcut: 'Control+Alt+Space', sidebarWidth: 300, splitRatio: 0.5,
});
const LIBRARY_KEYS = new Set(['defaultExtension', 'txtSyntax']);
const choices = {
  mode: ['system', 'light', 'dark'], light: ['light', 'solarized-light'],
  dark: ['dark', 'solarized-dark'], contentWidth: ['reading', 'full'],
  viewMode: ['editor', 'split', 'preview'], defaultExtension: ['md', 'markdown', 'org', 'txt'],
  txtSyntax: ['plain', 'markdown', 'org'],
};
function validate(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
  const result = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown setting: ${key}`);
    if (choices[key] && !choices[key].includes(value)) throw new Error(`Invalid setting: ${key}`);
    if (['sansSerifHeadings', 'filenameHeadings', 'vimMode'].includes(key) && typeof value !== 'boolean') throw new Error(`Invalid setting: ${key}`);
    if (key === 'globalShortcut' && (typeof value !== 'string' || value.length > 100 || /[\r\n\0]/.test(value))) throw new Error('Invalid global shortcut.');
    if (key === 'sidebarWidth' && (!Number.isFinite(value) || value < 200 || value > 600)) throw new Error('Invalid sidebar width.');
    if (key === 'splitRatio' && (!Number.isFinite(value) || value < 0.2 || value > 0.8)) throw new Error('Invalid split ratio.');
    result[key] = value;
  }
  return result;
}
function recoverSettings(value) {
  const result = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, item] of Object.entries(value)) {
    try { Object.assign(result, validate({ [key]: item })); } catch { /* Ignore invalid old preferences. */ }
  }
  return result;
}
/** Main-owned preferences. The existing txtSyntax key now seeds only newly
 * created .txt notes, so v1 profiles migrate without losing their chosen default.
 * Existing notes resolve their own syntax and are never rewritten by settings. */
async function createSettings(userData) {
  const file = path.join(userData, 'settings.json');
  await fs.mkdir(userData, { recursive: true });
  let profile = { version: 2, globals: {}, libraries: {}, lastLibrary: null };
  let migrated = false;
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    profile.globals = Object.fromEntries(Object.entries(recoverSettings(saved.globals)).filter(([key]) => !LIBRARY_KEYS.has(key)));
    if (!(saved.version >= 2)) {
      if (profile.globals.globalShortcut === 'CommandOrControl+Shift+Space') profile.globals.globalShortcut = DEFAULTS.globalShortcut;
      migrated = true;
    }
    if (typeof saved.lastLibrary === 'string') profile.lastLibrary = saved.lastLibrary;
    if (saved.libraries && typeof saved.libraries === 'object') {
      for (const [root, entry] of Object.entries(saved.libraries)) profile.libraries[root] = Object.fromEntries(Object.entries(recoverSettings(entry)).filter(([key]) => LIBRARY_KEYS.has(key)));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') await fs.copyFile(file, `${file}.unreadable-${Date.now()}`).catch(() => {});
  }
  let writes = Promise.resolve();
  function snapshot(root = profile.lastLibrary) {
    return { ...DEFAULTS, ...profile.globals, ...(root ? profile.libraries[root] : {}) };
  }
  async function persist(next) {
    const contents = JSON.stringify(next, null, 2) + '\n';
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }
  // Commit in memory only after the replacement file is safely in place.
  function change(mutator, root) {
    const write = async () => {
      const next = structuredClone(profile);
      mutator(next);
      await persist(next);
      profile = next;
      return snapshot(root);
    };
    writes = writes.catch(() => {}).then(write);
    return writes;
  }
  if (migrated) await persist(profile);

  return {
    snapshot,
    lastLibrary: () => profile.lastLibrary,
    setRoot(root) { return change((next) => { next.lastLibrary = root; }, root); },
    async update(patch, root = profile.lastLibrary) {
      const valid = validate(patch);
      if (!root && Object.keys(valid).some((key) => LIBRARY_KEYS.has(key))) throw new Error('Choose a notes folder before changing its file settings.');
      return change((next) => {
        for (const [key, value] of Object.entries(valid)) {
          if (LIBRARY_KEYS.has(key)) (next.libraries[root] ??= {})[key] = value;
          else next.globals[key] = value;
        }
      }, root);
    },
    flush: () => writes,
  };
}
module.exports = { createSettings, DEFAULTS, validate };
