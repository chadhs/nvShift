// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { parentPort } = require('node:worker_threads');
const { detectSyntax } = require('./syntax-detection.cjs');

parentPort.on('message', ({ requestId, source }) => {
  try { parentPort.postMessage({ requestId, result: detectSyntax(source) }); }
  catch (error) { parentPort.postMessage({ requestId, error: String(error.message || 'Syntax detection failed').slice(0, 500) }); }
});
