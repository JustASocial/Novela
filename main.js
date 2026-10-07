'use strict';

// Novela — Electron main process.
// Responsibilities: window lifecycle, backend (Novela.Core) discovery +
// health checks, file dialogs, and the obfuscation job bridge (spawn per job
// over the --stdin JSON protocol). No UI logic lives here.

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CORE_VERSION = '1.0.0';
let mainWindow = null;
let backendInfo = { available: false, path: null, version: null, lastError: null };

// ---- persistent main-process settings (server, tray, autostart) ----
const SERVER_DEFAULTS = {
  serverPort: 4477,
  serverToken: '',
  serverAutostart: false,
  appAutostart: false,
  minimizeToTray: true,
};

function settingsFile() {
  try {
    return path.join(app.getPath('userData'), 'novela-server.json');
  } catch {
    return path.join(__dirname, 'novela-server.json');
  }
}

function loadMainSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    return { ...SERVER_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...SERVER_DEFAULTS };
  }
}

function saveMainSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8');
  } catch { /* ignore */ }
}

let mainSettings = loadMainSettings();

// ---- local API server child process ----
let serverProc = null;
let serverState = { running: false, port: null, pid: null, error: null };
let tray = null;

function serverExe() {
  const exe = backendInfo.path || pickBackend();
  return exe;
}

function startLocalServer(port, token) {
  stopLocalServer();
  const exe = serverExe();
  if (!exe) {
    serverState = { running: false, port: null, pid: null, error: 'Backend executable not found.' };
    updateTrayMenu();
    return Promise.resolve(serverState);
  }
  const args = ['serve', '--port', String(port)];
  if (token) args.push('--token', token);
  let cmd = exe;
  if (exe.endsWith('.dll')) {
    args.unshift(exe);
    cmd = 'dotnet';
  }
  try {
    serverProc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    serverState = { running: false, port: null, pid: null, error: String(err && err.message || err) };
    updateTrayMenu();
    return Promise.resolve(serverState);
  }
  serverState = { running: false, port, pid: serverProc.pid || null, error: null, starting: true };
  let stderrTail = '';
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', (d) => { stderrTail += d.toString('utf8').slice(-500); });
  const me = serverProc;
  serverProc.on('error', (err) => {
    if (serverProc !== me) return;
    serverState = { running: false, port: null, pid: null, error: String(err && err.message || err) };
    updateTrayMenu();
    pushServerStatus();
  });
  serverProc.on('close', (code) => {
    if (serverProc !== me) return;
    serverState = { running: false, port: null, pid: null, error: code === 0 ? null : ('Server exited (code ' + code + '). ' + stderrTail).trim() };
    updateTrayMenu();
    pushServerStatus();
  });
  // Verify the port answers before reporting "running".
  return waitForServerHealth(port, token, 8000).then((ok) => {
    if (serverProc !== me) return serverState;
    if (ok) {
      serverState = { running: true, port, pid: me.pid || null, error: null };
    } else {
      serverState = { running: false, port: null, pid: null, error: 'Server did not answer on :' + port + '. ' + stderrTail };
      try { me.kill(); } catch { /* ignore */ }
      serverProc = null;
    }
    updateTrayMenu();
    pushServerStatus();
    return serverState;
  });
}

function waitForServerHealth(port, token, timeoutMs) {
  const http = require('http');
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/api/health', timeout: 1500 },
        (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => {
            try {
              resolve(JSON.parse(body).status === 'ok');
            } catch {
              resolve(false);
            }
          });
        }
      );
      req.on('timeout', () => { req.destroy(); retry(); });
      req.on('error', () => retry());
      function retry() {
        if (Date.now() >= deadline) resolve(false);
        else setTimeout(attempt, 400);
      }
    };
    attempt();
  });
}

function stopLocalServer() {
  if (serverProc) {
    try { serverProc.kill(); } catch { /* ignore */ }
    serverProc = null;
  }
  if (serverState.running) {
    serverState = { running: false, port: null, pid: null, error: null };
    updateTrayMenu();
  }
  return serverState;
}

function pushServerStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('novela:server-status', serverState);
  }
}

