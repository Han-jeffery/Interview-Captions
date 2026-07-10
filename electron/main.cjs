const { app, BrowserWindow, globalShortcut, ipcMain, session } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3210);
let serverProcess;
let mainWindow;
let clickThrough = false;

function findNodeBinary() {
  const candidates = [
    process.env.NODE_BINARY,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "node"
  ].filter(Boolean);

  return candidates[0];
}

function waitForServer(timeoutMs = 12000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      const req = http.get(`http://localhost:${port}/health`, (res) => {
        res.resume();
        resolve();
      });

      req.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error("Local server did not start in time."));
          return;
        }
        setTimeout(check, 300);
      });
    }

    check();
  });
}

function startServer() {
  serverProcess = spawn(findNodeBinary(), ["server/index.js"], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });

  serverProcess.on("exit", () => {
    serverProcess = null;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 360,
    minWidth: 560,
    minHeight: 180,
    x: 80,
    y: 80,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    hasShadow: false,
    resizable: true,
    fullscreenable: false,
    title: "ITC-View",
    backgroundColor: "#00000000",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.loadURL(`http://localhost:${port}/overlay.html`);
}

function registerShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+H", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.showInactive();
    }
  });

  globalShortcut.register("CommandOrControl+Shift+T", () => {
    if (!mainWindow) return;
    clickThrough = !clickThrough;
    mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    mainWindow.webContents.send("click-through", clickThrough);
  });
}

ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("window:toggle-click-through", () => {
  if (!mainWindow) return false;
  clickThrough = !clickThrough;
  mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
  mainWindow.webContents.send("click-through", clickThrough);
  return clickThrough;
});

app.whenReady().then(async () => {
  // Ensure the app appears in the Dock with the correct name
  if (process.platform === "darwin") {
    app.setName("ITC-View");
  }

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "media");
  });

  startServer();
  await waitForServer();
  createWindow();
  registerShortcuts();
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (serverProcess) {
    serverProcess.kill();
  }
});
