<div align="center">

<img src="https://gitee.com/cynicguguggaga/guga-reader/raw/master/assets/guga-duck.png" width="100" alt="咕嘎鸭">

# 咕嘎阅读

**本地 EPUB / TXT 电子书阅读器**

> 白云蓝 × 樱花粉，你的专属离线书房

[![平台](https://img.shields.io/badge/平台-Windows-blue?logo=windows)](https://gitee.com/cynicguguggaga/guga-reader/releases)
[![版本](https://img.shields.io/badge/版本-v1.0.0-pink)](https://gitee.com/cynicguguggaga/guga-reader/releases)
[![许可证](https://img.shields.io/badge/许可证-MIT-green)](LICENSE)

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 📚 **EPUB 阅读** | 完整解析 EPUB，章节目录、图片内嵌（base64）一应俱全 |
| 📄 **TXT 阅读** | 智能识别中英文章节标题，自动分章；无章节时每 500 行分节 |
| 🗂️ **书架文件夹** | 支持创建文件夹整理书籍，批量管理、全选删除 |
| 📖 **翻页模式** | 书卷式双开页翻页，图片自动单独成页并等比缩放 |
| 📜 **滚动模式** | 流畅连续滚动阅读（默认模式） |
| 🔖 **书签** | 翻页模式下一键打书签，跨会话持久保存 |
| 🌙 **夜间模式** | 多套主题（白天 / 夜间 / 棕褐 / 草绿 / 薰衣草） |
| 🔤 **字体调整** | 字号自由调节，行距同步跟随 |
| 🖼️ **图片处理** | 插图自动等比缩放到页面内，独立成页不遮挡文字 |
| 🦆 **咕嘎鸭** | 书架界面随机游荡的小鸭子动画（纯装饰，无实际功能） |
| 🔒 **单实例** | 重复打开时自动聚焦已有窗口，不会开多个 |

---

## 🖼️ 界面预览

### 书页模式（双开页翻页）

<img src="https://gitee.com/cynicguguggaga/guga-reader/raw/master/assets/reading-screenshot.png" width="85%" alt="书页模式">

> 插图自动等比缩放、单独成页，不会被文字遮挡

### 书架管理

<img src="https://gitee.com/cynicguguggaga/guga-reader/raw/master/assets/bookshelf-screenshot.png" width="85%" alt="书架">

> 拖拽导入、文件夹整理、批量管理，樱花花瓣飘落背景

---

## 🚀 快速开始

### 方式一：直接下载便携版（推荐）

前往 [Releases](https://gitee.com/cynicguguggaga/guga-reader/releases) 下载 `咕嘎阅读 1.0.0.exe`，**双击即用，无需安装**。

### 方式二：Web 版（无需安装）

直接双击 `index.html`，用 Chrome / Edge 浏览器打开即可。

> ⚠️ 浏览器安全限制：Web 版需手动选择文件导入，不支持自动读取本地路径。

### 方式三：从源码运行

```bash
# 1. 安装依赖（国内可先设置镜像）
npm config set registry https://registry.npmmirror.com
npm install

# 2. 开发运行
npm start

# 3. 打包便携版 exe
npm run build-portable

# 4. 打包 NSIS 安装包
npm run build-installer
```

---

## 📖 使用说明

### 导入书籍

- **拖拽**：直接把 `.epub` / `.txt` 文件拖到书架区域
- **按钮**：点击右上角「导入」按钮，支持单文件或整个文件夹
- **快捷键**：`Ctrl+O` 导入文件，`Ctrl+Shift+O` 导入文件夹

### 阅读模式切换

阅读器右上角工具栏可切换：
- **滚动模式**（默认）：上下连续滚动
- **翻页模式**：左右翻页，书卷式双开页布局，支持键盘/鼠标翻页

### 快捷键

| 按键 | 功能 |
|------|------|
| `←` / `PageUp` | 上一页（翻页模式） |
| `→` / `空格` / `PageDown` | 下一页（翻页模式） |
| `F` | 切换全屏 |
| `F11` | 系统全屏（桌面版） |
| `Ctrl+O` | 导入文件 |
| `Ctrl+Shift+O` | 导入文件夹 |

### 书架管理

- **新建文件夹**：点击「+ 新建文件夹」，拖动书籍到文件夹中整理
- **批量管理**：右上角「管理」按钮，支持全选、多选删除
- **书签**：翻页模式下点击 🔖 按钮，下次打开自动跳转

### 章节识别（TXT）

自动识别以下章节格式：

```
第一章 xxx / 第二节 xxx / 第三卷 xxx
第1章 / 第123节
Chapter 1 / CHAPTER 1
1. 标题 / 01、标题
```

---

## 🛠️ 技术栈

- **Electron** — 桌面应用框架
- **JSZip** — EPUB 解压解析
- **IndexedDB** — 本地书库持久化
- **Canvas** — 书架背景动画（咕嘎鸭）
- **electron-builder** — 打包工具

---

## 📦 项目结构

```
reader/
├── index.html          # 主界面（书架 + 阅读器双视图）
├── app.js              # 核心逻辑（~2500 行）
├── style.css           # 样式（5 套主题）
├── main.js             # Electron 主进程
├── preload.js          # 预加载脚本
├── assets/             # 图标资源
└── lib/
    └── jszip.min.js    # EPUB 解析库
```

---

## 📝 开发计划

- [ ] 全文搜索
- [ ] 自定义字体
- [ ] 阅读统计
- [ ] 书单导出
- [ ] macOS / Linux 支持

---

<div align="center">

Made with <img src="https://gitee.com/cynicguguggaga/guga-reader/raw/master/assets/guga-duck.png" width="18" alt="咕嘎鸭"> by cynic3

</div>