// ---- tray ----
function trayIcon() {
  try {
    const p = appIconPath();
    if (!p) return null;
    const img = nativeImage.createFromPath(p);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

function ensureTray() {
  if (tray) return;
  const img = trayIcon();
  if (!img) return;
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Novela');
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const s = serverState;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: 'Show Novela',
      click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } },
    },
    {
      label: s.running ? `Stop local server (:${s.port})` : 'Start local server',
      click: async () => {
        if (serverState.running) { stopLocalServer(); }
        else {
          await refreshBackendStatus();
          await startLocalServer(mainSettings.serverPort, mainSettings.serverToken);
        }
        pushServerStatus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => { app.quit(); },
    },
  ]));
}

function resolveBackendCandidates() {
  const candidates = [];
  const envOverride = process.env.NOVELA_CORE_PATH;
  if (envOverride) candidates.push(envOverride);

  if (app.isPackaged) {
    // electron-builder extraResources -> <resources>/core/
    candidates.push(path.join(process.resourcesPath, 'core', coreExeName()));
    candidates.push(path.join(process.resourcesPath, 'core', 'Novela.Core.dll'));
  } else {
    // Dev layout: published single-file/folder build, then plain build output.
    candidates.push(path.join(__dirname, 'core-dist', coreExeName()));
    candidates.push(path.join(__dirname, 'core', 'Novela.Core', 'bin', 'Release', 'net8.0', 'win-x64', 'Novela.Core.exe'));
    candidates.push(path.join(__dirname, 'core', 'Novela.Core', 'bin', 'Debug', 'net8.0', 'Novela.Core.dll'));
    candidates.push(path.join(__dirname, 'core', 'Novela.Core', 'bin', 'Debug', 'net8.0', 'win-x64', 'Novela.Core.exe'));
  }
  return candidates;
}

function coreExeName() {
  return process.platform === 'win32' ? 'Novela.Core.exe' : 'Novela.Core';
}

