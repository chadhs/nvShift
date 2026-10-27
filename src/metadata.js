import { parseDocument } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { MAX_METADATA_CHARACTERS } from './processing-limits.js';

export function normalizeMetadata(values = {}) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) values = {};
  const text = (value) => typeof value === 'string' ? value.trim() : '';
  const authorValue = values.author ?? values.params?.author;
  const author = Array.isArray(authorValue) ? authorValue.filter((value) => typeof value === 'string').join(', ') : text(authorValue);
  const tags = Array.isArray(values.tags) ? values.tags.filter((value) => typeof value === 'string').map((value) => value.trim()).filter(Boolean) : [];
  const date = values.date instanceof Date ? values.date.toISOString() : text(values.date);
  return { title: text(values.title), author, date, tags: [...new Set(tags)], draft: values.draft === true };
}

export function markdownMetadata(tree) {
  const node = tree.children[0];
  if (!['yaml', 'toml'].includes(node?.type)) return normalizeMetadata();
  if (node.value.length > MAX_METADATA_CHARACTERS) return { ...normalizeMetadata(), warning: 'Front matter exceeds 128 Ki characters. The original metadata is shown below.' };
  try {
    let values;
    if (node.type === 'toml') values = parseToml(node.value);
    else {
      const document = parseDocument(node.value, { schema: 'core' });
      if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML front matter.');
      values = document.toJS({ maxAliasCount: 0 });
    }
    if (values !== null && (typeof values !== 'object' || Array.isArray(values))) throw new Error('Front matter must contain named fields.');
    return normalizeMetadata(values);
  } catch {
    return { ...normalizeMetadata(), warning: `Could not read ${node.type.toUpperCase()} front matter. The original metadata is shown below.` };
  }
}

export function orgMetadata(source) {
  const values = {}, lines = source.split(/(?<=\n)/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    const match = /^[ \t]*#\+([\w-]+)(\[\])?:[ \t]*([^\r\n]*)/i.exec(line);
    if (!match) break;
    const key = match[1].toLowerCase(), value = match[3].trim();
    if (key === 'tags' && match[2]) {
      values.tags = [...(values.tags || []), ...value.split(/\s+/).filter(Boolean)];
      // Orga does not recognize Hugo's [] keyword suffix. Mask only the header
      // line, preserving every source offset used to validate links and images.
      lines[index] = line.replace(/[^\r\n]/g, ' ');
    } else if (key === 'draft') values.draft = value.toLowerCase() === 'true';
    else if (['title', 'author', 'date'].includes(key)) values[key] = value;
  }
  return { source: lines.join(''), metadata: normalizeMetadata(values) };
}

export function showMetadata(container, parsed) {
  container.replaceChildren();
  const summary = document.createElement('span');
  summary.textContent = [parsed.author, parsed.date, `${Math.max(1, Math.ceil(parsed.words / 220))} min read`].filter(Boolean).join('  ·  ');
  container.append(summary);
  if (parsed.draft === true) {
    const draft = document.createElement('span');
    draft.className = 'draft-indicator'; draft.textContent = 'Draft';
    container.append(draft);
  }
  if (parsed.tags?.length) {
    const tags = document.createElement('span');
    tags.className = 'document-tags'; tags.setAttribute('aria-label', 'Tags');
    for (const value of parsed.tags) {
      const tag = document.createElement('span'); tag.textContent = value; tags.append(tag);
    }
    container.append(tags);
  }
  if (parsed.metadataWarning) {
    const warning = document.createElement('span');
    warning.className = 'metadata-warning'; warning.textContent = parsed.metadataWarning;
    container.append(warning);
  }
}
