'use strict';
// Secure bridge: the renderer gets exactly these four functions, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('trackpad', {
  ready: () => ipcRenderer.send('renderer-ready'),
  quit: () => ipcRenderer.send('quit'),
  fit: (h) => ipcRenderer.send('fit-height', h),
  setMode: (mode) => ipcRenderer.send('set-mode', mode),
  dragBy: (dx, dy) => ipcRenderer.send('drag-by', { dx, dy }),
  onInit: (cb) => ipcRenderer.on('init', (_e, d) => cb(d)),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, data) => cb(data)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, data) => cb(data)),
});