function appIconPath() {
  try {
    const packaged = path.join(process.resourcesPath, 'icon.png');
    if (app.isPackaged && fs.existsSync(packaged)) return packaged;
    const dev = path.join(__dirname, 'assets', 'icon.png');
    if (fs.existsSync(dev)) return dev;
  } catch { /* ignore */ }
  return undefined;
}
function pickBackend() {
  for (const p of resolveBackendCandidates()) {
    try {
      if (p && fs.existsSync(p)) {
        // Unix apphosts can lose the exec bit through packagers; restore it.
        if (process.platform !== 'win32' && !p.endsWith('.dll')) {
          try { fs.chmodSync(p, 0o755); } catch { /* best effort */ }
        }
        return p;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/** Spawn the backend with given argv, optional stdin payload. Resolves {code, stdout, stderr}. */
function spawnBackend(argv, stdinText, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const exe = backendInfo.path;
    if (!exe) {
      resolve({ code: -1, stdout: '', stderr: 'Backend executable not found.' });
      return;
    }
    let cmd, args;
    if (exe.endsWith('.dll')) {
      cmd = 'dotnet';
      args = [exe, ...argv];
    } else {
      cmd = exe;
      args = argv;
    }
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    const kill = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      stderr += '\n[timeout] backend did not respond in time.';
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += outDec.write(d); });
    child.stderr.on('data', (d) => { stderr += errDec.write(d); });
    child.on('error', (err) => {
      clearTimeout(kill);
      resolve({ code: -1, stdout, stderr: stderr + String(err && err.message || err) });
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      stdout += outDec.end();
      stderr += errDec.end();
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
    if (stdinText) {
      child.stdin.write(stdinText, 'utf8');
    }
    child.stdin.end();
  });
}

async function refreshBackendStatus() {
  const exe = pickBackend();
  backendInfo.path = exe;
  backendInfo.available = false;
  backendInfo.version = null;
  backendInfo.lastError = null;
  if (!exe) {
    backendInfo.lastError = 'Novela.Core executable not found. Run "npm run build:core" or set NOVELA_CORE_PATH.';
    return backendInfo;
  }
  const res = await spawnBackend(['ping'], null, 15000);
  if (res.code === 0) {
    try {
      const payload = JSON.parse(res.stdout.trim().split('\n').pop());
      if (payload && payload.status === 'ok') {
        backendInfo.available = true;
        backendInfo.version = payload.version || CORE_VERSION;
        return backendInfo;
      }
      backendInfo.lastError = 'Unexpected ping response.';
    } catch (err) {
      backendInfo.lastError = 'Could not parse backend response: ' + (err && err.message);
    }
  } else {
    backendInfo.lastError = (res.stderr || 'Backend process exited with code ' + res.code).trim().slice(0, 500);
  }
  return backendInfo;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    backgroundColor: '#191919',
    title: 'Novela',
    icon: appIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  let quitting = false;
  mainWindow.on('close', (e) => {
    if (!quitting && mainSettings.minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.on('did-finish-load', async () => {
    await refreshBackendStatus();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('novela:backend-status', backendInfo);
      mainWindow.webContents.send('novela:server-status', serverState);
    }
  });

  app.on('before-quit', () => { quitting = true; });
}

// ---- IPC ----

ipcMain.handle('novela:backend-status', async () => {
  await refreshBackendStatus();
  return backendInfo;
});

ipcMain.handle('novela:ping', async () => {
  await refreshBackendStatus();
  return backendInfo;
});

ipcMain.handle('novela:presets', async () => {
  if (!backendInfo.path) await refreshBackendStatus();
  if (!backendInfo.path) return { ok: false, error: backendInfo.lastError || 'Backend not found.' };
  const res = await spawnBackend(['presets'], null, 15000);
  if (res.code !== 0) return { ok: false, error: res.stderr.trim().slice(0, 500) || 'presets command failed' };
  try {
    return { ok: true, presets: JSON.parse(res.stdout) };
  } catch (err) {
    return { ok: false, error: 'Could not parse presets response.' };
  }
});

ipcMain.handle('novela:obfuscate', async (_event, job) => {
  if (!job || typeof job.source !== 'string') {
    return { ok: false, error: 'Invalid job: missing source.' };
  }
  if (!backendInfo.path) await refreshBackendStatus();
  if (!backendInfo.available || !backendInfo.path) {
    return { ok: false, error: backendInfo.lastError || 'Backend is not available.' };
  }
  const payload = JSON.stringify({
    source: job.source,
    options: job.options || {},
    seed: typeof job.seed === 'number' ? job.seed : 0,
  });
  const res = await spawnBackend(['obfuscate', '--stdin'], payload, 180000);
  if (res.code !== 0 && !res.stdout.trim()) {
    return { ok: false, error: (res.stderr.trim() || 'Backend job failed.').slice(0, 1000) };
  }
  try {
    const lastLine = res.stdout.trim().split('\n').pop();
    const data = JSON.parse(lastLine);
    if (!data.success) return { ok: false, error: data.error || 'Obfuscation failed.', logs: data.logs || [] };
    return { ok: true, output: data.output, stats: data.stats, logs: data.logs || [] };
  } catch (err) {
    return { ok: false, error: 'Could not parse backend result: ' + (err && err.message) };
  }
});

ipcMain.handle('novela:open-file', async () => {
  const res = await dialog.showOpenDialog({
    title: 'Open Luau script',
    properties: ['openFile'],
    filters: [
      { name: 'Luau scripts', extensions: ['lua', 'luau', 'txt'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
  try {
    const content = fs.readFileSync(res.filePaths[0], 'utf8');
    return { ok: true, path: res.filePaths[0], content };
  } catch (err) {
    return { ok: false, error: 'Could not read file: ' + (err && err.message) };
  }
});

ipcMain.handle('novela:save-file', async (_event, { content, defaultName }) => {  const res = await dialog.showSaveDialog({
    title: 'Save obfuscated script',
    defaultPath: defaultName || 'obfuscated.lua',
    filters: [{ name: 'Luau scripts', extensions: ['lua', 'luau'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, content || '', 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: 'Could not write file: ' + (err && err.message) };
  }
});

// ---- paste services (Pastebin / Pastefy) ----
// Uploads run here (Node http stack) so browser CORS policies never apply.

function httpsPost(url, headers, bodyText, timeoutMs = 30000) {
  const https = require('https');
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      resolve({ ok: false, status: 0, body: 'Invalid URL.' });
      return;
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': headers['Content-Type'] || 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(bodyText),
          'User-Agent': 'Novela/1.2.0',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          resolve({ ok: true, status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, body: String(err && err.message || err) });
    });
    req.setTimeout(timeoutMs);
    req.write(bodyText);
    req.end();
  });
}

async function uploadPastebin(apiKey, name, content) {
  const form =
    'api_dev_key=' + encodeURIComponent(apiKey) +
    '&api_option=paste' +
    '&api_paste_code=' + encodeURIComponent(content) +
    '&api_paste_name=' + encodeURIComponent(name) +
    '&api_paste_private=1' +
    '&api_paste_expire_date=N';
  const res = await httpsPost('https://pastebin.com/api/api_post.php',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, form);
  if (!res.ok) return { ok: false, error: 'Network error: ' + res.body };
  const text = (res.body || '').trim();
  if (!text || text.startsWith('Bad API request')) {
    return { ok: false, error: text || 'Empty response from Pastebin.' };
  }
  const id = text.split('/').pop();
  return { ok: true, url: text, raw: 'https://pastebin.com/raw/' + id };
}

async function uploadPastefy(apiKey, name, content) {
  const res = await httpsPost('https://pastefy.app/api/v2/paste',
    { Authorization: 'Bearer ' + apiKey },
    JSON.stringify({ title: name, content }));
  if (!res.ok) return { ok: false, error: 'Network error: ' + res.body };
  let data;
  try {
    data = JSON.parse(res.body);
  } catch {
    return { ok: false, error: 'Invalid response from Pastefy (HTTP ' + res.status + ').' };
  }
  if (res.status !== 200 || !data || !data.paste || !data.paste.id) {
    const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
    return { ok: false, error: 'Pastefy: ' + msg };
  }
  const raw = (data.paste.raw_url && String(data.paste.raw_url).startsWith('http'))
    ? String(data.paste.raw_url)
    : 'https://pastefy.app/' + data.paste.id + '/raw';
  return { ok: true, url: 'https://pastefy.app/' + data.paste.id, raw };
}

ipcMain.handle('novela:paste-upload', async (_event, job) => {
  const provider = job && job.provider === 'pastefy' ? 'pastefy' : 'pastebin';
  const key = job && typeof job.key === 'string' ? job.key.trim() : '';
  const name = job && typeof job.name === 'string' && job.name ? job.name : 'novela';
  const content = job && typeof job.content === 'string' ? job.content : '';
  if (!key) return { ok: false, error: 'Missing API key. Set it in Settings first.' };
  if (!content) return { ok: false, error: 'Nothing to upload: output is empty.' };
  if (content.length > 900000) return { ok: false, error: 'Content too large for paste services.' };
  try {
    if (provider === 'pastefy') return await uploadPastefy(key, name, content);
    return await uploadPastebin(key, name, content);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});
// Frameless window controls (renderer has custom top app bar).
ipcMain.on('novela:window', (_event, action) => {
  if (!mainWindow) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'toggle-maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
  else if (action === 'hide') mainWindow.hide();
  else if (action === 'show') { mainWindow.show(); mainWindow.focus(); }
});

// ---- local API server + autostart ----

ipcMain.handle('novela:server-settings', async () => ({ ...mainSettings }));

ipcMain.handle('novela:server-save', async (_event, patch) => {
  mainSettings = { ...mainSettings, ...(patch || {}) };
  mainSettings.serverPort = Math.max(1, Math.min(65535, Number(mainSettings.serverPort) || 4477));
  mainSettings.serverToken = String(mainSettings.serverToken || '');
  saveMainSettings(mainSettings);
  applyAutostart();
  return { ...mainSettings };
});

ipcMain.handle('novela:server-status', async () => ({ ...serverState }));

ipcMain.handle('novela:server-start', async (_event, opts) => {
  const port = Math.max(1, Math.min(65535, Number((opts && opts.port) || mainSettings.serverPort) || 4477));
  const token = String((opts && opts.token) || mainSettings.serverToken || '');
  mainSettings.serverPort = port;
  mainSettings.serverToken = token;
  saveMainSettings(mainSettings);
  await refreshBackendStatus();
  await startLocalServer(port, token);
  pushServerStatus();
  return { ...serverState };
});

ipcMain.handle('novela:server-stop', async () => {
  stopLocalServer();
  pushServerStatus();
  return { ...serverState };
});

function applyAutostart() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!mainSettings.appAutostart,
      args: mainSettings.serverAutostart ? ['--novela-serve'] : [],
    });
  } catch { /* not supported on this platform */ }
}

app.whenReady().then(() => {
  ensureTray();
  applyAutostart();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (mainSettings.serverAutostart) {
    refreshBackendStatus().then(() => {
      startLocalServer(mainSettings.serverPort, mainSettings.serverToken);
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => {
  stopLocalServer();
});
