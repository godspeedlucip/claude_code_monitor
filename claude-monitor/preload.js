const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('monitorAPI', {
  getSessions: () => ipcRenderer.invoke('get-sessions'),
  removeSession: (id) => ipcRenderer.invoke('remove-session', id),
  onSessionsUpdated: (callback) => {
    const handler = (event, sessions) => callback(sessions)
    ipcRenderer.on('sessions-updated', handler)
    return () => ipcRenderer.removeListener('sessions-updated', handler)
  }
})
