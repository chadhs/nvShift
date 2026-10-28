// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
import fs from 'node:fs/promises';
import path from 'node:path';
import { analyzeDocument } from './document-analysis.js';
import { visitTree } from './processing-limits.js';
import localPaths from '../electron/local-paths.cjs';
import pathSyntax from '../electron/path-syntax.cjs';

const key = (file) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const folded = (value) => value.normalize('NFC').toLocaleLowerCase();

/**
 * Cleanup references deliberately do not use preview descriptors or their
 * 100-image cap. Literal filename mentions also retain assets conservatively,
 * including paths in plain text, code examples, and unrecognized markup. A
 * .txt note is checked as all three syntaxes independently of its detected or
 * manually selected format. Detection is presentation, never deletion authority.
 */
export async function collectAssetReferences(doc, candidates, canonicalCache = new Map()) {
  if (typeof doc.source !== 'string' || !doc.source.isWellFormed() || doc.source.includes('\0')) throw new Error('Invalid source in asset reference scan.');
  const matches = new Set();
  const source = folded(doc.source);
  const byPath = new Map(candidates.map((asset) => [key(asset.path), asset.id]));
  for (const asset of candidates) {
    const encoded = encodeURIComponent(asset.name).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    if (source.includes(folded(asset.name)) || source.includes(folded(encoded))
      || (asset.aliases || []).some((alias) => source.includes(folded(alias)))) matches.add(asset.id);
  }
  const targets = new Set();
  const formats = /\.txt$/i.test(doc.path || doc.name || '') ? ['plain', 'markdown', 'org'] : [doc.format];
  for (const format of formats) {
    if (format === 'plain') {
      for (const line of doc.source.split(/\r?\n/)) {
        if (line.length <= 8192 && (/[\\/]|\bfile:|^\s*~|\.(?:png|jpe?g|gif|webp|svg)(?:\s|$)/i.test(line))) targets.add(line.trim());
        // Tokenize once rather than backtracking a path regex over long prose.
        for (const match of line.matchAll(/[^\s<>"']+/g)) {
          if (match[0].length <= 8192 && (/[\\/]|^file:|\.(?:png|jpe?g|gif|webp|svg)$/i.test(match[0]))) targets.add(match[0]);
        }
      }
    // A source without a possible link opener cannot contribute parsed targets.
    // Avoid constructing two large ASTs for plain .txt prose and recovery history.
    } else if ((format === 'org' && doc.source.includes('[['))
      || (format === 'markdown' && /[\[<]/.test(doc.source)) || formats.length === 1) visitTree(analyzeDocument({ ...doc, format }).tree, (node) => {
      if (format === 'org' && node.type === 'link') {
        const raw = doc.source.slice(node.position.start.offset, node.position.end.offset);
        const target = /^\[\[([^\]\r\n]+)/.exec(raw)?.[1];
        if (target) targets.add(target.split('::')[0]);
      } else if (format === 'markdown' && ['image', 'link', 'definition'].includes(node.type) && node.url) targets.add(node.url);
    });
  }
  for (const target of targets) {
    if (target.length > 8192) continue;
    if (/^(?:https?:|mailto:|data:)/i.test(target) || target.startsWith('#')) continue;
    if (pathSyntax.hasScheme(target) && !pathSyntax.isDriveAbsolute(target) && !/^file:/i.test(target)) continue;
    let file;
    try { file = localPaths.resolveLocalPath(doc.path, target); }
    catch { continue; } // Unsupported paths cannot authorize local file access.
    try {
      let canonical = canonicalCache.get(file);
      if (!canonical) { canonical = await fs.realpath(file); canonicalCache.set(file, canonical); }
      const id = byPath.get(key(canonical));
      if (id) matches.add(id);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) throw new Error(`A local reference could not be checked: ${error.message}`);
    }
  }
  return [...matches];
}
