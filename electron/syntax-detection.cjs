// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const MAX_SYNTAX_BYTES = 16 * 1024 * 1024;

/**
 * A deliberately conservative content classifier, independent of renderers.
 * Shared list/emphasis syntax is insufficient evidence for either language.
 * This scanner never changes, parses, or truncates the original document.
 * @param {string} source
 * @returns {{format: 'plain'|'markdown'|'org', reason: 'ambiguous'|'conflicting'|'markdown'|'org'}}
 */
function detectSyntax(source) {
  if (typeof source !== 'string' || !source.isWellFormed() || source.includes('\0')) throw new Error('Syntax detection requires valid UTF-8 text.');
  if (source.length > MAX_SYNTAX_BYTES || new TextEncoder().encode(source).byteLength > MAX_SYNTAX_BYTES) throw new Error('Syntax detection supports notes no larger than 16 MiB.');
  let markdown = false;
  let org = false;
  let block = null;
  let inlineEnd = -1;
  const codeRuns = new Map();
  const runCursors = new Map();
  // Index exact-length backtick runs once. An unmatched delimiter remains text;
  // repeated indexOf searches over a long document would have quadratic cost.
  for (let at = 0; at < source.length;) {
    if (source[at] === '\\') { at += 2; continue; }
    if (source[at] !== '`') { at++; continue; }
    const start = at;
    while (source[at] === '`') at++;
    const length = at - start;
    if (!codeRuns.has(length)) codeRuns.set(length, []);
    codeRuns.get(length).push(start);
  }
  let offset = 0;
  while (offset <= source.length) {
    let end = source.indexOf('\n', offset);
    if (end < 0) end = source.length;
    const line = source.slice(offset, end).replace(/\r$/u, '');
    if (block?.kind === 'markdown') {
      const close = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
      if (close && close[1][0] === block.marker && close[1].length >= block.length) block = null;
    } else if (block?.kind === 'org') {
      const close = /^[ \t]*#\+end_([a-z][\w-]*)[ \t]*$/iu.exec(line);
      if (close && close[1].toLowerCase() === block.name) block = null;
    } else {
      // Four-space/tab indentation can be a Markdown literal code block. Org
      // headings themselves are column-zero; prefer no guess for indented text.
      const indented = /^(?: {4}|\t)/u.test(line);
      const fence = !indented && offset > inlineEnd && /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
      const begin = !indented && offset > inlineEnd && /^[ \t]*#\+begin_([a-z][\w-]*)(?:[ \t]|$)/iu.exec(line);
      if (fence && (fence[1][0] !== '`' || !fence[2].includes('`'))) {
        markdown = true;
        block = { kind: 'markdown', marker: fence[1][0], length: fence[1].length };
      } else if (begin) {
        org = true;
        block = { kind: 'org', name: begin[1].toLowerCase() };
      } else if (!indented) {
        let through = 0;
        const pieces = [];
        const mask = (start, finish) => { pieces.push(line.slice(through, start), ' '.repeat(finish - start)); through = finish; };
        const orgClosings = new Map();
        const orgCursors = new Map();
        // Pre-index possible Org literal closers once as well. Repeatedly
        // searching unsuccessful '=text ' openers would otherwise rescan the
        // same suffix for every delimiter in a long line.
        if (line.includes('=') || line.includes('~')) for (let at = 0; at < line.length; at++) {
          if (line[at] === '\\') { at++; continue; }
          const marker = line[at];
          if ((marker === '=' || marker === '~') && at && !/\s/u.test(line[at - 1]) && (!line[at + 1] || /[\s.,;:!?\])}]/u.test(line[at + 1]))) {
            if (!orgClosings.has(marker)) orgClosings.set(marker, []);
            orgClosings.get(marker).push(at);
          }
        }
        for (let at = 0; at < line.length;) {
          const absolute = offset + at;
          if (absolute <= inlineEnd) { const finish = Math.min(line.length, inlineEnd - offset + 1); mask(at, finish); at = finish; continue; }
          const character = line[at];
          if (character === '\\') { const finish = Math.min(at + 2, line.length); mask(at, finish); at = finish; continue; }
          if (character === '`') {
            let after = at + 1;
            while (line[after] === '`') after++;
            const positions = codeRuns.get(after - at) || [];
            let cursor = runCursors.get(after - at) || 0;
            while (cursor < positions.length && positions[cursor] <= absolute) cursor++;
            runCursors.set(after - at, cursor);
            if (cursor < positions.length) {
              const closingEnd = positions[cursor] + after - at;
              inlineEnd = closingEnd - 1;
              const finish = Math.min(line.length, closingEnd - offset); mask(at, finish); at = finish; continue;
            }
            at = after; continue;
          }
          // Org verbatim/code delimiters require a non-space body and a
          // boundary. These can contain Markdown or Org syntax examples.
          if ((character === '=' || character === '~') && (at === 0 || /[\s([{]/u.test(line[at - 1])) && line[at + 1] && !/\s/u.test(line[at + 1])) {
            const positions = orgClosings.get(character) || [];
            let cursor = orgCursors.get(character) || 0;
            while (cursor < positions.length && positions[cursor] < at + 2) cursor++;
            orgCursors.set(character, cursor);
            if (cursor < positions.length) { const close = positions[cursor]; mask(at, close + 1); at = close + 1; continue; }
          }
          at++;
        }
        const visible = pieces.length ? pieces.join('') + line.slice(through) : line;
        if (/^ {0,3}#{1,6}(?:[ \t]+\S|[ \t]*$)/u.test(visible)) markdown = true;
        if (/^[ \t]*#\+[a-z][\w-]*:/iu.test(visible) || /^\*{2,}[ \t]+\S/u.test(visible) || hasOrgLink(visible)) org = true;
        if (hasMarkdownLink(visible)) markdown = true;
      }
    }
    // Once both kinds occur, no later text can make the result unambiguous.
    if (markdown && org) return { format: 'plain', reason: 'conflicting' };
    if (end === source.length) break;
    offset = end + 1;
  }
  if (org) return { format: 'org', reason: 'org' };
  if (markdown) return { format: 'markdown', reason: 'markdown' };
  return { format: 'plain', reason: 'ambiguous' };
}

function hasMarkdownLink(line) {
  // A forward state machine avoids backtracking over thousands of unmatched
  // '[' characters. Reference definitions are strong Markdown evidence too.
  let open = false;
  let openAt = -1;
  let text = false;
  const lastClose = line.lastIndexOf(')');
  for (let at = 0; at < line.length; at++) {
    if (line[at] === '[') { open = true; openAt = at; text = false; }
    else if (open && line[at] === ']') {
      if ((text || line[openAt - 1] === '!') && line[at + 1] === '(' && line[at + 2] && !/[\s)]/u.test(line[at + 2])) {
        if (lastClose >= at + 3) return true;
      }
      if (text && line[at + 1] === ':' && /^\s*\S/u.test(line.slice(at + 2))) return true;
      open = false;
    } else if (open) text = true;
  }
  return false;
}

function hasOrgLink(line) {
  const start = line.indexOf('[[');
  if (start < 0) return false;
  const close = line.indexOf(']', start + 2);
  return close > start + 2 && (line[close + 1] === ']' || (line[close + 1] === '[' && line.indexOf(']]', close + 2) >= 0));
}

module.exports = { detectSyntax, MAX_SYNTAX_BYTES };
