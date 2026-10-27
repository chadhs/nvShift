const { Worker } = require('node:worker_threads');
const path = require('node:path');

// Resource authorization uses an independent analysis of main-owned source.
// A worker thread keeps parsing off the main event loop; it is not an OS sandbox.
function createAnalyzer({ workerPath = path.join(__dirname, 'analysis-worker.cjs'), timeoutMs = 15000 } = {}) {
  const jobs = new Set();
  function analyze(doc) {
    return new Promise((resolve, reject) => {
      let worker, timer, finished = false;
      function finish(error, index) {
        if (finished) return;
        finished = true;
        jobs.delete(finish);
        clearTimeout(timer);
        void worker?.terminate();
        if (error) reject(error); else resolve(index);
      }
      jobs.add(finish);
      try {
        worker = new Worker(workerPath, { workerData: doc, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
        worker.once('message', (result) => result.error ? finish(new Error(result.error)) : finish(null, result.index));
        worker.once('error', () => finish(new Error('Document analysis stopped or exceeded its memory limit')));
        worker.once('exit', () => finish(new Error('Document analysis stopped')));
        timer = setTimeout(() => finish(new Error('Document analysis exceeded the 15-second processing limit')), timeoutMs);
      } catch (error) { finish(error); }
    });
  }
  const cancel = () => { for (const finish of jobs) finish(new Error('The document changed')); };
  return { analyze, cancel };
}
module.exports = { createAnalyzer };
