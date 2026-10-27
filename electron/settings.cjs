// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULTS = Object.freeze({
  mode: 'system', light: 'light', dark: 'dark', sansSerifHeadings: false,
  contentWidth: 'reading', vimMode: false, viewMode: 'editor',
  defaultExtension: 'md', txtSyntax: 'plain',
  globalShortcut: 'CommandOrControl+Shift+Space', sidebarWidth: 300, splitRatio: 0.5,
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
    if (['sansSerifHeadings', 'vimMode'].includes(key) && typeof value !== 'boolean') throw new Error(`Invalid setting: ${key}`);
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
/** Main-owned preferences. Library syntax preferences never modify note files. */
async function createSettings(userData) {
  const file = path.join(userData, 'settings.json');
  await fs.mkdir(userData, { recursive: true });
  let profile = { version: 1, globals: {}, libraries: {}, lastLibrary: null };
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    profile.globals = Object.fromEntries(Object.entries(recoverSettings(saved.globals)).filter(([key]) => !LIBRARY_KEYS.has(key)));
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
  function persist() {
    const contents = JSON.stringify(profile, null, 2) + '\n';
    const write = async () => {
      const temp = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
        await fs.rename(temp, file);
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    };
    writes = writes.catch(() => {}).then(write);
    return writes;
  }
  return {
    snapshot,
    lastLibrary: () => profile.lastLibrary,
    async setRoot(root) { profile.lastLibrary = root; await persist(); return snapshot(root); },
    async update(patch, root = profile.lastLibrary) {
      const valid = validate(patch);
      if (!root && Object.keys(valid).some((key) => LIBRARY_KEYS.has(key))) throw new Error('Choose a notes folder before changing its file settings.');
      for (const [key, value] of Object.entries(valid)) {
        if (LIBRARY_KEYS.has(key)) {
          if (!root) throw new Error('Choose a notes folder before changing its file settings.');
          (profile.libraries[root] ??= {})[key] = value;
        } else profile.globals[key] = value;
      }
      await persist();
      return snapshot(root);
    },
    flush: () => writes,
  };
}
module.exports = { createSettings, DEFAULTS, validate };
