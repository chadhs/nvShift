import formats from '../electron/formats.cjs';
import { renderOrg } from './org.js';
import { renderMarkdown } from './markdown.js';
import { escapeHtml } from './html.js';
import { analyzeDocument } from './document-analysis.js';
import { resolveDocumentHeading } from './headings.js';
export function renderDocument(doc, { titleOnly = false, filenameHeadings = false } = {}) {
  const format = doc.format ?? formats.documentFormat(doc.name);
  const title = formats.documentTitle(doc.name);
  if (!['org', 'markdown', 'plain'].includes(format)) throw new Error('Unsupported document format.');
  if (titleOnly) {
    if (filenameHeadings || format === 'plain') return { title };
    return { title: resolveDocumentHeading(analyzeDocument({ source: doc.source, format }), title).title };
  }
  if (format === 'org') return renderOrg(doc.source, title, { filenameHeadings });
  if (format === 'markdown') return renderMarkdown(doc.source, title, { filenameHeadings });
  if (format === 'plain') return {
    title, subtitle: '', author: '', date: '', tags: [], draft: false,
    html: `<pre class="plain-preview">${escapeHtml(doc.source)}</pre>`,
    outline: [], images: [], diagrams: [], links: [], anchors: {},
    words: doc.source.trim() ? doc.source.trim().split(/\s+/).length : 0,
    lines: doc.source.split('\n').length,
  };
  throw new Error('Unsupported document format.');
}
export { resolveAnchor } from './anchors.js';
