// Copyright (c) 2026 Chad Stovern. BSD-3-Clause.
const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = (channel) => (callback) => {
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld('nvShift', {
  platform: process.platform,
  rendererReady: invoke('app:ready'),
  beginShortcutRecording: invoke('shortcut:record-start'), endShortcutRecording: invoke('shortcut:record-end'),
  initial: invoke('app:initial'), chooseLibrary: invoke('library:choose'), search: invoke('library:search'),
  create: invoke('note:create'), open: invoke('note:open'), updateBuffer: invoke('note:update'),
  save: invoke('note:save'), rename: invoke('note:rename'), trash: invoke('note:trash'),
  setSyntax: invoke('note:syntax'),
  resolveConflict: invoke('note:conflict'), updateSettings: invoke('settings:update'),
  insertImage: invoke('asset:bytes'), insertImagePaths: invoke('asset:paths'),
  startAssetCleanup: invoke('asset:cleanup-start'), cancelAssetCleanup: invoke('asset:cleanup-cancel'),
  assetCleanupThumbnail: invoke('asset:cleanup-thumbnail'), trashUnusedAssets: invoke('asset:cleanup-trash'),
  protectAssetHistory: invoke('asset:protect-history'), onAssetCleanup: subscribe('asset:cleanup'),
  droppedPath(file) {
    const filePath = webUtils.getPathForFile(file);
    if (filePath) ipcRenderer.send('asset:authorize-drop', filePath);
    return filePath;
  },
  image: invoke('resource:image'), diagram: invoke('resource:diagram'), openLink: invoke('resource:link'),
  external: invoke('link:external'), reveal: invoke('note:reveal'), windowTheme: invoke('window:theme'),
  rendererFlushed: (requestId, error) => ipcRenderer.send('app:renderer-flushed', requestId, error),
  onState: subscribe('app:state'), onDocument: subscribe('note:changed'),
  onLibrary: subscribe('library:changed'), onCommand: subscribe('app:command'),
});
