import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDiagramRenderer } from '../electron/diagrams.cjs';

test('late load failures and crash events from a cancelled renderer cannot stop its replacement', async () => {
  const windows = [], ipc = new EventEmitter();
  class Window {
    constructor() {
      windows.push(this);
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_channel, request) => { this.request = request; };
    }
    loadFile(file) {
      this.webContents.mainFrame = { url: pathToFileURL(file).href };
      return new Promise((resolve, reject) => { this.loaded = resolve; this.failed = reject; });
    }
    destroy() { this.destroyed = true; }
    isDestroyed() { return this.destroyed; }
  }
  const renderer = createDiagramRenderer({ Window, ipc, timeoutMs: 1000 });
  const first = renderer.render('flowchart LR\n A-->B', 'light', () => true);
  await new Promise(setImmediate);
  renderer.cancel();
  assert.match((await first).error, /interrupted/);
  const second = renderer.render('flowchart LR\n C-->D', 'dark', () => true);
  await new Promise(setImmediate);
  windows[0].failed(new Error('Old load was cancelled'));
  windows[0].webContents.emit('render-process-gone');
  await new Promise(setImmediate);
  assert.equal(windows[1].destroyed, undefined);
  windows[1].loaded();
  await new Promise(setImmediate);
  assert.equal(windows[1].request.theme, 'dark');
  ipc.emit('diagram:result', { sender: windows[1].webContents, senderFrame: windows[1].webContents.mainFrame }, { requestId: windows[1].request.requestId, svg: '<svg/>' });
  assert.deepEqual(await second, { svg: '<svg/>' });
  renderer.cancel();
});

test('unit-test imports and injected renderers never bootstrap the Electron binary', () => {
  const result = spawnSync(process.execPath, ['-e', `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (name, ...args) {
      if (name === 'electron') throw new Error('Unexpected Electron bootstrap');
      return load.call(this, name, ...args);
    };
    const { createDiagramRenderer } = require('./electron/diagrams.cjs');
    const renderer = createDiagramRenderer({ Window: class {}, ipc: { on() {} } });
    renderer.cancel();
    if (typeof require('./electron/resource-index.cjs').documentResource !== 'function') throw new Error('Missing source validator');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
