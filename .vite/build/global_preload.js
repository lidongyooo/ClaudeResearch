const { contextBridge, ipcRenderer } = require('electron')

console.log('global_preload loadeddddddd')

try {
    contextBridge.exposeInMainWorld('openSwitchAccount', () => ipcRenderer.invoke('global:openSwitchAccount'))
    contextBridge.exposeInMainWorld('getAllCookies', () => ipcRenderer.invoke('global:getAllCookies'))
    contextBridge.exposeInMainWorld('getUserData', () => ipcRenderer.invoke('global:getUserData'))
    contextBridge.exposeInMainWorld('saveUserData', () => ipcRenderer.invoke('global:saveUserData'))
    contextBridge.exposeInMainWorld('getAllProfile', () => ipcRenderer.invoke('global:getAllProfile'))
    contextBridge.exposeInMainWorld('switchToAccount', (uuid) => ipcRenderer.invoke('global:switchToAccount', uuid))
    contextBridge.exposeInMainWorld('addAccount', () => ipcRenderer.invoke('global:addAccount'))
    contextBridge.exposeInMainWorld('restartApp', () => ipcRenderer.invoke('global:restartApp'))
} catch (err) {
    console.error('global_preload expose failed', err)
}
