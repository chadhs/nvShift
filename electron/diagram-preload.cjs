const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('diagramWorker', {
  onRender: (callback) => ipcRenderer.on('diagram:render', (_event, request) => callback(request)),
  complete: (result) => ipcRenderer.send('diagram:result', result),
});
