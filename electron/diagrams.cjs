const path = require('node:path');
const { pathToFileURL } = require('node:url');

// A separate renderer keeps layout work off the reader's UI thread. Destroying
// it interrupts even synchronous layout when an input takes too long.
function createDiagramRenderer({ Window, ipc, timeoutMs = 5000 } = {}) {
  // Pure validation and injected test doubles must not load Electron's Node
  // entry point, which can install its binary on a fresh development machine.
  if (!Window || !ipc) {
    const electron = require('electron');
    Window ??= electron.BrowserWindow;
    ipc ??= electron.ipcMain;
  }
  let window, pending, counter = 0, queue = Promise.resolve();
  const page = path.join(__dirname, '../dist/diagram.html');
  const pageUrl = pathToFileURL(page).href;
  const cancel = () => {
    pending?.({ error: 'Diagram rendering was interrupted.' });
    pending = undefined;
    const previous = window;
    window = undefined;
    if (previous && !previous.isDestroyed()) previous.destroy();
  };
  ipc.on('diagram:result', (event, result) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== pageUrl) return;
    if (result?.requestId !== counter) return;
    if (typeof result.svg === 'string' && result.svg.length <= 4 * 1024 * 1024) pending?.({ svg: result.svg });
    else pending?.({ error: typeof result.error === 'string' ? result.error.slice(0, 500) : 'Diagram output exceeds 4 MiB.' });
  });
  async function render(source, theme, isCurrent) {
    const work = async () => {
      if (!isCurrent()) return { error: 'The document changed.' };
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          finish({ error: 'Diagram exceeded the 5-second rendering limit.' });
          cancel();
        }, timeoutMs);
        function finish(result) {
          if (pending !== finish) return;
          clearTimeout(timer);
          pending = undefined;
          resolve(isCurrent() ? result : { error: 'The document changed.' });
        }
        pending = finish;
        const requestId = ++counter;
        const send = () => {
          if (pending === finish && window && !window.isDestroyed()) window.webContents.send('diagram:render', { source, theme, requestId });
        };
        if (!window) {
          window = new Window({ show: false, width: 1200, height: 900, webPreferences: {
            preload: path.join(__dirname, 'diagram-preload.cjs'), sandbox: true,
            contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
          } });
          window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          window.webContents.on('will-navigate', (event) => event.preventDefault());
          const created = window;
          const failed = (error) => {
            // A cancelled window can finish failing after its replacement opens.
            if (window !== created) return;
            pending?.({ error });
            cancel();
          };
          created.webContents.on('render-process-gone', () => failed('Diagram renderer stopped.'));
          created.loadFile(page).then(send).catch(() => failed('Diagram renderer could not load.'));
        } else send();
      });
    };
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  }
  return { render, cancel };
}

module.exports = { createDiagramRenderer };
