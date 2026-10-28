// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { Worker } = require('node:worker_threads');
const path = require('node:path');

/** One lazy worker per library, reused across notes and buffer revisions. */
function createSyntaxDetector({ workerPath = path.join(__dirname, 'syntax-worker.cjs'), timeoutMs = 5000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('A positive syntax-detection timeout is required.');
  let worker = null;
  let closed = false;
  let nextId = 0;
  const pending = new Map();
  const terminating = new Set();
  function terminate(target) {
    const promise = target.terminate().catch(() => {});
    terminating.add(promise);
    void promise.finally(() => terminating.delete(promise));
  }
  function fail(target, error) {
    if (worker !== target) return;
    worker = null;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    terminate(target);
  }
  function start() {
    if (worker) return worker;
    const target = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
    worker = target;
    target.on('message', (message) => {
      if (worker !== target) return;
      const request = pending.get(message?.requestId);
      if (!request) return;
      const result = message.result;
      if (!message.error && (!result || !['ambiguous', 'conflicting', 'markdown', 'org'].includes(result.reason)
        || result.format !== (['ambiguous', 'conflicting'].includes(result.reason) ? 'plain' : result.reason))) {
        fail(target, new Error('Syntax detection returned an invalid result.')); return;
      }
      pending.delete(message.requestId); clearTimeout(request.timer);
      if (!pending.size) target.unref();
      if (message.error) request.reject(new Error(String(message.error))); else request.resolve(result);
    });
    target.on('error', () => fail(target, new Error('Syntax detection stopped or exceeded its memory limit.')));
    target.on('exit', () => fail(target, new Error('Syntax detection stopped unexpectedly.')));
    target.unref();
    return target;
  }
  return {
    detect(source) {
      if (closed) return Promise.reject(new Error('Syntax detection is closed.'));
      if (typeof source !== 'string') return Promise.reject(new Error('Syntax detection requires text.'));
      return new Promise((resolve, reject) => {
        let target;
        try {
          target = start(); target.ref();
          const requestId = ++nextId;
          const timer = setTimeout(() => fail(target, new Error('Syntax detection exceeded its processing limit.')), timeoutMs);
          pending.set(requestId, { resolve, reject, timer });
          target.postMessage({ requestId, source });
        } catch (error) {
          if (target) fail(target, error);
          reject(error);
        }
      });
    },
    async close() {
      closed = true;
      if (worker) fail(worker, new Error('Syntax detection is closed.'));
      await Promise.all([...terminating]);
    },
  };
}

module.exports = { createSyntaxDetector };
