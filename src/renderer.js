import { PROCESSING_TIMEOUT_MS } from './processing-limits.js';

// Termination interrupts synchronous parser/highlighter work, including on saves.
export function createDocumentRenderer({ createWorker = () => new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' }), timeoutMs = PROCESSING_TIMEOUT_MS } = {}) {
  let pending;
  const cancel = () => pending?.(new Error('The document changed'));
  function render(doc) {
    cancel();
    return new Promise((resolve, reject) => {
      let worker, timer;
      function finish(error, preview) {
        if (pending !== finish) return;
        pending = undefined;
        clearTimeout(timer);
        worker?.terminate();
        if (error) reject(error); else resolve(preview);
      }
      pending = finish;
      try {
        worker = createWorker();
        worker.onmessage = ({ data }) => data.error ? finish(new Error(data.error)) : finish(null, data.preview);
        worker.onerror = (event) => { event.preventDefault?.(); finish(new Error(event.message || 'Document processing stopped')); };
        worker.onmessageerror = () => finish(new Error('Document processing returned invalid data'));
        timer = setTimeout(() => finish(new Error('Document exceeded the 15-second processing limit')), timeoutMs);
        worker.postMessage({ source: doc.source, name: doc.name, format: doc.format });
      } catch (error) { finish(error); }
    });
  }
  return { render, cancel };
}
