'use strict';

// Novela preload bridge — the only surface the renderer can use.
// No Node.js access is exposed to the page itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('novela', {
  backendStatus: () => ipcRenderer.invoke('novela:backend-status'),
  ping: () => ipcRenderer.invoke('novela:ping'),
  presets: () => ipcRenderer.invoke('novela:presets'),
  obfuscate: (job) => ipcRenderer.invoke('novela:obfuscate', job),
  openFile: () => ipcRenderer.invoke('novela:open-file'),
  saveFile: (payload) => ipcRenderer.invoke('novela:save-file', payload),
  windowControl: (action) => ipcRenderer.send('novela:window', action),
  serverSettings: () => ipcRenderer.invoke('novela:server-settings'),
  serverSave: (patch) => ipcRenderer.invoke('novela:server-save', patch),
  serverStatus: () => ipcRenderer.invoke('novela:server-status'),
  serverStart: (opts) => ipcRenderer.invoke('novela:server-start', opts),
  serverStop: () => ipcRenderer.invoke('novela:server-stop'),
  pasteUpload: (job) => ipcRenderer.invoke('novela:paste-upload', job),
  onServerStatus: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('novela:server-status', listener);
    return () => ipcRenderer.removeListener('novela:server-status', listener);
  },
  onBackendStatus: (callback) => {
    const listener = (_event, info) => callback(info);
    ipcRenderer.on('novela:backend-status', listener);
    return () => ipcRenderer.removeListener('novela:backend-status', listener);
  },
});
