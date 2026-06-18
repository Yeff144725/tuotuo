'use strict';
/*
 * main.js — Electron main process.
 * Frameless, always-on-top, frosted-glass widget with two sizes (expanded
 * dashboard / collapsed pet). The pet is freely draggable and the window
 * position + mode persist to userData/state.json across launches.
 */
const { app, BrowserWindow, screen, Tray, Menu, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const TokenAggregator = require('./aggregator');

const EXPANDED_W = 300;
const EXPANDED_H = 540;     // provisional; renderer reports exact via 'fit-height'
const COLLAPSED_W = 108;
const COLLAPSED_H = 128;

let win = null;
let tray = null;
let agg = null;
let timer = null;
let started = false;
let mode = 'expanded';
let lastExpandedH = EXPANDED_H;

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; }
}
let saveTimer = null;
function saveState() {
  if (saveTimer || !win || win.isDestroyed()) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const [x, y] = win.getPosition();
      fs.writeFileSync(stateFile(), JSON.stringify({ x, y, mode }));
    } catch (_e) { /* best effort */ }
  }, 400);
}

const sizeFor = (m) => (m === 'collapsed' ? [COLLAPSED_W, COLLAPSED_H] : [EXPANDED_W, lastExpandedH]);

function clampToWorkArea(x, y, w, h) {
  const wa = screen.getPrimaryDisplay().workArea;
  return [
    Math.max(wa.x, Math.min(Math.round(x), wa.x + wa.width - w)),
    Math.max(wa.y, Math.min(Math.round(y), wa.y + wa.height - h)),
  ];
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const st = loadState();
  mode = st.mode === 'collapsed' ? 'collapsed' : 'expanded';
  const [w, h] = sizeFor(mode);
  const sx = typeof st.x === 'number' ? st.x : wa.x + wa.width - w - 8;
  const sy = typeof st.y === 'number' ? st.y : wa.y + 12;
  const [x, y] = clampToWorkArea(sx, sy, w, h);

  win = new BrowserWindow({
    width: w, height: h, x, y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    vibrancy: mode === 'collapsed' ? undefined : 'under-window',
    visualEffectState: 'active',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: true,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('moved', saveState);                 // persist OS-level header drags too
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
}

// Resize keeping the window's current top-right corner fixed.
function setWindowSize(w, h) {
  if (!win || win.isDestroyed()) return;
  const wa = screen.getPrimaryDisplay().workArea;
  w = Math.ceil(w);
  h = Math.max(60, Math.min(Math.ceil(h), wa.height - 16));
  const b = win.getBounds();
  const [x, y] = clampToWorkArea(b.x + b.width - w, b.y, w, h);
  win.setBounds({ x, y, width: w, height: h });
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

async function startEngine() {
  if (started) return;
  started = true;
  agg = new TokenAggregator();
  send('status', { phase: 'scanning', done: 0, total: 0 });
  await agg.fullScan((done, total) => send('status', { phase: 'scanning', done, total }));
  send('status', { phase: 'live' });
  send('snapshot', agg.snapshot());
  timer = setInterval(async () => {
    try { await agg.incrementalScan(); send('snapshot', agg.snapshot()); } catch (_e) {}
  }, 2000);
}

function makeTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('⚡');
  tray.setToolTip('坨坨');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: () => { if (win) (win.isVisible() ? win.hide() : win.show()); } },
    {
      label: 'Reset position (top-right)',
      click: () => {
        if (!win) return;
        const wa = screen.getPrimaryDisplay().workArea;
        const [w] = win.getSize();
        win.setPosition(wa.x + wa.width - w - 8, wa.y + 12);
        saveState();
      },
    },
    { type: 'separator' },
    { label: 'Quit 坨坨', accelerator: 'Command+Q', click: () => app.quit() },
  ]));
  tray.on('click', () => { if (win) win.show(); });
}

ipcMain.on('renderer-ready', () => {
  send('init', { mode });                     // tell the renderer which view to show
  if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  startEngine();
});
ipcMain.on('quit', () => app.quit());

ipcMain.on('set-mode', (_e, m) => {
  mode = m === 'collapsed' ? 'collapsed' : 'expanded';
  if (win && !win.isDestroyed()) {
    try { win.setVibrancy(mode === 'collapsed' ? null : 'under-window'); } catch (_e) {}
  }
  const [w, h] = sizeFor(mode);
  setWindowSize(w, h);
  saveState();
});

ipcMain.on('fit-height', (_e, h) => {
  lastExpandedH = Math.ceil(h);
  if (mode === 'expanded') setWindowSize(EXPANDED_W, lastExpandedH);
});

ipcMain.on('drag-by', (_e, d) => {
  if (!win || win.isDestroyed() || !d) return;
  const [w, h] = win.getSize();
  const [x, y] = win.getPosition();
  const [nx, ny] = clampToWorkArea(x + (d.dx || 0), y + (d.dy || 0), w, h);
  win.setPosition(nx, ny);                     // 'moved' event persists it
});

// Single instance: the LaunchAgent and a manual double-click must never run two pets.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win && !win.isDestroyed()) win.show(); });

  app.whenReady().then(() => {
    createWindow();
    makeTray();
    if (app.dock) app.dock.hide();
  });

  app.on('window-all-closed', () => { /* stay resident in the tray */ });
  app.on('before-quit', () => { if (timer) clearInterval(timer); });
}
