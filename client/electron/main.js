import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, session, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nurofen desktop shell.
 *
 * The whole client (API, profile, tunnel, helper) lives in ../src/main.js and
 * runs inside this process. The shell only owns what a browser used to own:
 * the window, the tray and the application lifetime. That removes the
 * dependency on Edge/Chrome/Firefox and makes the window identical for
 * everyone.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.resolve(HERE, '..');
const UI_URL = 'http://127.0.0.1:39391/';
const UI_ORIGIN = new URL(UI_URL).origin;
const START_HIDDEN = process.argv.includes('--hidden') || process.argv.includes('--no-window');

// Utility panes open as small standalone windows instead of covering the
// connection screen. Keep their sizes fixed like the main window.
const TOOL_WINDOWS = {
  nickname: { width: 340, height: 300, title: 'Изменить ник' },
  settings: { width: 360, height: 560, title: 'Настройки' },
  update: { width: 360, height: 560, title: 'Обновления' },
  diagnostics: { width: 400, height: 600, title: 'Диагностика' },
  about: { width: 340, height: 400, title: 'О программе' },
  play: { width: 640, height: 700, title: 'Nurofen Play' },
  files: { width: 460, height: 620, title: 'Передачи файлов' },
  friends: { width: 420, height: 580, title: 'Друзья' },
  remote: { width: 720, height: 560, title: 'Удалённая помощь', resizable: true },
};

const ICON = [path.join(CLIENT, 'assets', 'nurofen.ico'), path.join(CLIENT, 'src', 'ui', 'nurofen.ico')]
  .find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || '';

let win = null;
let tray = null;
let trayMenu = null;
let trayTimer = null;
let quitting = false;
let quittingStarted = false;
let lastSignature = '';
let balloonShown = false;

app.setName('Nurofen');
app.setAppUserModelId('Nurofen');

// Every window opened by the UI is a tool window. Anything else is denied.
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    const kind = parsed.searchParams.get('tool');
    const tool = kind ? TOOL_WINDOWS[kind] : null;
    if (parsed.origin !== UI_ORIGIN || !tool) return { action: 'deny' };
    const resizable = tool.resizable === true;
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: tool.width,
        height: tool.height,
        ...(resizable ? { minWidth: 520, minHeight: 400 } : {}),
        resizable,
        maximizable: false,
        fullscreenable: false,
        show: false,
        title: `${tool.title} — Nurofen`,
        icon: ICON || undefined,
        backgroundColor: '#0b0d10',
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          spellcheck: false,
          devTools: false,
        },
      },
    };
  });

  contents.on('did-create-window', (child) => {
    child.setMenu(null);
    child.center();
    child.once('ready-to-show', () => {
      if (!child.isDestroyed()) child.show();
    });
  });
});

function log(message) {
  try {
    process.stdout.write(`[shell] ${message}\n`);
  } catch {
    // A GUI process may have no console; the backend log file still works.
  }
}

