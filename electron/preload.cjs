const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  close: () => ipcRenderer.invoke("window:close"),
  toggleClickThrough: () => ipcRenderer.invoke("window:toggle-click-through"),
  onClickThrough: (callback) => {
    ipcRenderer.on("click-through", (_event, enabled) => callback(enabled));
  }
});
