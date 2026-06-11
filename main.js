/**
 * 咕嘎阅读 · Electron 主进程
 * main.js - 桌面版优化
 */

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

// ===== 单实例锁 =====
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  // 已有实例在运行，直接退出
  app.exit(0);
}

app.on('second-instance', () => {
  // 第二个实例被启动时，聚焦已有窗口
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
// ======================

// 保持窗口引用
let mainWindow = null;
let tray = null;
let isQuitting = false;

// 窗口状态持久化路径
const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
  } catch {}
  return { width: 1280, height: 800, x: undefined, y: undefined, isMaximized: false };
}

function saveWindowState() {
  if (!mainWindow) return;
  const bounds = mainWindow.getBounds();
  const state = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    isMaximized: mainWindow.isMaximized()
  };
  try {
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}
}

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedState.width,
    height: savedState.height,
    x: savedState.x,
    y: savedState.y,
    minWidth: 800,
    minHeight: 600,
    title: '咕嘎阅读',
    backgroundColor: '#fdf0f5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // 窗口图标（Windows任务栏）
    ...(process.platform === 'win32' ? { icon: path.join(__dirname, 'assets', 'icon.png') } : {})
  });

  if (savedState.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  });

  // 窗口状态自动保存
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized()) saveWindowState();
  });
  mainWindow.on('move', () => saveWindowState());
  mainWindow.on('maximize', saveWindowState);
  mainWindow.on('unmaximize', saveWindowState);

  mainWindow.on('close', (e) => {
    // 最小化到托盘而不是退出（可选）
    if (tray && !isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      return;
    }
    saveWindowState();
  });

  mainWindow.on('closed', () => { mainWindow = null; });

  // 构建托盘和菜单
  buildMenu();
  createTray();

  // 注册全局快捷键
  registerShortcuts();
}

// ===== 系统托盘 =====
function createTray() {
  // 用SVG转数据URI做托盘图标（16x16）
  const trayIconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  if (!fs.existsSync(trayIconPath)) return;

  tray = new Tray(trayIconPath);
  tray.setToolTip('咕嘎阅读 🦆');

  const trayMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { if (mainWindow) mainWindow.show(); } },
    {
      label: '快速导入文件',
      click: async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
          title: '选择书籍文件',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: '电子书', extensions: ['epub', 'txt'] }]
        });
        if (!result.canceled && result.filePaths.length > 0) {
          if (mainWindow) mainWindow.show();
          mainWindow.webContents.send('import-files', result.filePaths);
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出咕嘎阅读',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(trayMenu);
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ===== 全局快捷键 =====
function registerShortcuts() {
  // Ctrl+Shift+G 显示/隐藏窗口
  globalShortcut.register('CommandOrControl+Shift+G', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && mainWindow.isFocused()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ===== 菜单 =====
function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about', label: '关于咕嘎阅读' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: '文件',
      submenu: [
        {
          label: '导入书籍文件',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: '选择书籍文件',
              properties: ['openFile', 'multiSelections'],
              filters: [
                { name: '电子书', extensions: ['epub', 'txt'] },
                { name: 'EPUB电子书', extensions: ['epub'] },
                { name: '文本文件', extensions: ['txt'] }
              ]
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('import-files', result.filePaths);
            }
          }
        },
        {
          label: '导入书籍文件夹',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: '选择包含书籍的文件夹',
              properties: ['openDirectory']
            });
            if (!result.canceled && result.filePaths.length > 0) {
              mainWindow.webContents.send('import-folder', result.filePaths[0]);
            }
          }
        },
        { type: 'separator' },
        {
          label: '打开书架数据目录',
          click: () => {
            shell.openPath(app.getPath('userData'));
          }
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'forceReload', label: '强制刷新' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏模式', accelerator: 'F11' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于咕嘎阅读',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于咕嘎阅读',
              message: '🦆 咕嘎阅读 v1.0',
              detail: '一只可爱的鸭鸭陪你读小说~\n\n'
                + '支持 EPUB / TXT 格式\n'
                + '支持章节自动识别\n'
                + '书架数据本地储存\n'
                + '二次元白云蓝×樱花粉主题\n\n'
                + '快捷键：\n'
                + '方向键 ← → 或 空格键 翻页\n'
                + 'F 切换全屏\n'
                + 'Ctrl+O 导入文件\n'
                + 'Ctrl+Shift+G 显示/隐藏窗口',
              buttons: ['咕嘎~ 知道了!']
            });
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ===== IPC 处理 =====

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    return { success: true, buffer: buffer.buffer, name: path.basename(filePath) };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('scan-folder', async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath);
    const files = entries
      .filter(f => /\.(epub|txt)$/i.test(f))
      .map(f => ({
        name: f,
        path: path.join(folderPath, f)
      }));
    return { success: true, files };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('dialog-open-files', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择书籍文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '电子书', extensions: ['epub', 'txt'] }]
  });
  return result;
});

ipcMain.handle('dialog-open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择书籍文件夹',
    properties: ['openDirectory']
  });
  return result;
});

// 获取用户数据路径（供渲染进程使用）
ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('before-quit', () => {
  isQuitting = true;
});