function createWindow() {
  if (win && !win.isDestroyed()) {
    showWindow();
    return;
  }

  win = new BrowserWindow({
    width: 460,
    height: 680,
    minWidth: 340,
    minHeight: 560,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: 'Nurofen',
    icon: ICON || undefined,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      devTools: false,
    },
  });

  win.setMenu(null);
  win.loadURL(UI_URL).catch(() => {});

  win.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame) return;
    // The backend may still be starting; retry shortly instead of showing an
    // error page that looks like the app is broken.
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.loadURL(UI_URL).catch(() => {});
    }, 500);
  });

  win.once('ready-to-show', () => {
    if (!START_HIDDEN) win.show();
  });

  win.on('close', (event) => {
    if (quitting) return;
    // Closing the window is "hide to tray", exactly like Radmin VPN.
    event.preventDefault();
    win.hide();
    if (!balloonShown && tray) {
      balloonShown = true;
      try {
        tray.displayBalloon({
          title: 'Nurofen работает',
          content: 'Окно скрыто в трей. Сеть продолжает работать в фоне.',
          iconType: 'info',
        });
      } catch {
        // Balloons are optional.
      }
    }
  });

  win.on('closed', () => {
    win = null;
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function trayStatus() {
  try {
    const res = await fetch(`${UI_URL}api/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    return await res.json();
  } catch {
    return null;
  }
}

async function toggleFromTray() {
  const status = await trayStatus();
  const list = Array.isArray(status?.networks) ? status.networks : [];
  const current = list.find((item) => item.id === status?.activeId) || list[0];
  if (!current) {
    showWindow();
    return;
  }
  try {
    await fetch(`${UI_URL}api/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'toggle' }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    // The backend reports the real error in the window.
  }
  setTimeout(refreshTray, 300);
}

function buildTrayMenu(status) {
  const list = Array.isArray(status?.networks) ? status.networks : [];
  const current = list.find((item) => item.id === status?.activeId) || list[0] || null;
  const connected = list.filter((item) => item.status === 'connected');
  const busy = current?.status === 'connecting';
  const stateLabel = !status
    ? 'Запуск…'
    : !list.length
      ? 'Нет сетей'
      : connected.length > 1
        ? `Включено сетей: ${connected.length}`
        : current?.status === 'connected'
          ? `В сети: ${current.network?.name || ''}`
          : busy
            ? 'Подключение…'
            : current?.status === 'error'
              ? 'Ошибка подключения'
              : 'Сеть выключена';

  return Menu.buildFromTemplate([
    { label: stateLabel, enabled: false },
    { type: 'separator' },
    { label: 'Открыть Nurofen', click: () => showWindow() },
    {
      label: current?.status === 'connected' ? 'Отключить сеть' : 'Включить сеть',
      enabled: Boolean(current) && !busy,
      click: () => toggleFromTray(),
    },
    { type: 'separator' },
    { label: 'Выход', click: () => quitApp() },
  ]);
}

async function refreshTray() {
  if (!tray) return;
  const status = await trayStatus();
  const list = Array.isArray(status?.networks) ? status.networks : [];
  const signature = JSON.stringify({
    active: status?.activeId || '',
    view: list.map((item) => `${item.id}:${item.status}:${item.network?.name || ''}`),
  });
  if (signature === lastSignature) return;
  lastSignature = signature;
  trayMenu = buildTrayMenu(status);

  const connected = list.filter((item) => item.status === 'connected');
  const current = list.find((item) => item.id === status?.activeId) || list[0];
  tray.setToolTip(
    !status
      ? 'Nurofen'
      : !list.length
        ? 'Nurofen — нет сетей'
        : connected.length > 1
          ? `Nurofen — включено сетей: ${connected.length}`
          : current?.status === 'connected'
            ? `Nurofen — в сети${current.network?.name ? ` «${current.network.name}»` : ''}`
            : 'Nurofen — сеть выключена',
  );
}

function createTray() {
  let image = ICON ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(process.execPath, '..', 'resources', 'electron.ico'));
  }
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Nurofen');

  // Left click opens the window, right click opens the menu. This is more
  // predictable than Tray.setContextMenu, which can swallow the left click.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  tray.on('right-click', () => {
    if (trayMenu) tray.popUpContextMenu(trayMenu);
  });

  refreshTray();
  trayTimer = setInterval(refreshTray, 2000);
}

async function quitApp() {
  if (quittingStarted) return;
  quittingStarted = true;
  quitting = true;
  if (trayTimer) clearInterval(trayTimer);
  try {
    await fetch(`${UI_URL}api/quit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // The backend may already be gone; quitting the shell is still correct.
  }
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}

function setupDownloadFolder() {
  // If the UI ever links a file, keep the familiar browser behaviour: drop it
  // into the Downloads folder instead of asking where to save.
  session.defaultSession.on('will-download', (event, item) => {
    try {
      item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
    } catch {
      // Fall back to Electron's default location.
    }
  });
}

/* ------------------------------------------------------- invite links */

const PROTOCOL = 'nurofen';
const STARTUP_INVITE = process.argv.find((arg) => String(arg).startsWith(`${PROTOCOL}://`)) || '';

function parseInviteUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== `${PROTOCOL}:`) return null;
    const name = (url.searchParams.get('name') || '').trim().slice(0, 32);
    const password = (url.searchParams.get('password') || '').slice(0, 64);
    if (!name || password.length < 4) return null;
    return { name, password };
  } catch {
    return null;
  }
}

