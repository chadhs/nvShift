// SPDX-License-Identifier: BSD-3-Clause
import { parentPort } from 'node:worker_threads';
import { NoteSearchIndex } from './search-index.js';

const index = new NoteSearchIndex();
parentPort.on('message', ({ requestId, method, args }) => {
  try {
    if (!['replaceAll', 'upsert', 'remove', 'search'].includes(method)) throw new Error('Unknown index operation.');
    const result = index[method](...args);
    parentPort.postMessage({ requestId, result });
  } catch (error) { parentPort.postMessage({ requestId, error: error.message }); }
});
