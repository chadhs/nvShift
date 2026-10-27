/** Shared AST-based note headings. Original nvShift code, BSD-3-Clause. */
export const headingText = (node) => node.value ?? node.alt ?? (node.children || []).map(headingText).join('');

// Org task states, priorities, tags and syntax markers are not part of the title.
export function orgHeadingText(node) {
  if (node.type === 'text') return node.value;
  if (node.type === 'link') return (node.children || []).map(orgHeadingText).join('') || node.path?.value || '';
  return (node.children || []).map(orgHeadingText).join('');
}

function orgHeadingContext(source) {
  const blocks = [];
  let open = null, title = '', offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const begin = /^[ \t]*#\+begin_(\w+)\b/i.exec(line);
    const end = /^[ \t]*#\+end_(\w+)\b/i.exec(line);
    if (open) {
      if (end && end[1].toLowerCase() === open.name) {
        blocks.push({ start: open.start, end: offset + line.length });
        open = null;
      }
    } else if (begin) open = { name: begin[1].toLowerCase(), start: offset };
    else {
      const directive = /^[ \t]*#\+title:[ \t]*([^\r\n]*)/i.exec(line);
      if (!title && directive?.[1].trim()) title = directive[1].trim();
    }
    offset += line.length;
  }
  if (open) blocks.push({ start: open.start, end: source.length });
  return { blocks, title };
}

export function analyzeHeading(tree, format, source, metadata) {
  if (format === 'markdown') {
    const node = tree.children.find((child) => child.type === 'heading' && child.depth === 1 && headingText(child).trim());
    return { node, label: node ? headingText(node).trim() : '', metadataTitle: metadata.title || '' };
  }
  const { blocks, title } = orgHeadingContext(source);
  let blockIndex = 0;
  for (const section of tree.children) {
    if (section.type !== 'section' || section.level !== 1) continue;
    const node = section.children.find((child) => child.type === 'headline');
    if (!node) continue;
    const offset = node.position.start.offset;
    while (blockIndex < blocks.length && blocks[blockIndex].end <= offset) blockIndex++;
    if (blocks[blockIndex]?.start <= offset) continue;
    const label = orgHeadingText(node).trim();
    if (label) return { node, label, metadataTitle: metadata.title || title };
  }
  return { node: undefined, label: '', metadataTitle: metadata.title || title };
}

export function resolveDocumentHeading(analysis, fallbackTitle, { filenameHeadings = false } = {}) {
  const { node, label, metadataTitle } = analysis.heading || {};
  const title = filenameHeadings ? fallbackTitle : metadataTitle || label || fallbackTitle;
  return { title, promoted: !filenameHeadings && label && label === title ? node : null };
}
