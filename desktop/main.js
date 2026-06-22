const { app, BrowserWindow } = require('electron');
const path = require('path');

// Set this to your Vercel deployment URL for cross-platform multiplayer.
// App players and website players share the same rooms when this points
// to the same backend the website uses.
const API_BASE = process.env.POKER_API_BASE || 'https://e-port-git-main-icarus2419s-projects.vercel.app';

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Poker Platform',
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'index.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    win.webContents.openDevTools();
  }
}

app.whenReady().then(() => {
  createWindow();

  // Re-open window on macOS dock click when all windows are closed
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