/** The backend may still be starting, so retry until it accepts the invite. */
async function deliverInvite(raw) {
  const invite = parseInviteUrl(raw);
  if (!invite) return;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const res = await fetch(`${UI_URL}api/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(invite),
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) {
        showWindow();
        return;
      }
    } catch {
      // the backend is not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log('could not deliver the invite link');
}

/**
 * The installer registers the shortcut, but the registry entry can be lost
 * after a manual move or an update. Re-registering on every start is cheap.
 */
function registerProtocol() {
  try {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch {
    // an existing registry entry still works
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const url = argv.find((arg) => String(arg).startsWith(`${PROTOCOL}://`));
    if (url) {
      log('second instance with an invite link');
      deliverInvite(url);
      return;
    }
    log('second instance, focusing the window');
    showWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    deliverInvite(url);
  });

  globalThis.__nurofenElectron = {
    open() {
      createWindow();
    },
    focus() {
      showWindow();
    },
    quit() {
      quitApp();
    },
    notify({ title, body }) {
      try {
        const note = new Notification({
          title: String(title || 'Nurofen'),
          body: String(body || ''),
          icon: ICON || undefined,
        });
        note.on('click', () => showWindow());
        note.show();
      } catch {
        // notifications are optional
      }
    },
    async pickDirectory(title = 'Папка Minecraft') {
      const options = {
        title: String(title || 'Папка Minecraft'),
        buttonLabel: 'Выбрать',
        properties: ['openDirectory'],
      };
      const parent = win && !win.isDestroyed() ? win : null;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths?.length) return '';
      return result.filePaths[0];
    },
    async pickFile() {
      const options = {
        title: 'Исполняемый файл лаунчера',
        buttonLabel: 'Выбрать',
        properties: ['openFile'],
        filters: [{ name: 'Программы', extensions: ['exe'] }],
      };
      const parent = win && !win.isDestroyed() ? win : null;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths?.length) return '';
      return result.filePaths[0];
    },
    async pickDocument() {
      const options = {
        title: 'Файл для отправки',
        buttonLabel: 'Отправить',
        properties: ['openFile'],
        filters: [{ name: 'Все файлы', extensions: ['*'] }],
      };
      const parent = win && !win.isDestroyed() ? win : null;
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths?.length) return '';
      return result.filePaths[0];
    },
    reveal(target) {
      try {
        shell.showItemInFolder(String(target || ''));
      } catch {
        // revealing a file is optional
      }
    },
    restart() {
      if (quittingStarted) return;
      quittingStarted = true;
      quitting = true;
      if (trayTimer) clearInterval(trayTimer);
      app.relaunch();
      app.quit();
    },
  };

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    registerProtocol();
    setupDownloadFolder();
    createTray();

    try {
      // Starts the HTTP UI server, tunnel manager and auto-reconnect.
      await import('../src/main.js');
    } catch (error) {
      log(`backend failed: ${error?.stack || error}`);
    }

    if (STARTUP_INVITE) deliverInvite(STARTUP_INVITE);

    // Safety net: if the backend could not bind its port, still show something
    // useful instead of an invisible process.
    setTimeout(() => {
      if (!win) {
        log('backend did not open a window, opening one anyway');
        createWindow();
      }
    }, 12000);
  });

  // The tray keeps the process alive when every window is hidden.
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    quitting = true;
    if (trayTimer) clearInterval(trayTimer);
  });
}
