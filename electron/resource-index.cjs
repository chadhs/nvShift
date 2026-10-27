const { createAnalyzer } = require('./analysis.cjs');
const { documentFormat } = require('./formats.cjs');
const indexes = new WeakMap();
const analyzer = createAnalyzer();
async function documentIndex(doc) {
  if (!indexes.has(doc)) {
    const indexing = analyzer.analyze({ source: doc.source, format: doc.format ?? documentFormat(doc.path) });
    indexes.set(doc, indexing);
    // Cancellation must not poison this revision if the user returns to its tab.
    void indexing.catch(() => { if (indexes.get(doc) === indexing) indexes.delete(doc); });
  }
  return indexes.get(doc);
}
async function documentResource(doc, kind, request) {
  if (!request || !Number.isSafeInteger(request.start) || !Number.isSafeInteger(request.end)
    || request.start < 0 || request.end <= request.start || request.end > doc.source.length) throw new Error('Invalid document reference.');
  const index = await documentIndex(doc);
  const resource = index[kind].find((item) => item.start === request.start && item.end === request.end);
  if (!resource || (request.reference !== undefined && resource.reference !== request.reference)) throw new Error('Invalid document reference.');
  return resource;
}
module.exports = { documentIndex, documentResource, cancelAnalysis: analyzer.cancel };
