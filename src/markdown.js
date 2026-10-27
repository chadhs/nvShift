import GithubSlugger from 'github-slugger';
import { analyzeDocument, plainText, externalUrl, remoteImageUrl } from './document-analysis.js';
import { escapeHtml as e } from './html.js';
import { createCodeHighlighter } from './highlight.js';

export function renderMarkdown(source, fallbackTitle = 'Untitled') {
  const analysis = analyzeDocument({ source, format: 'markdown' });
  const { tree, nodes, definitions, images, diagrams, links, metadata } = analysis;
  const slugger = new GithubSlugger(), ids = new WeakMap(), anchors = Object.create(null), outline = [];
  const footnotes = new Map(), references = new Map();
  const first = tree.children.find((node) => !['definition', 'footnoteDefinition', 'yaml', 'toml'].includes(node.type));
  const promoted = first?.type === 'heading' && first.depth === 1 && (!metadata.title || plainText(first) === metadata.title) ? first : null;
  function index(node) {
    if (node.type === 'heading') {
      const label = plainText(node), slug = slugger.slug(label);
      const id = node === promoted ? 'document-title' : `md-heading-${slug}`;
      ids.set(node, id); anchors[slug] = id;
      outline.push({ id, label, level: node.depth, todo: '' });
    }
    if (node.type === 'footnoteDefinition' && !footnotes.has(node.identifier)) footnotes.set(node.identifier, node);
    for (const child of node.children || []) index(child);
  }
  index(tree);
  const highlight = createCodeHighlighter();
  const children = (node) => (node.children || []).map(render).join('');
  function listItem(node, tight) {
    let body = node.children.map((child) => tight && child.type === 'paragraph' ? children(child) : render(child)).join('');
    if (typeof node.checked === 'boolean') {
      const checkbox = `<input type="checkbox" disabled ${node.checked ? 'checked' : ''} aria-label="${node.checked ? 'Complete' : 'Incomplete'}"> `;
      body = body.startsWith('<p>') ? `<p>${checkbox}${body.slice(3)}` : checkbox + body;
    }
    return `<li>${body}</li>`;
  }
  function renderLink(node) {
    const definition = definitions.get(node.identifier);
    const target = node.url ?? definition?.url;
    const label = children(node);
    const local = nodes.get(node).link;
    if (local) return `<a href="#" data-document-link="${local.id}">${label}</a>`;
    if (externalUrl(target || '')) return `<a href="${e(target)}" rel="noreferrer">${label}</a>`;
    if (target?.startsWith('#')) {
      let fragment = target.slice(1);
      try { fragment = decodeURIComponent(fragment); } catch { /* Preserve literal percent signs. */ }
      const id = fragment ? anchors[fragment] : 'document-title';
      if (id) return `<a href="#${e(id)}">${label}</a>`;
    }
    return `<span class="unresolved" title="Unresolved or unsupported link">${label}</span>`;
  }
  function render(node) {
    switch (node.type) {
      case 'root': return children(node);
      case 'text': case 'html': return e(node.value);
      case 'paragraph': return `<p>${children(node)}</p>`;
      case 'heading': return node === promoted ? '' : `<h${Math.min(node.depth + 1, 6)} id="${e(ids.get(node))}" data-level="${node.depth}">${children(node)}</h${Math.min(node.depth + 1, 6)}>`;
      case 'emphasis': return `<em>${children(node)}</em>`;
      case 'strong': return `<strong>${children(node)}</strong>`;
      case 'delete': return `<s>${children(node)}</s>`;
      case 'inlineCode': return `<code>${e(node.value)}</code>`;
      case 'break': return '<br>';
      case 'thematicBreak': return '<hr>';
      case 'blockquote': return `<blockquote>${children(node)}</blockquote>`;
      case 'list': return `<${node.ordered ? 'ol' : 'ul'}${node.ordered ? ` start="${node.start ?? 1}"` : ''}>${node.children.map((item) => listItem(item, !node.spread)).join('')}</${node.ordered ? 'ol' : 'ul'}>`;
      case 'listItem': return listItem(node, false);
      case 'link': case 'linkReference': return renderLink(node);
      case 'image': case 'imageReference': {
        const image = nodes.get(node).image;
        if (image) return `<span class="image-preview" data-image-id="${image.id}" data-image-start="${image.start}"><span class="image-placeholder">Loading image: ${e(image.label)}</span></span>`;
        const target = node.url ?? definitions.get(node.identifier)?.url;
        if (externalUrl(target || '') && !remoteImageUrl(target)) return `<a href="${e(target)}" rel="noreferrer">${e(node.alt || target)}</a>`;
        return `<span class="image-placeholder">Image unavailable or limit reached: ${e(node.alt || target || '')}</span>`;
      }
      case 'code': {
        const diagram = nodes.get(node).diagram;
        if (diagram && !diagram.error) return `<figure class="code-block diagram" data-diagram-id="${diagram.id}"><figcaption>mermaid</figcaption><div class="diagram-output" role="status">Rendering diagram…</div><details open><summary>Show source</summary><pre><code>${e(node.value)}</code></pre></details></figure>`;
        const label = diagram?.error ? `mermaid · ${diagram.error}` : node.lang || 'source';
        return `<figure class="code-block"><figcaption>${e(label)}</figcaption><pre><code>${diagram ? e(node.value) : highlight(node.value, node.lang || '') ?? e(node.value)}</code></pre></figure>`;
      }
      case 'table': {
        const row = (item, tag) => `<tr>${item.children.map((cell, i) => `<${tag}${node.align[i] ? ` class="align-${node.align[i]}"` : ''}>${children(cell)}</${tag}>`).join('')}</tr>`;
        return `<div class="table-wrap"><table><thead>${row(node.children[0], 'th')}</thead><tbody>${node.children.slice(1).map((item) => row(item, 'td')).join('')}</tbody></table></div>`;
      }
      case 'footnoteReference': {
        if (!footnotes.has(node.identifier)) return e(source.slice(node.position.start.offset, node.position.end.offset));
        if (!references.has(node.identifier)) references.set(node.identifier, { number: references.size + 1, count: 0 });
        const reference = references.get(node.identifier); reference.count++;
        return `<sup><a id="md-footnote-ref-${reference.number}-${reference.count}" href="#md-footnote-${reference.number}" aria-label="Footnote ${reference.number}">${reference.number}</a></sup>`;
      }
      case 'definition': case 'footnoteDefinition': return '';
      case 'yaml': case 'toml': return metadata.warning ? `<pre class="frontmatter-source">${e(source.slice(node.position.start.offset, node.position.end.offset))}</pre>` : '';
      default: return e(source.slice(node.position?.start.offset, node.position?.end.offset));
    }
  }
  let html = render(tree);
  const notes = [];
  // Render note bodies before backlinks so repeated references are all included.
  for (const [identifier, reference] of references) notes.push({ reference, body: children(footnotes.get(identifier)) });
  if (notes.length) html += `<section class="footnotes" aria-label="Footnotes"><hr><ol>${notes.map(({ reference, body }) => `<li id="md-footnote-${reference.number}">${body} ${Array.from({ length: reference.count }, (_, i) => `<a href="#md-footnote-ref-${reference.number}-${i + 1}" aria-label="Back to reference ${reference.number}.${i + 1}">↩</a>`).join(' ')}</li>`).join('')}</ol></section>`;
  return { html, outline, images, diagrams, links, anchors,
    title: metadata.title || (promoted ? plainText(promoted) : fallbackTitle), subtitle: '', author: metadata.author,
    date: metadata.date, tags: metadata.tags, draft: metadata.draft, metadataWarning: metadata.warning || '',
    words: source.trim() ? source.trim().split(/\s+/).length : 0, lines: source.split('\n').length };
}
