const { parentPort, workerData } = require('node:worker_threads');
const { existsSync } = require('node:fs');
const path = require('node:path');

(async () => {
  try {
    const { analyzeDocument } = existsSync(path.join(__dirname, '../src/document-analysis.js'))
      ? await import('../src/document-analysis.js') : require('../dist/document-analysis.cjs');
    const { images, diagrams, links } = analyzeDocument(workerData);
    parentPort.postMessage({ index: { images, diagrams, links } });
  } catch (error) {
    parentPort.postMessage({ error: String(error.message || 'Document analysis failed').slice(0, 500) });
  }
})().catch(() => process.exitCode = 1);
