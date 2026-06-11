/**
 * 咕嘎阅读 · Electron Preload Script
 * preload.js - 安全地将 Electron API 暴露给渲染进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 读取本地文件为 ArrayBuffer
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // 扫描文件夹中的 epub/txt 文件
  scanFolder: (folderPath) => ipcRenderer.invoke('scan-folder', folderPath),

  // 打开文件选择对话框
  openFileDialog: () => ipcRenderer.invoke('dialog-open-files'),

  // 打开文件夹选择对话框
  openFolderDialog: () => ipcRenderer.invoke('dialog-open-folder'),

  // 获取用户数据目录路径
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),

  // 监听从菜单触发的导入事件
  onImportFiles: (callback) => ipcRenderer.on('import-files', (event, filePaths) => callback(filePaths)),
  onImportFolder: (callback) => ipcRenderer.on('import-folder', (event, folderPath) => callback(folderPath)),

  // 判断是否在 Electron 环境
  isElectron: true
});
