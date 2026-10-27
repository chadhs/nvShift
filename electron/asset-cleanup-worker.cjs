// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { parentPort, workerData } = require('node:worker_threads');
const { existsSync } = require('node:fs');
const path = require('node:path');

(async () => {
  const { collectAssetReferences } = existsSync(path.join(__dirname, '../src/asset-references.js'))
    ? await import('../src/asset-references.js') : require('../dist/asset-references.cjs');
  const cache = new Map();
  parentPort.on('message', async ({ requestId, document }) => {
    try { parentPort.postMessage({ requestId, ids: await collectAssetReferences(document, workerData.candidates, cache) }); }
    catch (error) { parentPort.postMessage({ requestId, error: String(error.message || error).slice(0, 1000) }); }
  });
  parentPort.postMessage({ ready: true });
})().catch((error) => { throw error; });
