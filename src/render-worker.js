import { renderDocument } from './documents.js';
import { MAX_PREVIEW_CHARACTERS } from './processing-limits.js';

self.onmessage = ({ data: doc }) => {
  try {
    const preview = renderDocument(doc);
    if (preview.html.length > MAX_PREVIEW_CHARACTERS) throw new Error('Preview exceeds 32 Mi characters');
    self.postMessage({ preview });
  } catch (error) {
    self.postMessage({ error: String(error.message || 'Document processing failed').slice(0, 500) });
  }
};
