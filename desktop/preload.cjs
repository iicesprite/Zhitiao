const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paper', {
  current: () => ipcRenderer.invoke('paper:current'),
  currentAlert: () => ipcRenderer.invoke('paper:current-alert'),
  act: (action, payload) => ipcRenderer.invoke('paper:act', action, payload),
  onState: (handler) => ipcRenderer.on('paper:state', (_, state) => handler(state)),
  onAlert: (handler) => ipcRenderer.on('paper:alert', (_, alert) => handler(alert))
});
