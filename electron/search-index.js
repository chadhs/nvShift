// SPDX-License-Identifier: BSD-3-Clause
import MiniSearch from 'minisearch';

const terms = (query) => query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
const fold = (value) => String(value).normalize('NFC').toLocaleLowerCase();

export function makeSnippet(source, query, length = 170) {
  const text = source.replace(/\s+/gu, ' ').trim();
  const lower = fold(text);
  const positions = terms(query).map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const at = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, at - 45);
  return `${start ? '…' : ''}${text.slice(start, start + length)}${text.length > start + length ? '…' : ''}`;
}

/** Rebuildable index. The filesystem and main-owned buffers remain authoritative. */
export class NoteSearchIndex {
  constructor() {
    this.documents = new Map();
    this.index = this.makeIndex();
  }
  makeIndex() {
    return new MiniSearch({ fields: ['title', 'name', 'source'], idField: 'id', searchOptions: { prefix: true, fuzzy: false, combineWith: 'AND', boost: { title: 4, name: 2 } } });
  }
  replaceAll(documents) {
    this.documents = new Map(documents.map((document) => [document.id, document]));
    this.index = this.makeIndex();
    this.index.addAll(documents);
    return this.documents.size;
  }
  upsert(document) {
    if (this.documents.has(document.id)) this.index.discard(document.id);
    this.documents.set(document.id, document);
    this.index.add(document);
  }
  remove(id) {
    if (this.documents.delete(id)) this.index.discard(id);
  }
  search(value, limit = 200) {
    const query = String(value ?? '').slice(0, 1000).trim();
    let matches;
    if (!query) matches = [...this.documents.values()].map((document) => ({ document, score: 0, rank: 0 }));
    else {
      const queryTerms = terms(query);
      if (!queryTerms.length) return { results: [], total: 0, query };
      matches = this.index.search(query).map((result) => {
        const document = this.documents.get(result.id);
        const title = fold(document.title);
        const titleTerms = terms(title);
        const titleMatches = queryTerms.filter((term) => titleTerms.some((word) => word.startsWith(term))).length;
        const filenameTerms = terms(document.name);
        const filenameMatches = queryTerms.some((term) => filenameTerms.some((word) => word.startsWith(term)));
        const rank = title === fold(query) || fold(document.name) === fold(query) ? 0 : titleMatches === queryTerms.length ? 1 : titleMatches || filenameMatches ? 2 : 3;
        return { document, score: result.score, rank };
      });
    }
    matches.sort((a, b) => a.rank - b.rank || b.score - a.score || b.document.modified - a.document.modified || a.document.relativePath.localeCompare(b.document.relativePath));
    return {
      query, total: matches.length,
      results: matches.slice(0, Math.max(1, Math.min(limit, 1000))).map(({ document }) => {
        const { id, name, title, relativePath, modified, format, extension } = document;
        return { id, name, title, relativePath, modified, format, extension, snippet: makeSnippet(document.source, query) };
      }),
    };
  }
}
