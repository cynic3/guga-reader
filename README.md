# 云墨阅读 · 使用说明

## Web版（直接使用，无需安装）

直接双击 `index.html` 用浏览器打开即可。

> ⚠️ 由于浏览器安全限制，Web版需要手动选择文件导入，不支持自动读取本地路径。
> 推荐使用 Chrome / Edge 浏览器以获得最佳体验。

---

## 桌面版（Electron）编译步骤

### 前置要求
- Node.js >= 16（https://nodejs.org）
- 网络可访问 npm（或配置国内镜像）

### 步骤 1：安装依赖

```bash
cd reader
npm install
```

如网络较慢，可先设置淘宝镜像：

```bash
npm config set registry https://registry.npmmirror.com
npm install
```

### 步骤 2：开发运行

```bash
npm start
```

这将直接打开 Electron 桌面窗口，无需安装。

### 步骤 3：打包成安装程序

**Windows（.exe 安装包）：**
```bash
npm run build-installer
```
生成文件在 `dist/` 目录下，双击 `.exe` 即可安装。

**打包为免安装目录：**
```bash
npm run build
```

---

## 功能说明

| 功能 | Web版 | 桌面版 |
|------|-------|--------|
| 导入单个文件 | ✅ | ✅ |
| 导入文件夹 | ✅（需选择文件夹）| ✅（支持菜单/按钮） |
| EPUB解析 | ✅ | ✅ |
| TXT章节识别 | ✅ | ✅ |
| 书架持久化 | ✅ IndexedDB | ✅ IndexedDB |
| 全屏阅读 | ✅ | ✅ |
| 阅读进度保存 | ✅ | ✅ |
| 拖拽导入 | ✅ | ✅ |

---

## 快捷键

| 按键 | 功能 |
|------|------|
| `←` / `PageUp` | 向上翻页 |
| `→` / `空格` / `PageDown` | 向下翻页 |
| `F` | 切换全屏 |
| `Ctrl+O` | 导入文件（桌面版） |
| `Ctrl+Shift+O` | 导入文件夹（桌面版） |
| `F11` | 全屏模式（桌面版） |

---

## 支持的章节识别格式

TXT文件自动识别以下章节格式：
- `第一章 xxx` / `第二节 xxx` / `第三卷 xxx`
- `第1章` / `第123节`
- `Chapter 1` / `CHAPTER 1`
- `1. 标题` / `01、标题`

若未识别到章节，自动每500行分为一节。
