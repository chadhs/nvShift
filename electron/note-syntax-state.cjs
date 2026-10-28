// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MODES = new Set(['auto', 'plain', 'markdown', 'org']);
const key = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
function valid(entry) {
  return entry && typeof entry.path === 'string' && path.isAbsolute(entry.path) && entry.path.isWellFormed()
    && !entry.path.includes('\0') && typeof entry.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/u.test(entry.id)
    && MODES.has(entry.syntaxMode) && (entry.creationSyntax === null || ['plain', 'markdown', 'org'].includes(entry.creationSyntax));
}

/** Local-only choices are keyed by canonical file location, never by a linked display route. */
async function createNoteSyntaxState({ userData, root, writeAtomic }) {
  const name = createHash('sha256').update(root).digest('hex').slice(0, 24);
  const file = path.join(userData, 'note-syntax', `${name}.json`);
  let entries = new Map();
  try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.version !== 1 || saved.root !== root || !Array.isArray(saved.notes) || !saved.notes.every(valid)) throw new Error('Invalid note syntax preferences.');
    entries = new Map(saved.notes.map((entry) => [key(entry.path), entry]));
  } catch (error) { if (error.code !== 'ENOENT') throw new Error(`Note syntax preferences could not be loaded: ${error.message}`); }
  let writes = Promise.resolve();
  async function change(operation) {
    const next = writes.catch(() => {}).then(async () => {
      const updated = new Map(entries);
      operation(updated);
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeAtomic(file, Buffer.from(JSON.stringify({ version: 1, root, notes: [...updated.values()] }) + '\n'), { mode: 0o600 });
      entries = updated;
    });
    // A failed transaction leaves entries unchanged. Its caller receives the
    // error, while future note saves and shutdown can still drain the queue.
    writes = next.catch(() => {});
    return next;
  }
  return {
    get: (location) => { const value = entries.get(key(location)); return value ? { ...value } : null; },
    async set(location, state, previousPath) {
      const entry = { path: location, id: state.id, syntaxMode: state.syntaxMode, creationSyntax: state.creationSyntax ?? null };
      if (!valid(entry)) throw new Error('Invalid note syntax preferences.');
      await change((updated) => {
        if (previousPath) updated.delete(key(previousPath));
        updated.set(key(location), entry);
      });
    },
    flush: () => writes,
  };
}
module.exports = { createNoteSyntaxState };
