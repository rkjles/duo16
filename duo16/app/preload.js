// Duo16 — safe bridge between the page and the operating system
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('duo', {
  openRomDialog: () => ipcRenderer.invoke('rom:open-dialog'),
  openRomPath: (p) => ipcRenderer.invoke('rom:open-path', p),
  recentRoms: () => ipcRenderer.invoke('rom:recent'),
  loadSram: (key) => ipcRenderer.invoke('sram:load', key),
  saveSram: (key, bytes) => ipcRenderer.invoke('sram:save', key, bytes),
  saveState: (key, slot, bytes) => ipcRenderer.invoke('state:save', key, slot, bytes),
  loadState: (key, slot) => ipcRenderer.invoke('state:load', key, slot),
  listStates: (key) => ipcRenderer.invoke('state:list', key),
  loadCheats: (key) => ipcRenderer.invoke('cheats:load', key),
  saveCheats: (key, list) => ipcRenderer.invoke('cheats:save', key, list),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  copy: (t) => ipcRenderer.invoke('clipboard:write', t),
  paste: () => ipcRenderer.invoke('clipboard:read'),
  info: () => ipcRenderer.invoke('app:info'),
  setTitle: (t) => ipcRenderer.send('app:set-title', t),
  direct: {
    host: (port) => ipcRenderer.invoke('direct:host', port),
    connect: (host, port) => ipcRenderer.invoke('direct:connect', host, port),
    send: (msg) => ipcRenderer.send('direct:send', msg),
    close: () => ipcRenderer.invoke('direct:close'),
  },
  on: (channel, fn) => {
    const allowed = ['menu', 'rom-opened', 'toast', 'direct:data', 'direct:open', 'direct:closed', 'direct:error'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
