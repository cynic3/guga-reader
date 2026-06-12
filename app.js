/* ============================================================
   咕嘎阅读 app.js
   支持：EPUB解析 / TXT章节划分 / IndexedDB持久化书架 / 设置持久化
   ============================================================ */

'use strict';

// ===== Electron 环境检测 =====
const isElectron = typeof window !== 'undefined' && window.electronAPI?.isElectron === true;

// ===== 全局状态 =====
const state = {
  books: [],            // 书架书目列表
  folders: [],          // 书架文件夹 [{id, name, color}]
  currentBook: null,    // 当前打开的书
  currentChapter: 0,    // 当前章节索引
  viewMode: 'grid',     // 'grid' | 'list'
  readingMode: 'scroll',// 'scroll' | 'paginate'
  pageIndex: 0,         // 翻页模式当前spread索引
  settings: {
    fontSize: 18,
    lineHeight: 1.9,
    contentWidth: 680,
    theme: 'paper',
    font: "'Noto Serif SC', 'SimSun', serif"
  }
};

// ===== IndexedDB =====
const DB_NAME = 'GuGaReader';
const DB_VER = 2;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('books')) {
        d.createObjectStore('books', { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains('folders')) {
        d.createObjectStore('folders', { keyPath: 'id' });
      }
    };
    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readonly');
    const req = tx.objectStore('books').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(book) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    tx.objectStore('books').put(book);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    tx.objectStore('books').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// 文件夹操作
function dbGetFolders() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('folders', 'readonly');
    const req = tx.objectStore('folders').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbPutFolder(folder) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').put(folder);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
function dbDeleteFolder(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('folders', 'readwrite');
    tx.objectStore('folders').delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ===== 设置持久化 =====
function loadSettings() {
  try {
    const saved = localStorage.getItem('guga_settings');
    if (saved) Object.assign(state.settings, JSON.parse(saved));
  } catch {}
}
function saveSettings() {
  localStorage.setItem('guga_settings', JSON.stringify(state.settings));
}

function applySettings() {
  const { fontSize, lineHeight, contentWidth, theme, font } = state.settings;
  document.documentElement.style.setProperty('--font-size', fontSize + 'px');
  document.documentElement.style.setProperty('--line-height', lineHeight);
  document.documentElement.style.setProperty('--content-width', contentWidth + 'px');
  document.documentElement.style.setProperty('--reader-font', font);

  // 主题
  document.body.className = document.body.className
    .replace(/theme-\w+/, '').trim();
  document.body.classList.add('theme-' + theme);

  // toolbar/footer 背景跟随主题
  const themeColors = {
    paper: '245,240,232',
    white: '255,255,255',
    green: '227,237,224',
    dark: '30,30,46',
    sepia: '244,228,196'
  };
  document.documentElement.style.setProperty('--reader-bg-rgb', themeColors[theme] || '245,240,232');

  // 更新设置面板UI
  $id('fs-value').textContent = fontSize;
  $id('lh-value').textContent = lineHeight;
  $id('width-value').textContent = contentWidth;
  $id('line-height-slider').value = lineHeight;
  $id('width-slider').value = contentWidth;
  $id('font-select').value = font;
  document.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.theme === theme);
  });
}

// ===== EPUB 解析 =====
async function parseEpub(arrayBuffer, fileName) {
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 找 container.xml -> content.opf 路径
  const containerXml = await zip.file('META-INF/container.xml').async('text');
  const rootfileMatch = containerXml.match(/full-path="([^"]+\.opf)"/i);
  if (!rootfileMatch) throw new Error('找不到 OPF 文件');
  const opfPath = rootfileMatch[1];
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  const opfText = await zip.file(opfPath).async('text');
  const parser = new DOMParser();
  const opfDoc = parser.parseFromString(opfText, 'application/xml');

  // 书名 & 作者
  const title = opfDoc.querySelector('metadata > title, metadata > *|title')?.textContent?.trim() || fileName.replace(/\.epub$/i, '');
  const author = opfDoc.querySelector('metadata > creator, metadata > *|creator')?.textContent?.trim() || '未知作者';

  // manifest：id -> href
  const manifest = {};
  opfDoc.querySelectorAll('manifest item').forEach(item => {
    manifest[item.getAttribute('id')] = {
      href: opfDir + item.getAttribute('href'),
      mediaType: item.getAttribute('media-type')
    };
  });

  // spine：章节顺序
  const spineItems = [...opfDoc.querySelectorAll('spine itemref')].map(ref => ref.getAttribute('idref'));

  // 获取封面（多层 fallback）
  let coverBase64 = null;

  // Fallback 1: 从 manifest 的 coverId 获取
  const coverId = opfDoc.querySelector('meta[name="cover"]')?.getAttribute('content');
  if (coverId && manifest[coverId]) {
    try {
      const coverHref = manifest[coverId].href;
      let coverFile = zip.file(coverHref);
      // 尝试 decodeURIComponent
      if (!coverFile) {
        try { coverFile = zip.file(decodeURIComponent(coverHref)); } catch {}
      }
      // 尝试不区分大小写匹配
      if (!coverFile) {
        const lowerHref = coverHref.toLowerCase();
        const allNames = Object.keys(zip.files);
        const found = allNames.find(n => n.toLowerCase() === lowerHref);
        if (found) coverFile = zip.file(found);
      }
      // 尝试只匹配文件名
      if (!coverFile) {
        const fileNameOnly = coverHref.split('/').pop();
        const allNames = Object.keys(zip.files);
        const found = allNames.find(n => n.split('/').pop().toLowerCase() === fileNameOnly.toLowerCase());
        if (found) coverFile = zip.file(found);
      }

      if (coverFile) {
        const coverData = await coverFile.async('base64');
        const mt = manifest[coverId].mediaType || 'image/jpeg';
        coverBase64 = `data:${mt};base64,${coverData}`;
      }
    } catch {}
  }

  // Fallback 2: 从 guide 里找封面 HTML，解析其中的 img
  if (!coverBase64) {
    const coverGuide = opfDoc.querySelector('guide reference[type="cover"]');
    if (coverGuide) {
      try {
        const guideHref = opfDir + coverGuide.getAttribute('href').split('#')[0];
        let guideFile = zip.file(guideHref);
        if (!guideFile) guideFile = zip.file(decodeURIComponent(guideHref));
        if (guideFile) {
          const guideHtml = await guideFile.async('text');
          const guideDoc = parser.parseFromString(guideHtml, 'text/html');
          const coverImg = guideDoc.querySelector('img');
          if (coverImg) {
            const src = coverImg.getAttribute('src');
            if (src) {
              const resolvedPath = resolveHref(guideHref, src);
              let imgFile = zip.file(resolvedPath);
              if (!imgFile) imgFile = zip.file(decodeURIComponent(resolvedPath));
              if (!imgFile) {
                const fileNameOnly = resolvedPath.split('/').pop();
                const allNames = Object.keys(zip.files);
                const found = allNames.find(n => n.endsWith(fileNameOnly));
                if (found) imgFile = zip.file(found);
              }
              if (imgFile) {
                const imgData = await imgFile.async('base64');
                const ext = src.split('.').pop().toLowerCase();
                const mimeMap = { 'png':'image/png', 'gif':'image/gif', 'svg':'image/svg+xml', 'webp':'image/webp', 'jpg':'image/jpeg', 'jpeg':'image/jpeg' };
                const mime = mimeMap[ext] || 'image/jpeg';
                coverBase64 = `data:${mime};base64,${imgData}`;
              }
            }
          }
        }
      } catch {}
    }
  }

  // Fallback 3: 扫描所有图片文件，找文件名含 cover 的
  if (!coverBase64) {
    const allNames = Object.keys(zip.files);
    const coverFileNames = allNames.filter(n => {
      const lower = n.toLowerCase();
      return lower.includes('cover') && /\.(jpg|jpeg|png|gif|webp)$/i.test(n);
    });
    if (coverFileNames.length > 0) {
      try {
        const coverFile = zip.file(coverFileNames[0]);
        if (coverFile) {
          const coverData = await coverFile.async('base64');
          const ext = coverFileNames[0].split('.').pop().toLowerCase();
          const mimeMap = { 'png':'image/png', 'gif':'image/gif', 'svg':'image/svg+xml', 'webp':'image/webp', 'jpg':'image/jpeg', 'jpeg':'image/jpeg' };
          const mime = mimeMap[ext] || 'image/jpeg';
          coverBase64 = `data:${mime};base64,${coverData}`;
        }
      } catch {}
    }
  }

  // 解析每章 HTML
  const chapters = [];
  for (const idref of spineItems) {
    if (!manifest[idref]) continue;
    const { href, mediaType } = manifest[idref];
    if (!mediaType?.includes('html') && !mediaType?.includes('xhtml')) continue;
    const file = zip.file(href);
    if (!file) continue;
    let html = await file.async('text');

    // 提取body内容，替换图片路径
    const chDoc = parser.parseFromString(html, 'text/html');
    const body = chDoc.body;

    // 提取 <head> 中的 <style>，保留竖排等 CSS 规则
    const headStyles = [];
    chDoc.head.querySelectorAll('style').forEach(s => headStyles.push(s.outerHTML));

    // 检测竖排模式（writing-mode: vertical-rl）
    const bodyStyle = body.getAttribute('style') || '';
    // 同时检查 body 上的 class 定义的样式（如 .vertical）
    const bodyClass = body.getAttribute('class') || '';
    // 先粗略判断，后续用 extracted style 精准匹配
    const allStyleText = headStyles.join('') + bodyStyle;
    const hasVerticalMode = /writing-mode\s*:\s*vertical-rl/i.test(allStyleText) ||
      /epub-writing-mode\s*:\s*vertical-rl/i.test(allStyleText) ||
      bodyClass.includes('vertical');

    // 内嵌章节内图片（转 base64 保留插图体验）
    const imgs = body.querySelectorAll('img');
    for (const img of imgs) {
      const src = img.getAttribute('src');
      if (!src) continue;
      try {
        const resolvedPath = resolveHref(href, src);
        let imgFile = zip.file(resolvedPath);
        // 尝试 URL 解码后的路径
        if (!imgFile) {
          try { imgFile = zip.file(decodeURIComponent(resolvedPath)); } catch {}
        }
        // 尝试只匹配文件名（某些 EPUB 路径不规范）
        if (!imgFile) {
          const fileNameOnly = resolvedPath.split('/').pop();
          const allNames = Object.keys(zip.files);
          const found = allNames.find(n => n.endsWith(fileNameOnly));
          if (found) imgFile = zip.file(found);
        }
        if (imgFile) {
          const imgData = await imgFile.async('base64');
          const ext = src.split('.').pop().toLowerCase();
          const mimeMap = { 'png':'image/png', 'gif':'image/gif', 'svg':'image/svg+xml', 'webp':'image/webp', 'jpg':'image/jpeg', 'jpeg':'image/jpeg' };
          const mime = mimeMap[ext] || 'image/jpeg';
          img.setAttribute('src', `data:${mime};base64,${imgData}`);
        }
      } catch {}
      // 清除原有的 width/height 属性，防止固定尺寸溢出页面
      img.removeAttribute('width');
      img.removeAttribute('height');
      // 强制图片自适应：竖排模式用 height 约束，横排用 width 约束
      if (hasVerticalMode) {
        // 竖排：图高不超过页面高度（对应页宽），用 inline 融入竖排流
        img.style.cssText = (img.style.cssText || '') +
          ';max-height:100% !important;width:auto !important;display:inline;vertical-align:text-top;margin:2px 4px;';
      } else {
        img.style.cssText = (img.style.cssText || '') +
          ';max-width:100% !important;height:auto !important;display:block;margin:10px auto;border-radius:8px;width:auto !important;';
      }
    }

    // 处理内联 SVG 元素（直接写在 HTML 里的 <svg>，非 img 引用）
    const svgs = body.querySelectorAll('svg');
    for (const svg of svgs) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      if (hasVerticalMode) {
        svg.style.cssText = (svg.style.cssText || '') +
          ';max-height:100% !important;width:auto !important;display:inline;vertical-align:text-top;';
      } else {
        svg.style.cssText = (svg.style.cssText || '') +
          ';max-width:100% !important;height:auto !important;';
      }
    }

    // 移除 canvas 标签（非插图内容）
    body.querySelectorAll('canvas').forEach(el => el.remove());

    // 章节标题：优先 h1~h3，否则用文件名
    const headingEl = body.querySelector('h1,h2,h3');
    let chTitle = headingEl?.textContent?.trim();
    if (!chTitle) {
      const firstP = body.querySelector('p');
      const candidate = firstP?.textContent?.trim();
      if (candidate && candidate.length < 50) chTitle = candidate;
    }
    if (!chTitle) chTitle = `第${chapters.length + 1}章`;

    // 用纯文本长度判断，避免只有HTML标签的空章节混进来
    // 但纯图片章节（有 img 且文字少）要保留，不能跳过
    const textLen = (body.textContent || '').replace(/\s/g, '').length;
    const hasImg = body.querySelectorAll('img').length > 0;
    if (textLen < 30 && !hasImg) continue;

    // 构建最终 HTML：样式 + body 内联 style 包裹 + 内容
    const stylePrefix = headStyles.length > 0 ? headStyles.join('\n') : '';
    let innerHTML = body.innerHTML.trim();
    // 如果有 body 内联 style（如 writing-mode），用 div 包裹保留它
    if (bodyStyle) {
      innerHTML = `<div style="${bodyStyle}">${innerHTML}</div>`;
    }
    if (stylePrefix) innerHTML = stylePrefix + '\n' + innerHTML;

    chapters.push({
      title: chTitle,
      html: innerHTML,
      writingMode: hasVerticalMode ? 'vertical-rl' : null
    });
  }

  return { title, author, coverBase64, chapters, type: 'epub' };
}

function resolveHref(base, href) {
  if (href.startsWith('/')) return href.slice(1);
  const parts = base.split('/');
  parts.pop(); // 移除文件名
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// ===== TXT 解析（优化版） =====
function parseTxt(text, fileName) {
  const title = fileName.replace(/\.txt$/i, '');
  // 主模式：第X章 / Chapter N / 序/楔子/尾声等
  const MAIN_CHAPTER_RE = /^[\s\u3000]*(第\s*[零一二三四五六七八九十百千万\d]+\s*[章节卷回集篇部]|Chapter\s+\d+|CHAPTER\s+\d+|[序楔引终尾声后记番外]+)\s*[^\n]{0,30}$/;
  // 备用模式：仅当主模式匹配不足时启用，且行内不含句号/叹号/问号（排除普通内容行）
  const ALT_CHAPTER_RE = /^[\s\u3000]*\d{1,4}\s*[、.．]\s*[^\n。！？…]{2,22}$/;

  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const chapters = [];
  let curTitle = null;
  let curLines = [];

  function flushChapter() {
    if (!curLines.length) return;
    // 使用 for 循环拼字符串，避免多次数组遍历
    let html = '';
    for (let i = 0; i < curLines.length; i++) {
      const s = curLines[i].trim();
      if (s) html += '<p>' + escHtml(s) + '</p>';
    }
    if (html) chapters.push({ title: curTitle || `段落${chapters.length + 1}`, html });
  }

  // 预扫描主模式匹配数
  let mainMatches = 0;
  for (let i = 0; i < lines.length; i++) {
    if (MAIN_CHAPTER_RE.test(lines[i])) mainMatches++;
  }

  for (let i = 0; i < lines.length; i++) {
    let isChapter = MAIN_CHAPTER_RE.test(lines[i]);
    // 仅当主模式匹配不足2个时用备用模式补位
    if (!isChapter && mainMatches < 2 && ALT_CHAPTER_RE.test(lines[i])) {
      isChapter = true;
    }
    if (isChapter) {
      flushChapter();
      curTitle = lines[i].trim();
      curLines = [];
    } else {
      curLines.push(lines[i]);
    }
  }
  flushChapter();

  // 未识别出章节 → 按每 500 行自动分段
  if (chapters.length <= 1) {
    chapters.length = 0;
    const chunkSize = 500;
    for (let i = 0; i < lines.length; i += chunkSize) {
      let html = '';
      const end = Math.min(i + chunkSize, lines.length);
      for (let j = i; j < end; j++) {
        const s = lines[j].trim();
        if (s) html += '<p>' + escHtml(s) + '</p>';
      }
      if (html) chapters.push({ title: `第${Math.floor(i / chunkSize) + 1}节`, html });
    }
  }

  return { title, author: '未知作者', coverBase64: null, chapters, type: 'txt' };
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(msg, duration = 2000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function showHelp() {
  $id('help-overlay').style.display = 'block';
  $id('help-panel').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}
function hideHelp() {
  $id('help-overlay').style.display = 'none';
  $id('help-panel').style.display = 'none';
  document.body.style.overflow = '';
}

// ===== 工具函数 =====
function $id(id) { return document.getElementById(id); }
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  $id('page-' + name).classList.add('active');
  updateCornerDuck();
}
function hideLoading() {
  const mask = $id('loading-mask');
  if (!mask || mask.style.display === 'none') return;
  mask.classList.add('hiding');
  mask.addEventListener('transitionend', function onEnd() {
    mask.removeEventListener('transitionend', onEnd);
    mask.style.display = 'none';
    mask.classList.remove('hiding');
  }, { once: true });
  // 兜底：600ms 后强制隐藏
  setTimeout(() => {
    if (mask.style.display !== 'none') {
      mask.style.display = 'none';
      mask.classList.remove('hiding');
    }
  }, 600);
}
function showLoading(text = '咕嘎咕嘎~ 处理中…') {
  const mask = $id('loading-mask');
  mask.classList.remove('hiding');
  mask.style.display = 'flex';
  document.querySelector('#loading-mask .loading-duck-text').textContent = text;
}
function uid() {
  return Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// ===== 书架渲染 =====
state._activeFolder = 'all';
state._batchMode = false;
state._selectedBooks = new Set();

function toggleBatchMode() {
  state._batchMode = !state._batchMode;
  state._selectedBooks.clear();
  $id('batch-toolbar').style.display = state._batchMode ? 'flex' : 'none';
  $id('btn-batch-manage').classList.toggle('active', state._batchMode);
  renderShelf();
}

function toggleBookSelect(bookId) {
  if (!state._batchMode) return;
  if (state._selectedBooks.has(bookId)) {
    state._selectedBooks.delete(bookId);
  } else {
    state._selectedBooks.add(bookId);
  }
  renderShelf();
}

async function batchMoveToFolder(folderId) {
  for (const bookId of state._selectedBooks) {
    const book = state.books.find(b => b.id === bookId);
    if (book) { book.folder = folderId || null; await dbPut(book); }
  }
  state._selectedBooks.clear();
  renderShelf();
}

async function batchDelete() {
  if (!state._selectedBooks.size) return;
  if (!confirm(`确认删除选中的 ${state._selectedBooks.size} 本书？此操作不可撤销！`)) return;

  // 如果正在阅读的书在删除列表中，先返回书架
  if (state.currentBook && state._selectedBooks.has(state.currentBook.id)) {
    state.currentBook = null;
    state._pageGroups = [];
    showPage('shelf');
  }

  for (const bookId of state._selectedBooks) {
    state.books = state.books.filter(b => b.id !== bookId);
    await dbDelete(bookId);
  }
  state._selectedBooks.clear();
  renderShelf();
}

function selectAllBooks() {
  const query = $id('search-input').value.toLowerCase();
  const activeFolder = state._activeFolder || 'all';
  let books = state.books;
  if (activeFolder !== 'all') books = books.filter(b => b.folder === activeFolder);
  if (query) books = books.filter(b => b.title.toLowerCase().includes(query) || b.author?.toLowerCase().includes(query));
  books.forEach(b => state._selectedBooks.add(b.id));
  renderShelf();
}

function renderShelf() {
  const query = $id('search-input').value.toLowerCase();
  const activeFolder = state._activeFolder || 'all';

  // 筛选
  let books = state.books;
  if (activeFolder !== 'all') books = books.filter(b => b.folder === activeFolder);
  if (query) books = books.filter(b => b.title.toLowerCase().includes(query) || b.author?.toLowerCase().includes(query));

  // 渲染文件夹标签
  renderFolderTabs();

  const grid = $id('book-grid');
  const empty = $id('shelf-empty');

  if (books.length === 0) {
    grid.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  grid.style.display = '';
  grid.className = 'book-grid' + (state.viewMode === 'list' ? ' list-view' : '');

  grid.innerHTML = books.map((book, idx) => {
    const progress = book.lastChapter ? Math.round((book.lastChapter / (book.chapterCount - 1)) * 100) : 0;
    const coverHtml = book.coverBase64
      ? `<img class="book-cover" src="${book.coverBase64}" alt="${escHtml(book.title)}" loading="lazy">`
      : `<div class="book-cover-placeholder">
           <span class="cover-title-text">${escHtml(book.title)}</span>
           <span class="cover-type-badge">${book.type.toUpperCase()}</span>
         </div>`;
    const folderName = book.folder && state.folders ? (state.folders.find(f => f.id === book.folder)?.name || '') : '';

    return `<div class="book-card ${state._batchMode && state._selectedBooks.has(book.id) ? 'selected' : ''}" data-id="${book.id}" style="animation-delay:${idx * 0.04}s">
      ${coverHtml}
      ${state._batchMode ? `<div class="book-checkbox ${state._selectedBooks.has(book.id) ? 'checked' : ''}"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7l3 3 5-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></div>` : ''}
      ${folderName ? `<span class="book-folder-tag" style="background:${getFolderColor(book.folder)}">${escHtml(folderName)}</span>` : ''}
      <div class="book-info">
        <div class="book-title" title="${escHtml(book.title)}">${escHtml(book.title)}</div>
        <div class="book-meta">${escHtml(book.author || '未知作者')} · ${book.chapterCount}章${book.bookmarks?.length ? ` · ${book.bookmarks.length}书签` : ''}</div>
        <div class="book-progress-bar"><div class="book-progress-fill" style="width:${progress}%"></div></div>
      </div>
      <div class="card-actions">
        <button class="card-del-btn" data-id="${book.id}" title="移除">✕</button>
      </div>
    </div>`;
  }).join('');
}

function getFolderColor(folderId) {
  const f = state.folders.find(x => x.id === folderId);
  return f?.color || '#7ec8f0';
}

function renderFolderTabs() {
  const container = $id('folder-tabs');
  // 始终显示标签栏，确保 + 新建按钮始终可见
  container.style.display = 'flex';

  let html = `<button class="folder-tab ${state._activeFolder === 'all' ? 'active' : ''}" data-folder="all">📚 全部</button>`;
  for (const f of state.folders) {
    const count = state.books.filter(b => b.folder === f.id).length;
    html += `<button class="folder-tab ${state._activeFolder === f.id ? 'active' : ''}" data-folder="${f.id}">
      <span class="folder-dot" style="background:${f.color}"></span>${escHtml(f.name)} <small>(${count})</small>
    </button>`;
  }
  html += `<button class="folder-tab folder-tab-add" id="btn-add-folder" title="新建文件夹">+ 新建文件夹</button>`;
  container.innerHTML = html;

  // 重新绑定文件夹点击
  container.querySelectorAll('.folder-tab[data-folder]').forEach(tab => {
    tab.addEventListener('click', () => {
      state._activeFolder = tab.dataset.folder;
      renderShelf();
    });
    tab.addEventListener('contextmenu', e => {
      if (tab.dataset.folder === 'all') return;
      e.preventDefault();
      if (confirm(`删除文件夹「${tab.textContent.replace(/[^\\u4e00-\\u9fa5\\w]/g,'').trim()}」？书籍将移入根目录`)) {
        deleteFolder(tab.dataset.folder);
      }
    });
  });

  const addBtn = container.querySelector('#btn-add-folder');
  if (addBtn) {
    addBtn.addEventListener('click', () => showFolderDialog(null));
  }
}

async function deleteFolder(id) {
  // 将文件夹中书移入根目录
  for (const b of state.books) {
    if (b.folder === id) { b.folder = null; await dbPut(b); }
  }
  state.folders = state.folders.filter(f => f.id !== id);
  await dbDeleteFolder(id);
  if (state._activeFolder === id) state._activeFolder = 'all';
  renderShelf();
}

function showFolderDialog(folderId) {
  const existing = document.querySelector('.folder-dialog-overlay');
  if (existing) existing.remove();

  const isEdit = !!folderId;
  const f = isEdit ? state.folders.find(x => x.id === folderId) : null;
  const colors = ['#7ec8f0','#f4a7c3','#e05a8a','#3a9fd6','#a78bfa','#34d399','#fbbf24'];

  const overlay = document.createElement('div');
  overlay.className = 'folder-dialog-overlay';
  overlay.innerHTML = `<div class="folder-dialog">
    <h3>${isEdit ? '编辑文件夹' : '新建文件夹'}</h3>
    <input class="folder-name-input" placeholder="文件夹名称" value="${f?.name || ''}" autofocus>
    <div class="folder-colors">${colors.map(c => `<span class="folder-color-dot ${c === (f?.color || colors[0]) ? 'active' : ''}" style="background:${c}" data-color="${c}"></span>`).join('')}</div>
    <div class="folder-dialog-btns">
      <button class="folder-btn-cancel">取消</button>
      <button class="folder-btn-confirm">${isEdit ? '保存' : '创建'}</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  let selectedColor = f?.color || colors[0];
  const nameInput = overlay.querySelector('.folder-name-input');
  const colorDots = overlay.querySelectorAll('.folder-color-dot');

  colorDots.forEach(d => d.addEventListener('click', () => {
    colorDots.forEach(x => x.classList.remove('active'));
    d.classList.add('active');
    selectedColor = d.dataset.color;
  }));

  overlay.querySelector('.folder-btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.folder-btn-confirm').addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (isEdit) {
      f.name = name; f.color = selectedColor;
      await dbPutFolder(f);
    } else {
      const folder = { id: uid(), name, color: selectedColor };
      state.folders.push(folder);
      await dbPutFolder(folder);
    }
    overlay.remove();
    renderShelf();
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  nameInput.focus();
}

// ===== 统一导入核心（Web + Electron 共用） =====
async function importBookFromData(rawData, fileName, isElectronBuffer = false) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (ext !== 'epub' && ext !== 'txt') return null;

  try {
    let parsed;
    if (ext === 'epub') {
      const buf = isElectronBuffer ? rawData : await rawData.arrayBuffer();
      parsed = await parseEpub(buf, fileName);
    } else {
      const text = isElectronBuffer
        ? new TextDecoder('utf-8').decode(new Uint8Array(rawData))
        : await readFileAsText(rawData);
      parsed = parseTxt(text, fileName);
    }
    return parsed;
  } catch (err) {
    console.error('解析失败', err);
    throw err;
  }
}

function buildBookRecord(parsed, folderId = null) {
  const book = {
    id: uid(),
    title: parsed.title,
    author: parsed.author,
    coverBase64: parsed.coverBase64,
    type: parsed.type,
    chapterCount: parsed.chapters.length,
    chapters: parsed.chapters,
    lastChapter: 0,
    folder: folderId,
    bookmarks: [],
    addedAt: Date.now()
  };
  // 导入时预切分大章节 HTML，空间换时间：下次打开瞬间渲染
  preprocessBookChapters(book);
  const existing = state.books.findIndex(b => b.title === book.title);
  if (existing >= 0) {
    book.id = state.books[existing].id;
    book.lastChapter = state.books[existing].lastChapter;
    state.books[existing] = book;
  } else {
    state.books.unshift(book);
  }
  return book;
}

// 导入时预切分大章节 HTML，后续打开瞬间渲染（空间换时间）
// 同时预展平 DOM 树结构，翻页模式可直接使用无需重复遍历
function preprocessBookChapters(book) {
  const CHUNK_THRESHOLD = 80 * 1024;   // >80KB 才切分
  const CHUNK_PARAS   = 80;            // 每块约80个段落

  for (const ch of book.chapters) {
    if (!ch.html) continue;
    
    try {
      const tmp = document.createElement('div');
      tmp.innerHTML = ch.html;
      
      // ===== 1. 切分 chunks（滚动模式流式注入用）=====
      if (ch.html.length > CHUNK_THRESHOLD) {
        const children = Array.from(tmp.childNodes);
        ch._chunks = [];
        for (let i = 0; i < children.length; i += CHUNK_PARAS) {
          let chunk = '';
          const end = Math.min(i + CHUNK_PARAS, children.length);
          for (let j = i; j < end; j++) {
            const node = children[j];
            if (node.nodeType === Node.ELEMENT_NODE) {
              chunk += node.outerHTML;
            } else if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent.trim();
              if (text) chunk += '<p>' + escHtml(text) + '</p>';
            }
          }
          ch._chunks.push(chunk);
        }
      }
      
      // ===== 2. 预展平 DOM —— 翻页模式 calcPages 可直接用 =====
      flatLeavesForChapter(ch, tmp);
      
    } catch {
      ch._chunks = null;
      ch._flatLeaves = null;
    }
  }
}

// 预展平章节 DOM：递归展开所有块级容器，生成叶子路径列表
// 每个叶子 { path: number[], tagName?: string, isText: boolean }
// path 是相对于章节内容根元素的 childNodes 索引链
function flatLeavesForChapter(ch, rootEl) {
  const leaves = [];
  
  // 判断一个元素是否应递归展开（块级容器且包含子元素）
  function shouldRecurse(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName;
    const leafTags = new Set(['IMG','BR','HR','INPUT','BUTTON','VIDEO','AUDIO','CANVAS','IFRAME','SVG']);
    if (leafTags.has(tag)) return false;
    if (!node.children.length) return false;
    // 只递归 DIV/SECTION/ARTICLE/BODY/BLOCKQUOTE 等明确块容器
    // P/LI/DD/DT/H1-H6 等也视为块容器，但内容通常简单不做递归
    const blockTags = new Set(['DIV','SECTION','ARTICLE','MAIN','BODY','BLOCKQUOTE','ASIDE','NAV','HEADER','FOOTER','CENTER']);
    if (blockTags.has(tag)) return true;
    // 对于 P 等，如果有子 DIV 则递归（嵌套块）
    if (tag === 'P' || tag === 'LI' || tag === 'DD' || tag === 'DT' || /^H[1-6]$/.test(tag)) {
      for (const child of node.children) {
        if (blockTags.has(child.tagName) || child.tagName === 'DIV') return true;
      }
    }
    return false;
  }
  
  function flatten(root, basePath) {
    const children = Array.from(root.childNodes);
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      const path = [...basePath, i];
      
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent.trim();
        if (text) leaves.push({ path, isText: true, html: escHtml(text) });
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (shouldRecurse(node)) {
          flatten(node, path);
        } else {
          leaves.push({ path, isText: false, html: node.outerHTML });
        }
      }
    }
  }
  
  flatten(rootEl, []);
  ch._flatLeaves = leaves;
}

// 批量写入 IndexedDB（单事务，大幅提升批量导入速度）
function dbPutBatch(books) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('books', 'readwrite');
    const store = tx.objectStore('books');
    for (const book of books) store.put(book);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function readFileAsText(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      const buf = new Uint8Array(e.target.result);
      // 先尝试 UTF-8，若含替换字符 \uFFFD 则回退 GBK
      let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
      if (text.indexOf('\uFFFD') !== -1) {
        text = new TextDecoder('gbk', { fatal: false }).decode(buf);
      }
      resolve(text);
    };
    reader.readAsArrayBuffer(file);
  });
}

// ===== 阅读器 =====
function openBook(bookId) {
  const book = state.books.find(b => b.id === bookId);
  if (!book) return;
  state.currentBook = book;
  state.currentChapter = book.lastChapter || 0;
  state.pageIndex = 0;
  state._pageGroups = [];
  showPage('reader');
  $id('reader-book-name').textContent = book.title;
  $id('sidebar-book-title').textContent = book.title;
  renderTOC();
  renderBookmarks();
  loadChapter(state.currentChapter);
  applySettings();
  updateReadingModeUI();
}

function renderTOC() {
  const toc = $id('toc-list');
  toc.innerHTML = state.currentBook.chapters.map((ch, i) =>
    `<div class="toc-item${i === state.currentChapter ? ' active' : ''}" data-idx="${i}">${escHtml(ch.title)}</div>`
  ).join('');
}

function loadChapter(idx) {
  const book = state.currentBook;
  if (!book || idx < 0 || idx >= book.chapters.length) return;
  state.currentChapter = idx;
  state.pageIndex = 0;
  state._pageGroups = [];
  state._calcLeaves = null;

  const ch = book.chapters[idx];
  const content = $id('reader-content');
  const heading = `<h1 class="chapter-heading">${escHtml(ch.title)}</h1>`;

  // 取消上一次可能还在跑的章节加载（防止竞态导致骨架屏残留）
  if (state._chapterLoadTimer) clearTimeout(state._chapterLoadTimer);
  if (state._chapterResolve) { state._chapterResolve(); state._chapterResolve = null; }

  // 翻页模式：先隐藏滚动内容，显示骨架屏，避免闪烁
  const isPaginate = state.readingMode === 'paginate';
  if (isPaginate) {
    content.style.display = 'none';
    showChapterLoading();
  }

  // 优先使用导入时预切分的 chunks（空间换时间，瞬间渲染）
  if (ch._chunks && ch._chunks.length > 0) {
    content.innerHTML = heading;
    content.insertAdjacentHTML('beforeend', ch._chunks[0]);
    streamChunks(content, ch._chunks, 1, () => afterChapterLoad());
    return;
  }

  // 旧数据或小章节：直接用完整 HTML
  if (ch.html && ch.html.length > 150 * 1024) {
    content.innerHTML = heading;
    appendChapterChunks(content, ch.html, () => afterChapterLoad());
  } else {
    content.innerHTML = heading + (ch.html || '');
    afterChapterLoad();
  }

  function afterChapterLoad() {
    $id('reader-body').scrollTop = 0;

    if (isPaginate) {
      content.style.display = '';  // 恢复显示供 calcPages 克隆
      // 安全防护：calcPages 如因异常未调用 renderSpread，3s 后强制清理骨架屏
      if (state._safetyTimer) clearTimeout(state._safetyTimer);
      state._safetyTimer = setTimeout(() => {
        const container = $id('page-container');
        if (container.querySelector('.chapter-loading-spinner')) {
          console.warn('[calcPages] 骨架屏安全超时，强制清理');
          container.innerHTML = '';
          content.style.display = '';
        }
      }, 3000);
      try {
        waitForImages(content, () => {
          try { calcPages(); }
          catch (e) {
            console.error('[calcPages] 异常:', e);
            clearTimeout(state._safetyTimer);
            content.style.display = '';
            $id('page-container').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">分页加载失败，请尝试切换章节或改变字体大小</div>';
          }
        });
      } catch (e) {
        console.error('[waitForImages] 异常:', e);
        clearTimeout(state._safetyTimer);
        content.style.display = '';
        $id('page-container').innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">图片加载失败，请重试</div>';
      }
    }

    $id('chapter-title-bar').textContent = ch.title;
    $id('chapter-progress').textContent = `${idx + 1} / ${book.chapters.length}`;
    $id('btn-prev-chapter').disabled = idx === 0;
    $id('btn-next-chapter').disabled = idx === book.chapters.length - 1;

    document.querySelectorAll('.toc-item').forEach(el => {
      el.classList.toggle('active', +el.dataset.idx === idx);
    });
    const activeItem = $id('toc-list').querySelector('.active');
    if (activeItem) activeItem.scrollIntoView({ block: 'nearest' });

    book.lastChapter = idx;
    dbPut(book);
    const bookInList = state.books.find(b => b.id === book.id);
    if (bookInList) bookInList.lastChapter = idx;

    const isBookmarked = book.bookmarks?.some(bm => bm.chapterIdx === idx);
    $id('btn-bookmark').classList.toggle('bookmarked', isBookmarked);
  }
}

// 翻页模式切换章节时显示加载骨架屏
function showChapterLoading() {
  const body = $id('reader-body');
  const container = $id('page-container');
  const indicator = $id('page-indicator');
  body.style.overflow = 'hidden';
  container.style.display = 'flex';
  indicator.style.display = 'block';
  indicator.textContent = '加载中…';

  const vw = body.clientWidth;
  const vh = body.clientHeight;
  const gutter = Math.max(36, Math.min(64, Math.round(vw * 0.045)));
  const padX = Math.max(14, Math.min(24, Math.round(vw * 0.022)));
  const pageW = Math.floor((vw - gutter) / 2) - padX * 2;

  container.innerHTML = `
    <div class="book-spread book-spread-loading">
      <div class="book-page book-page-left" style="width:${pageW + padX * 2}px;display:flex;align-items:center;justify-content:center;">
        <div class="chapter-loading">
          <div class="chapter-loading-spinner"></div>
          <span>翻页中…</span>
        </div>
      </div>
      <div class="book-spread-gutter"><div class="book-spine"></div></div>
      <div class="book-page book-page-right" style="width:${pageW + padX * 2}px;display:flex;align-items:center;justify-content:center;">
        <div class="chapter-loading">
          <div class="chapter-loading-spinner"></div>
          <span>翻页中…</span>
        </div>
      </div>
    </div>`;
  
  // 隐藏滚动模式的导航区域
  const navZones = body.querySelector('.nav-zones');
  if (navZones) navZones.style.display = 'none';
}

// 流式注入预切 chunks（纯字符串拼接，无 DOM 解析开销）
function streamChunks(container, chunks, startIdx, done) {
  let cursor = startIdx;
  const BATCH = 2; // 每帧注入 2 块（~160 段落）
  function next() {
    if (cursor >= chunks.length) { done(); return; }
    const batchEnd = Math.min(cursor + BATCH, chunks.length);
    let batch = '';
    for (let i = cursor; i < batchEnd; i++) batch += chunks[i];
    container.insertAdjacentHTML('beforeend', batch);
    cursor = batchEnd;
    requestAnimationFrame(next);
  }
  requestAnimationFrame(next);
}

// 旧数据兼容：大章节 HTML 分块注入（DocumentFragment 方式）
function appendChapterChunks(container, html, done) {
  const CHUNK = 120;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const children = Array.from(tmp.children);
  let cursor = 0;

  function next() {
    if (cursor >= children.length) { done(); return; }
    const end = Math.min(cursor + CHUNK, children.length);
    // 每次创建新的空 fragment，避免复用旧引用
    const batchFrag = document.createDocumentFragment();
    for (let i = cursor; i < end; i++) batchFrag.appendChild(children[i]);
    container.appendChild(batchFrag);
    cursor = end;
    requestAnimationFrame(next);
  }
  requestAnimationFrame(next);
}

// 等待容器内所有图片加载完成（非阻塞，仅用于需要精确分页的场景）
// 现在改为：不等待，直接回调。图片加载后由渲染层自然显示。
function waitForImages(container, cb) {
  // 不再阻塞：立即执行回调，图片异步加载不影响分页
  cb();
}

// ===== 书签 =====
function toggleBookmark() {
  const book = state.currentBook;
  if (!book) return;
  if (!book.bookmarks) book.bookmarks = [];
  const body = $id('reader-body');
  const scrollPos = state.readingMode === 'scroll' ? body.scrollTop : state.pageIndex;

  const existingIdx = book.bookmarks.findIndex(
    bm => bm.chapterIdx === state.currentChapter && Math.abs((bm.scrollPos || 0) - scrollPos) < 100
  );

  if (existingIdx >= 0) {
    book.bookmarks.splice(existingIdx, 1);
    showToast('🔖 书签已移除');
  } else {
    const ch = book.chapters[state.currentChapter];
    const snippet = (ch?.title || '') + (state.readingMode === 'paginate' ? ` · 第${state.pageIndex + 1}页` : '');
    book.bookmarks.push({ chapterIdx: state.currentChapter, scrollPos, text: snippet, time: Date.now() });
    book.bookmarks.sort((a, b) => a.chapterIdx - b.chapterIdx);
    showToast('🔖 已添加书签');
  }
  dbPut(book);
  renderBookmarks();
}

function gotoBookmark(bm) {
  loadChapter(bm.chapterIdx);
  if (state.readingMode === 'scroll') {
    setTimeout(() => { $id('reader-body').scrollTop = bm.scrollPos || 0; }, 100);
  } else {
    state.pageIndex = bm.scrollPos || 0;
    setTimeout(() => renderSpread(), 100);
  }
  if ($id('sidebar').classList.contains('open')) {
    $id('sidebar').classList.remove('open');
    $id('sidebar-overlay').classList.remove('visible');
  }
}

function renderBookmarks() {
  const container = $id('bookmark-list');
  if (!container) return;
  const book = state.currentBook;
  const bms = book?.bookmarks || [];
  // 更新工具栏按钮状态
  const isBookmarked = bms.some(bm => bm.chapterIdx === state.currentChapter);
  $id('btn-bookmark').classList.toggle('bookmarked', isBookmarked);

  if (bms.length === 0) {
    container.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-secondary);font-size:13px;">暂无书签</div>';
    return;
  }
  container.innerHTML = bms.map(bm => {
    const chTitle = book.chapters[bm.chapterIdx]?.title || `第${bm.chapterIdx + 1}章`;
    const timeStr = new Date(bm.time).toLocaleDateString('zh-CN');
    return `<div class="bm-item" data-ch="${bm.chapterIdx}" data-pos="${bm.scrollPos || 0}">
      <span class="bm-icon">🔖</span>
      <span class="bm-text">${escHtml(chTitle)}</span>
      <span class="bm-time">${timeStr}</span>
      <button class="bm-del" data-ch="${bm.chapterIdx}" data-pos="${bm.scrollPos || 0}">✕</button>
    </div>`;
  }).join('');
}

// ===== 阅读模式切换 =====
function toggleReadingMode() {
  state.readingMode = state.readingMode === 'scroll' ? 'paginate' : 'scroll';
  updateReadingModeUI();
  if (state.readingMode === 'paginate') {
    state.pageIndex = 0;
    $id('reader-body').scrollTop = 0;
    setTimeout(() => calcPages(), 200);
  } else {
    $id('page-container').style.display = 'none';
    $id('page-indicator').style.display = 'none';
    $id('reader-body').style.overflow = '';
    const navZones = $id('reader-body').querySelector('.nav-zones');
    if (navZones) navZones.style.display = '';
  }
}

function updateReadingModeUI() {
  const isPaginate = state.readingMode === 'paginate';
  $id('icon-mode-scroll').style.display = isPaginate ? 'none' : '';
  $id('icon-mode-paginate').style.display = isPaginate ? '' : 'none';
  $id('reader-body').classList.toggle('paginate-mode', isPaginate);
  if (!isPaginate) {
    $id('page-container').style.display = 'none';
    $id('page-indicator').style.display = 'none';
    $id('reader-body').style.overflow = '';
    const navZones = $id('reader-body').querySelector('.nav-zones');
    if (navZones) navZones.style.display = '';
  }
}

// ===== 翻页模式（双开页书卷布局 + 自然元素边界断页）=====

let _calcPagesTimer = null;
function debounceCalcPages() {
  clearTimeout(_calcPagesTimer);
  _calcPagesTimer = setTimeout(calcPages, 300);
}


function renderSpread() {
  // 正常进入渲染流程，清除安全定时器
  if (state._safetyTimer) { clearTimeout(state._safetyTimer); state._safetyTimer = null; }
  if (window._globalSafetyTimer) { clearTimeout(window._globalSafetyTimer); window._globalSafetyTimer = null; }

  const content = $id('reader-content');
  const container = $id('page-container');
  const spreadIdx = state.pageIndex;
  const groups = state._pageGroups;
  const leaves = state._calcLeaves || [];

  const pageW = state._pageW;
  const pageH = state._pageH;
  const gutter = state._gutter;
  const padX = state._padX;
  const padY = state._padY;

  // 检测竖排模式
  const ch = state.currentBook?.chapters[state.currentChapter];
  const isVertical = ch?.writingMode === 'vertical-rl';
  const verticalStyle = isVertical
    ? 'writing-mode:vertical-rl;text-orientation:mixed;'
    : '';

  const totalPages = groups.length;
  const totalSpreads = Math.ceil(totalPages / 2);
  const leftIdx = spreadIdx * 2;
  const rightIdx = leftIdx + 1;

  function buildPageHTML(pageIdx) {
    if (pageIdx >= totalPages) {
      return '<div class="book-page-blank"><span class="book-page-end">本章完</span></div>';
    }
    const leafList = groups[pageIdx];
    let html = '';
    for (const leaf of leafList) {
      if (leaf.isText) {
        html += '<p>' + (leaf.html || '') + '</p>';
      } else {
        // 直接使用预存的 html 片段，无需 path 导航
        html += (leaf.html || '');
      }
    }
    return html;
  }

  // 当前章节是否是第一章（用于判断封面页）
  const isFirstSpread = spreadIdx === 0;
  const isLastSpread  = spreadIdx >= totalSpreads - 1;

  container.innerHTML = `
    <div class="book-spread">
      <div class="book-page book-page-left" style="width:${pageW + padX * 2}px;padding:${padY}px ${padX}px;">
        <div class="book-page-inner ${isVertical ? 'book-page-vertical' : ''}" style="width:${pageW}px;min-height:${pageH}px;${verticalStyle}">
          ${buildPageHTML(leftIdx)}
        </div>
        <span class="book-page-num">${leftIdx + 1}</span>
      </div>
      <div class="book-spread-gutter">
        <div class="book-spine"></div>
      </div>
      <div class="book-page book-page-right" style="width:${pageW + padX * 2}px;padding:${padY}px ${padX}px;">
        <div class="book-page-inner ${isVertical ? 'book-page-vertical' : ''}" style="width:${pageW}px;min-height:${pageH}px;${verticalStyle}">
          ${buildPageHTML(rightIdx)}
        </div>
        ${rightIdx < totalPages ? `<span class="book-page-num">${rightIdx + 1}</span>` : ''}
      </div>
    </div>
  `;

  // 页码指示器
  $id('page-indicator').textContent = `${leftIdx + 1}–${Math.min(rightIdx + 1, totalPages)} / ${totalPages}`;

  // 按钮状态
  $id('btn-prev-chapter').disabled = isFirstSpread && state.currentChapter === 0;
  $id('btn-next-chapter').disabled = isLastSpread && state.currentChapter >= (state.currentBook?.chapters.length || 1) - 1;

  // 书签按钮状态
  const book = state.currentBook;
  const isBookmarked = book?.bookmarks?.some(
    bm => bm.chapterIdx === state.currentChapter && Math.abs((bm.scrollPos || 0) - spreadIdx) < 1
  );
  $id('btn-bookmark').classList.toggle('bookmarked', isBookmarked);

  // 动态约束图片尺寸，确保图片不会超出页面
  setTimeout(() => {
    const inners = container.querySelectorAll('.book-page-inner');
    for (const inner of inners) {
      const imgs = inner.querySelectorAll('img');
      for (const img of imgs) {
        // 先用 CSS 约束，再用 onload 修正
        img.style.maxWidth = pageW + 'px';
        img.style.maxHeight = pageH + 'px';
        img.style.width = 'auto';
        img.style.height = 'auto';
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        img.style.margin = '10px auto';

        // 如果图片已加载，直接修正；否则等加载后修正
        if (img.complete) {
          fixImgSize(img, pageW, pageH);
        } else {
          img.onload = () => fixImgSize(img, pageW, pageH);
        }
      }
    }
  }, 50);
}

// 修正单张图片的尺寸，使其等比例缩放到页面内
function fixImgSize(img, maxW, maxH) {
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!nw || !nh) return;
  const sx = maxW / nw;
  const sy = maxH / nh;
  const s = Math.min(sx, sy, 1); // 只缩小不放大
  img.style.width = Math.round(nw * s) + 'px';
  img.style.height = Math.round(nh * s) + 'px';
  img.style.maxWidth = maxW + 'px';
  img.style.maxHeight = maxH + 'px';
}

function pageNext() {
  if (state.readingMode !== 'paginate') return;
  const groups = state._pageGroups || [];
  const totalSpreads = Math.ceil(groups.length / 2);

  if (state.pageIndex < totalSpreads - 1) {
    state.pageIndex++;
    renderSpread();
  } else {
    // 翻到下一章
    if (state.currentChapter < (state.currentBook?.chapters.length || 1) - 1) {
      loadChapter(state.currentChapter + 1);
    }
  }
}

function pagePrev() {
  if (state.readingMode !== 'paginate') return;
  if (state.pageIndex > 0) {
    state.pageIndex--;
    renderSpread();
  } else {
    // 翻到上一章最后一页
    if (state.currentChapter > 0) {
      loadChapter(state.currentChapter - 1);
      setTimeout(() => {
        // 等待 calcPages（150ms延迟）完成测量后再渲染末页
        const groups = state._pageGroups || [];
        state.pageIndex = Math.max(0, Math.ceil(groups.length / 2) - 1);
        if (groups.length > 0) renderSpread();
      }, 250);
    }
  }
}

// ===== 阅读进度条 =====
function updateProgressBar() {
  const body = $id('reader-body');
  const max = body.scrollHeight - body.clientHeight;
  const pct = max > 0 ? (body.scrollTop / max) * 100 : 0;
  $id('progress-bar').style.width = pct + '%';
}

// ===== 工具栏自动隐藏 =====
let toolbarTimer = null;
let toolbarShowTimer = null; // mousemove 防抖
let lastScrollY = 0;
let toolbarVisible = true;

function showToolbar() {
  clearTimeout(toolbarTimer);
  clearTimeout(toolbarShowTimer);
  $id('reader-toolbar').classList.remove('hidden');
  $id('reader-footer').classList.remove('hidden');
  toolbarVisible = true;
  // 3秒后自动隐藏（全屏时）
  if (document.fullscreenElement) {
    toolbarTimer = setTimeout(hideToolbar, 3000);
  }
}

function hideToolbar() {
  clearTimeout(toolbarTimer);
  clearTimeout(toolbarShowTimer);
  $id('reader-toolbar').classList.add('hidden');
  $id('reader-footer').classList.add('hidden');
  toolbarVisible = false;
}

function toggleToolbar() {
  if (toolbarVisible) {
    hideToolbar();
  } else {
    showToolbar();
  }
}

// 只当鼠标贴近上下边缘时唤醒工具栏
function handleReaderMouseMove(e) {
  if (toolbarVisible) {
    // 已可见：全屏时重置倒计时
    if (document.fullscreenElement) {
      clearTimeout(toolbarTimer);
      toolbarTimer = setTimeout(hideToolbar, 3000);
    }
    return;
  }

  const reader = $id('page-reader');
  const rect = reader.getBoundingClientRect();
  const edgeDist = 60; // 边缘触发距离（px）

  const nearTop = (e.clientY - rect.top) < edgeDist;
  const nearBottom = (rect.bottom - e.clientY) < edgeDist;

  if (nearTop || nearBottom) {
    // 在边缘区域停留 180ms 后才唤醒
    if (!toolbarShowTimer) {
      toolbarShowTimer = setTimeout(showToolbar, 180);
    }
  } else {
    // 离开边缘区域，取消等待
    clearTimeout(toolbarShowTimer);
    toolbarShowTimer = null;
  }
}

// ===== 全屏 =====
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}

function onFullscreenChange() {
  const isFs = !!document.fullscreenElement;
  $id('icon-fullscreen').style.display = isFs ? 'none' : '';
  $id('icon-exit-fullscreen').style.display = isFs ? '' : 'none';
  if (isFs) {
    toolbarTimer = setTimeout(hideToolbar, 3000);
  } else {
    showToolbar();
  }
}

// ===== 右键菜单 =====
let ctxTargetId = null;
function showCtxMenu(e, bookId) {
  e.preventDefault();
  ctxTargetId = bookId;
  const menu = $id('ctx-menu');
  menu.style.display = 'block';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 80) + 'px';
}
function hideCtxMenu() {
  $id('ctx-menu').style.display = 'none';
  ctxTargetId = null;
}

// ===== 初始化 =====
async function init() {
  // 启动加载动画
  const t0 = Date.now();
  showLoading('咕嘎咕嘎~ 正在整理书架…');

  loadSettings();
  applySettings();

  await openDB();
  showLoading('咕嘎~ 正在唤醒书本们…');

  const savedBooks = await dbGetAll();
  savedBooks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  state.books = savedBooks;

  // 迁移旧数据（无 bookmarks 字段）
  for (const b of state.books) {
    if (!b.bookmarks) b.bookmarks = [];
    if (b.folder === undefined) b.folder = null;
  }

  state.folders = await dbGetFolders();

  const hasBooks = savedBooks.length > 0;
  if (hasBooks) {
    showLoading('咕嘎~ 书架上有 ' + savedBooks.length + ' 本书呢！');
  } else {
    showLoading('咕嘎~ 书架空空，快导入一本吧！');
  }

  renderShelf();
  bindEvents();

  // 保证加载动画最少展示 600ms，避免一闪而过
  const elapsed = Date.now() - t0;
  const waitMs = Math.max(0, 600 - elapsed);
  setTimeout(hideLoading, waitMs);
}

function bindEvents() {
  // ---- 书架 ----
  // 导入文件按钮
  $id('btn-import-file').addEventListener('click', async () => {
    if (isElectron) {
      const result = await window.electronAPI.openFileDialog();
      if (!result.canceled && result.filePaths.length > 0) {
        await importElectronFiles(result.filePaths);
      }
    } else {
      $id('file-input-single').click();
    }
  });

  // 导入文件夹按钮
  $id('btn-import-folder').addEventListener('click', async () => {
    if (isElectron) {
      const result = await window.electronAPI.openFolderDialog();
      if (!result.canceled && result.filePaths.length > 0) {
        await importElectronFolder(result.filePaths[0]);
      }
    } else {
      $id('file-input-folder').click();
    }
  });

  // Electron 菜单导入事件
  if (isElectron) {
    window.electronAPI.onImportFiles(async (filePaths) => {
      await importElectronFiles(filePaths);
    });
    window.electronAPI.onImportFolder(async (folderPath) => {
      await importElectronFolder(folderPath);
    });
  }

  $id('file-input-single').addEventListener('change', async e => {
    const files = [...e.target.files].filter(f => /\.(epub|txt)$/i.test(f.name));
    if (!files.length) return;
    await importBatch(files, false);
    e.target.value = '';
  });

  $id('file-input-folder').addEventListener('change', async e => {
    const files = [...e.target.files].filter(f => /\.(epub|txt)$/i.test(f.name));
    if (!files.length) { alert('所选文件夹中未找到 EPUB 或 TXT 文件'); return; }
    await importBatch(files, false);
    e.target.value = '';
  });

  $id('search-input').addEventListener('input', renderShelf);

  $id('btn-toggle-view').addEventListener('click', () => {
    state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
    $id('icon-grid').style.display = state.viewMode === 'list' ? '' : 'none';
    $id('icon-list').style.display = state.viewMode === 'grid' ? '' : 'none';
    renderShelf();
  });

  // 帮助面板
  $id('btn-help').addEventListener('click', showHelp);
  $id('btn-close-help').addEventListener('click', hideHelp);
  $id('help-overlay').addEventListener('click', hideHelp);

  // 点击书卡打开
  $id('book-grid').addEventListener('click', e => {
    const delBtn = e.target.closest('.card-del-btn');
    if (delBtn) {
      e.stopPropagation();
      const id = delBtn.dataset.id;
      if (confirm('确认从书架移除此书？')) removeBook(id);
      return;
    }
    const card = e.target.closest('.book-card');
    if (!card) return;
    if (state._batchMode) {
      toggleBookSelect(card.dataset.id);
      return;
    }
    openBook(card.dataset.id);
  });

  // 右键菜单
  $id('book-grid').addEventListener('contextmenu', e => {
    const card = e.target.closest('.book-card');
    if (card) showCtxMenu(e, card.dataset.id);
  });
  document.addEventListener('click', hideCtxMenu);
  $id('ctx-read').addEventListener('click', () => { if (ctxTargetId) openBook(ctxTargetId); });
  $id('ctx-delete').addEventListener('click', () => { if (ctxTargetId) { if (confirm('确认移除？')) removeBook(ctxTargetId); } });

  // ---- 阅读器工具栏 ----
  $id('btn-back').addEventListener('click', () => {
    showPage('shelf');
    renderShelf();
    if (document.fullscreenElement) document.exitFullscreen();
  });

  $id('btn-toc').addEventListener('click', () => {
    $id('sidebar').classList.toggle('open');
    $id('sidebar-overlay').classList.toggle('visible');
  });
  $id('btn-close-sidebar').addEventListener('click', closeSidebar);
  $id('sidebar-overlay').addEventListener('click', closeSidebar);

  // 侧边栏标签切换
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const panel = tab.dataset.panel;
      $id('toc-list').style.display = panel === 'toc' ? '' : 'none';
      $id('bookmark-list').style.display = panel === 'bookmarks' ? '' : 'none';
    });
  });

  function closeSidebar() {
    $id('sidebar').classList.remove('open');
    $id('sidebar-overlay').classList.remove('visible');
  }

  $id('toc-list').addEventListener('click', e => {
    const item = e.target.closest('.toc-item');
    if (!item) return;
    loadChapter(+item.dataset.idx);
    closeSidebar();
  });

  $id('btn-prev-chapter').addEventListener('click', () => loadChapter(state.currentChapter - 1));
  $id('btn-next-chapter').addEventListener('click', () => loadChapter(state.currentChapter + 1));

  // 翻页区域点击
  $id('nav-prev').addEventListener('click', () => {
    if (state.readingMode === 'paginate') { pagePrev(); return; }
    const body = $id('reader-body');
    if (body.scrollTop > 50) {
      body.scrollBy({ top: -(body.clientHeight * 0.85), behavior: 'smooth' });
    } else {
      loadChapter(state.currentChapter - 1);
    }
  });
  $id('nav-next').addEventListener('click', () => {
    if (state.readingMode === 'paginate') { pageNext(); return; }
    const body = $id('reader-body');
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 50;
    if (atBottom) {
      loadChapter(state.currentChapter + 1);
    } else {
      body.scrollBy({ top: body.clientHeight * 0.85, behavior: 'smooth' });
    }
  });

  // 键盘快捷键（滚动模式）
  document.addEventListener('keydown', e => {
    const inReader = $id('page-reader').classList.contains('active');
    if (!inReader) return;

    // 全局快捷键
    if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      state.settings.fontSize = Math.min(32, state.settings.fontSize + 1);
      applySettings(); saveSettings();
      showToast(`字体: ${state.settings.fontSize}px`);
      // 翻页模式：debounce 分页重算，避免快速连按时反复重算
      if (state.readingMode === 'paginate') debounceCalcPages();
      return;
    }
    if (e.ctrlKey && e.key === '-') {
      e.preventDefault();
      state.settings.fontSize = Math.max(12, state.settings.fontSize - 1);
      applySettings(); saveSettings();
      showToast(`字体: ${state.settings.fontSize}px`);
      if (state.readingMode === 'paginate') debounceCalcPages();
      return;
    }
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      state.settings.theme = state.settings.theme === 'dark' ? 'paper' : 'dark';
      applySettings(); saveSettings();
      showToast(state.settings.theme === 'dark' ? '🌙 夜间模式' : '☀️ 日间模式');
      return;
    }
    if (e.ctrlKey && e.key === 'h') {
      e.preventDefault();
      toggleToolbar();
      return;
    }

    if (state.readingMode === 'paginate') return;
    const body = $id('reader-body');
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault();
      const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 50;
      if (atBottom) loadChapter(state.currentChapter + 1);
      else body.scrollBy({ top: body.clientHeight * 0.85, behavior: 'smooth' });
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault();
      if (body.scrollTop < 50) loadChapter(state.currentChapter - 1);
      else body.scrollBy({ top: -(body.clientHeight * 0.85), behavior: 'smooth' });
    } else if (e.key === 'F' || e.key === 'f') {
      toggleFullscreen();
    } else if (e.key === 'Escape' && document.fullscreenElement) {
      document.exitFullscreen();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      body.scrollBy({ top: -80, behavior: 'smooth' });
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      body.scrollBy({ top: 80, behavior: 'smooth' });
    }
  });

  // Esc 关闭帮助面板（全局）
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $id('help-panel').style.display === 'flex') {
      hideHelp();
    }
  });

  // 鼠标移动 — 仅在贴近上下边缘时唤醒工具栏
  $id('page-reader').addEventListener('mousemove', handleReaderMouseMove);

  // 点击阅读区 — 翻页模式点击由 page-container 处理；此处仅防冒泡干扰
  $id('page-reader').addEventListener('click', e => {
    // page-container 已有独立的左右半屏翻页逻辑，不再在此重复处理
    if (state.readingMode === 'paginate' && $id('page-container').contains(e.target)) return;
    // 排除工具栏/侧边栏/设置面板内的点击（不唤醒工具栏）
  });

  // 滚动监听 — 仅更新进度条，不唤醒工具栏
  $id('reader-body').addEventListener('scroll', () => {
    updateProgressBar();
  }, { passive: true });

  // 全屏
  $id('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  // ---- 书签 ----
  $id('btn-bookmark').addEventListener('click', toggleBookmark);
  $id('bookmark-list').addEventListener('click', e => {
    const delBtn = e.target.closest('.bm-del');
    const item = e.target.closest('.bm-item');
    if (delBtn) {
      e.stopPropagation();
      const ch = +delBtn.dataset.ch;
      const pos = +delBtn.dataset.pos;
      const book = state.currentBook;
      if (book?.bookmarks) {
        book.bookmarks = book.bookmarks.filter(bm => !(bm.chapterIdx === ch && Math.abs((bm.scrollPos || 0) - pos) < 100));
        dbPut(book);
        renderBookmarks();
      }
      return;
    }
    if (item) {
      const ch = +item.dataset.ch;
      const pos = +item.dataset.pos;
      const bm = state.currentBook?.bookmarks?.find(b => b.chapterIdx === ch && Math.abs((b.scrollPos || 0) - pos) < 100);
      if (bm) gotoBookmark(bm);
    }
  });

  // ---- 阅读模式切换 ----
  $id('btn-mode-toggle').addEventListener('click', toggleReadingMode);

  // ---- 翻页模式点击（左页→后退，右页→前进）----
  $id('page-container').addEventListener('click', e => {
    if (state.readingMode !== 'paginate') return;
    const container = $id('page-container');
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const midX = rect.width / 2;
    // 左半屏（左页）→ 上一页；右半屏（右页）→ 下一页
    if (x < midX) pagePrev();
    else pageNext();
  });

  // 翻页模式键盘
  document.addEventListener('keydown', e => {
    if (state.readingMode !== 'paginate') return;
    const inReader = $id('page-reader').classList.contains('active');
    if (!inReader) return;
    // Ctrl 修饰键透传给全局快捷键
    if (e.ctrlKey) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
      e.preventDefault(); pageNext();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      e.preventDefault(); pagePrev();
    }
  });

  // 翻页模式滚轮翻页（带防抖，兼容触控板惯性滚动）
  let wheelCooldown = false;
  let wheelAccum = 0;
  const WHEEL_THRESHOLD = 60;   // 累计滚动量阈值（px）
  const WHEEL_COOLDOWN = 500;   // 翻页冷却时间（ms）

  $id('page-reader').addEventListener('wheel', e => {
    if (state.readingMode !== 'paginate') return;

    // 防止页面自身滚动（例如设置面板滚动条）
    if (e.target.closest('#settings-panel') || e.target.closest('#sidebar')) return;

    e.preventDefault();

    if (wheelCooldown) {
      // 冷却中仍累计方向，冷却结束后立即触发
      wheelAccum += e.deltaY;
      return;
    }

    wheelAccum += e.deltaY;

    if (wheelAccum > WHEEL_THRESHOLD) {
      wheelAccum = 0;
      wheelCooldown = true;
      pageNext();
      setTimeout(() => { wheelCooldown = false; }, WHEEL_COOLDOWN);
    } else if (wheelAccum < -WHEEL_THRESHOLD) {
      wheelAccum = 0;
      wheelCooldown = true;
      pagePrev();
      setTimeout(() => { wheelCooldown = false; }, WHEEL_COOLDOWN);
    }
  }, { passive: false });

  // ---- 设置面板 ----
  $id('btn-settings').addEventListener('click', e => {
    e.stopPropagation();
    $id('settings-panel').classList.toggle('open');
    $id('settings-overlay').classList.toggle('visible');
  });
  $id('settings-overlay').addEventListener('click', () => {
    $id('settings-panel').classList.remove('open');
    $id('settings-overlay').classList.remove('visible');
  });

  $id('fs-decrease').addEventListener('click', () => {
    state.settings.fontSize = Math.max(12, state.settings.fontSize - 1);
    applySettings(); saveSettings();
    if (state.readingMode === 'paginate') debounceCalcPages();
  });
  $id('fs-increase').addEventListener('click', () => {
    state.settings.fontSize = Math.min(32, state.settings.fontSize + 1);
    applySettings(); saveSettings();
    if (state.readingMode === 'paginate') debounceCalcPages();
  });
  $id('line-height-slider').addEventListener('input', e => {
    state.settings.lineHeight = +e.target.value;
    applySettings(); saveSettings();
    if (state.readingMode === 'paginate') debounceCalcPages();
  });
  $id('width-slider').addEventListener('input', e => {
    state.settings.contentWidth = +e.target.value;
    applySettings(); saveSettings();
    if (state.readingMode === 'paginate') debounceCalcPages();
  });
  $id('font-select').addEventListener('change', e => {
    state.settings.font = e.target.value;
    applySettings(); saveSettings();
    if (state.readingMode === 'paginate') debounceCalcPages();
  });
  document.querySelectorAll('.swatch').forEach(s => {
    s.addEventListener('click', () => {
      state.settings.theme = s.dataset.theme;
      applySettings(); saveSettings();
    });
  });

  // 拖拽导入
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter(f => /\.(epub|txt)$/i.test(f.name));
    if (!files.length) return;
    await importBatch(files, false);
  });

  // ---- 批量管理 ----
  $id('btn-batch-manage').addEventListener('click', toggleBatchMode);
  $id('batch-select-all').addEventListener('click', selectAllBooks);
  $id('batch-delete').addEventListener('click', batchDelete);
  $id('batch-cancel').addEventListener('click', toggleBatchMode);
  $id('batch-folder-select').addEventListener('change', e => {
    const val = e.target.value;
    if (val) { batchMoveToFolder(val); e.target.value = ''; }
  });

  // 更新批量文件夹下拉
  const origRenderShelf = renderShelf;
  renderShelf = function() {
    origRenderShelf();
    // 更新批量工具栏
    $id('batch-count').textContent = `已选 ${state._selectedBooks.size} 项`;
    const sel = $id('batch-folder-select');
    if (sel) {
      sel.innerHTML = '<option value="">移至文件夹…</option>' + state.folders.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('');
    }
  };
}

async function removeBook(id) {
  // 如果正在阅读被删除的书，先返回书架
  if (state.currentBook && state.currentBook.id === id) {
    state.currentBook = null;
    state._pageGroups = [];
    showPage('shelf');
  }
  state.books = state.books.filter(b => b.id !== id);
  await dbDelete(id);
  renderShelf();
}

// ===== 批量导入核心（Web & Electron 统一） =====
async function importBatch(items, isElectronPaths, folderId = null, seriesName = null) {
  const total = items.length;
  showLoading(`正在导入 ${total} 个文件…`);
  const parsedBooks = [];
  let count = 0;

  for (const item of items) {
    const name = isElectronPaths ? item.split(/[\\/]/).pop() : item.name;
    document.querySelector('#loading-mask .loading-duck-text').textContent =
      `咕嘎咕嘎~ 正在解析「${name}」(${++count}/${total})…`;

    await new Promise(r => setTimeout(r, 0));

    try {
      let parsed;
      if (isElectronPaths) {
        const result = await window.electronAPI.readFile(item);
        if (!result.success) throw new Error(result.error);
        parsed = await importBookFromData(result.buffer, name, true);
      } else {
        parsed = await importBookFromData(item, name, false);
      }
      // 如果有系列名，则覆盖书名
      if (parsed && seriesName) {
        const volMatch = name.match(/[第卷]?\s*(\d+)\s*[卷章部]?/);
        const numMatch = name.match(/(\d+)/);
        const vol = volMatch?.[1] || numMatch?.[1];
        parsed.title = vol ? `${seriesName} 第${vol}卷` : seriesName + ' · ' + parsed.title;
      }
      if (parsed) parsedBooks.push(parsed);
    } catch (err) {
      console.error('导入失败', name, err);
    }
  }

  const books = parsedBooks.map(p => buildBookRecord(p, folderId));
  if (books.length > 0) await dbPutBatch(books);

  hideLoading();
  renderShelf();
}

// ===== Electron 原生文件导入 =====
async function importElectronFiles(filePaths) {
  const validPaths = filePaths.filter(p => /\.(epub|txt)$/i.test(p));
  if (!validPaths.length) return;
  await importBatch(validPaths, true);
}

async function importElectronFolder(folderPath) {
  showLoading('咕嘎咕嘎~ 正在扫描文件夹…');
  const result = await window.electronAPI.scanFolder(folderPath);
  if (!result.success) { hideLoading(); alert('扫描文件夹失败：' + result.error); return; }
  if (!result.files.length) { hideLoading(); alert('文件夹中未找到 EPUB 或 TXT 文件'); return; }
  hideLoading();
  // 弹出导入选项对话框
  showImportFolderDialog(result.files.map(f => f.path));
}

// 导入文件夹对话框：选择文件夹 + 系列命名
function showImportFolderDialog(filePaths) {
  const existing = document.querySelector('.folder-dialog-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'folder-dialog-overlay';
  overlay.innerHTML = `<div class="folder-dialog import-folder-dialog">
    <h3>📂 导入文件夹 (${filePaths.length} 个文件)</h3>
    <div class="import-dialog-row">
      <label>系列名称（可选统一命名）</label>
      <input class="folder-name-input" id="import-series-name" placeholder="留空则保留原书名">
    </div>
    <div class="import-dialog-row">
      <label>放入书架文件夹</label>
      <select id="import-folder-select" class="folder-select">
        <option value="">（根目录）</option>
        ${state.folders.map(f => `<option value="${f.id}">${escHtml(f.name)}</option>`).join('')}
      </select>
      <button class="btn-new-folder-inline" id="import-new-folder-btn">+ 新建</button>
    </div>
    <div class="folder-dialog-btns">
      <button class="folder-btn-cancel">取消</button>
      <button class="folder-btn-confirm">开始导入</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('.folder-btn-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.folder-btn-confirm').addEventListener('click', async () => {
    const seriesName = overlay.querySelector('#import-series-name').value.trim() || null;
    const folderId = overlay.querySelector('#import-folder-select').value || null;
    overlay.remove();
    await importBatch(filePaths, true, folderId, seriesName);
  });
  overlay.querySelector('#import-new-folder-btn').addEventListener('click', () => {
    overlay.remove();
    showFolderDialog(null);
    // 简化：新建后需重新触发导入
    setTimeout(() => showImportFolderDialog(filePaths), 500);
  });
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

// ===== Canvas 樱花飘落（GPU加速，零DOM元素） =====
let sakuraAnimId = null;
const sakuraPetals = [];

function initSakuraCanvas() {
  const canvas = document.getElementById('sakura-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0;

  function resize() {
    const dw = window.innerWidth || document.documentElement.clientWidth || 1024;
    const dh = window.innerHeight || document.documentElement.clientHeight || 768;
    if (dw === w && dh === h) return;
    w = canvas.width = dw;
    h = canvas.height = dh;

    // 翻页模式：窗口大小改变时重新分页（debounce 150ms）
    if (state.readingMode === 'paginate') {
      clearTimeout(resize._t);
      resize._t = setTimeout(() => {
        try {
          const body = document.getElementById('reader-body');
          if (body) calcPagesAsync(function() {});
        } catch(e) { console.error('[resize] calcPagesAsync error:', e); }
      }, 150);
    }
  }

  // 用 scale+arc 代替 ellipse，Edge 兼容
  function createPetalShape(size) {
    const s = size > 6 ? size : 6;
    const off = document.createElement('canvas');
    off.width = off.height = s * 3;
    const c = off.getContext('2d');
    c.translate(s * 1.5, s * 1.5);
    c.scale(0.55, 1);
    const r = s * 0.85;
    const grad = c.createRadialGradient(0, -r * 0.15, r * 0.08, 0, r * 0.25, r);
    grad.addColorStop(0, 'rgba(255,248,250,0.95)');
    grad.addColorStop(0.45, 'rgba(244,167,195,0.75)');
    grad.addColorStop(1, 'rgba(224,90,138,0.2)');
    c.beginPath();
    c.arc(0, r * 0.25, r, 0, Math.PI * 2);
    c.fillStyle = grad;
    c.fill();
    c.beginPath();
    c.arc(0, -r * 0.5, r * 0.22, 0, Math.PI * 2);
    c.fillStyle = 'rgba(255,255,255,0.55)';
    c.fill();
    return off;
  }

  // 两种大小的花瓣模板
  const petalSmall = createPetalShape(8);
  const petalLarge = createPetalShape(12);

  function spawnPetal() {
    const large = Math.random() > 0.5;
    const size = large ? 12 : 8;
    return {
      x: Math.random() * (w || 1024),
      y: -(30 + Math.random() * 100),
      speed: 0.7 + Math.random() * 1.5,
      wobble: (Math.random() - 0.5) * 0.55,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.025,
      opacity: 0.4 + Math.random() * 0.5,
      size,
      shape: large ? petalLarge : petalSmall,
      phase: Math.random() * Math.PI * 2
    };
  }

  function initPetals() {
    sakuraPetals.length = 0;
    for (let i = 0; i < 16; i++) {
      const p = spawnPetal();
      p.y = Math.random() * (h || 768);
      sakuraPetals.push(p);
    }
  }

  function animate() {
    if (!w || !h) resize();
    ctx.clearRect(0, 0, w, h);

    while (sakuraPetals.length < 16) sakuraPetals.push(spawnPetal());

    for (let i = sakuraPetals.length - 1; i >= 0; i--) {
      const p = sakuraPetals[i];
      p.y += p.speed;
      p.x += Math.sin(p.phase + p.y * 0.01) * p.wobble;
      p.rotation += p.rotSpeed;

      if (p.y > h + 50) { sakuraPetals[i] = spawnPetal(); continue; }

      ctx.save();
      ctx.globalAlpha = p.opacity;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.drawImage(p.shape, -p.size * 1.5, -p.size * 1.5);
      ctx.restore();
    }
    sakuraAnimId = requestAnimationFrame(animate);
  }

  resize();
  initPetals();
  window.addEventListener('resize', resize);
  sakuraAnimId = requestAnimationFrame(animate);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (sakuraAnimId) { cancelAnimationFrame(sakuraAnimId); sakuraAnimId = null; }
    } else if (!sakuraAnimId) {
      resize();
      initPetals();
      sakuraAnimId = requestAnimationFrame(animate);
    }
  });
}

// ===== 咕嘎鸭动画系统 =====
let wonderDuckTimer = null;
let wonderDuckVisible = false;

function initWonderDuck() {
  const duck = document.getElementById('wonder-duck');
  if (!duck) return;
  // 随机间隔让鸭子出现
  function scheduleNext() {
    wonderDuckTimer = setTimeout(() => {
      if (wonderDuckVisible) { scheduleNext(); return; }
      // 仅在书架页面显示
      if (!$id('page-shelf').classList.contains('active')) { scheduleNext(); return; }
      showWonderDuck();
    }, 10000 + Math.random() * 20000);
  }

  function showWonderDuck() {
    wonderDuckVisible = true;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const startX = Math.random() > 0.5 ? -60 : vw + 60;
    const startY = vh * 0.3 + Math.random() * vh * 0.5;
    const endX = startX < 0 ? vw * 0.3 + Math.random() * vw * 0.3 : vw * 0.3 + Math.random() * vw * 0.3;

    duck.style.left = startX + 'px';
    duck.style.top = startY + 'px';
    duck.style.opacity = '1';
    duck.style.transform = startX < 0 ? 'scaleX(-1)' : 'scaleX(1)';
    duck.style.transition = 'none';

    requestAnimationFrame(() => {
      duck.style.transition = `left 4s linear, top 1.5s ease-in-out`;
      duck.style.left = endX + 'px';
      if (Math.random() > 0.5) duck.style.top = (startY - 30) + 'px';
    });

    setTimeout(() => {
      duck.style.opacity = '0';
      wonderDuckVisible = false;
      scheduleNext();
    }, 4500);
  }

  scheduleNext();
}

// 眨眼动画控制
function duckBlink(duckEl) {
  if (!duckEl) return;
  const pupil = duckEl.querySelector('.duck-pupil');
  setInterval(() => {
    if (!pupil) return;
    pupil.style.transform = 'scaleY(0.1)';
    setTimeout(() => { pupil.style.transform = 'scaleY(1)'; }, 120);
  }, 3000 + Math.random() * 4000);
}

// 角落小鸭可见性
function updateCornerDuck() {
  const duck = document.getElementById('corner-duck');
  if (!duck) return;
  const onShelf = document.getElementById('page-shelf').classList.contains('active');
  duck.style.opacity = onShelf ? '0.45' : '0';
  // 工具栏小鸭
  const toolbarDuck = document.getElementById('toolbar-duck');
  if (toolbarDuck) {
    toolbarDuck.style.opacity = !onShelf ? '0.6' : '0';
  }
}

// ===== 启动 =====
init();
initSakuraCanvas();
initWonderDuck();
updateCornerDuck();
// 初始化眨眼
setTimeout(() => {
  duckBlink(document.getElementById('corner-duck')?.querySelector('svg'));
}, 1000);

// ===== 懒分页引擎 v4（同步分组 + 鲁棒错误处理 + 5s 安全兜底）=====

function estimateTextSize(text, pageW, pageH, isVertical) {
  if (!text) return 0;
  var fontSize = (state.settings && state.settings.fontSize) || 16;
  var lineHeight = (state.settings && state.settings.lineHeight) || 1.6;
  var totalW = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    totalW += (code > 127 || code === 12288) ? fontSize : fontSize * 0.55;
  }
  var maxDim = isVertical ? pageH : pageW;
  var lines = Math.max(1, Math.ceil(totalW / maxDim));
  return lines * fontSize * lineHeight;
}

function calcPagesAsync(done) {
  var content = $id('reader-content');
  var body = $id('reader-body');
  var container = $id('page-container');
  var indicator = $id('page-indicator');

  try {
    var ch = state.currentBook && state.currentBook.chapters && state.currentBook.chapters[state.currentChapter];
    var isVertical = !!(ch && ch.writingMode === 'vertical-rl');

    // 正确计算可用宽高：减去 #reader-body 的上下 padding，再减去页码指示器占用的底部空间
    var cs = getComputedStyle(body);
    var padTop = parseFloat(cs.paddingTop) || 0;
    var padBot = parseFloat(cs.paddingBottom) || 0;
    var indicatorSpace = 30; // 页码指示器占用空间
    var vw = body.clientWidth;
    var vh = body.clientHeight - padTop - padBot - indicatorSpace;
    if (!vw || !vh) {
      console.warn('[calcPagesAsync] 尺寸为 0，延迟重试');
      setTimeout(function() { calcPagesAsync(done); }, 100);
      return;
    }

    var gutter = Math.max(36, Math.min(64, Math.round(vw * 0.045)));
    var padX = Math.max(18, Math.min(28, Math.round(vw * 0.028)));
    var padY = 28;
    var pageContentW = Math.floor((vw - gutter) / 2) - padX * 2;
    var pageContentH = vh - padY * 2 - 20; // -20: 底部页码槽位
    var pageLimit = isVertical ? pageContentW : pageContentH;

    state._pageW = pageContentW;
    state._pageH = pageContentH;
    state._gutter = gutter;
    state._padX = padX;
    state._padY = padY;

    // 辅助：判断叶子 HTML 是否包含图片/SVG（不只检测开头，兼容 <p><img> 等包裹情况）
    function leafContainsImage(html) {
      if (!html) return false;
      return html.indexOf('<img') !== -1 || html.indexOf('<svg') !== -1;
    }

    // ===== Step 1: Build leaves (synchronous, fast) =====
    var leaves = [];
    if (ch && ch._flatLeaves && ch._flatLeaves.length > 0) {
      leaves.push({ html: '<h1 class="chapter-heading">' + escHtml(ch.title) + '</h1>', elSize: 60 });
      for (var i = 0; i < ch._flatLeaves.length; i++) {
        var leaf = ch._flatLeaves[i];
        var html = (leaf.html || '').trim();
        if (!html) continue;
        var elSize = 0;
        if (leaf.isText) {
          elSize = estimateTextSize(html.replace(/<[^>]+>/g, ''), pageContentW, pageContentH, isVertical);
        } else if (html.charAt(0) === '<') {
          // 先检查是否包含图片（兼容被 <p> 等包裹的情况）
          if (leafContainsImage(html)) {
            elSize = Math.round(pageLimit * 0.6) + 4;
          } else {
            var mH = html.match(/height\s*:\s*(\d+)/i);
            if (mH) {
              elSize = parseInt(mH[1]) + 4;
            } else {
              var textLen = html.replace(/<[^>]+>/g, '').length;
              elSize = Math.ceil(textLen / Math.max(1, Math.floor(pageContentW / ((state.settings && state.settings.fontSize) || 16)))) * ((state.settings && state.settings.fontSize) || 16) * ((state.settings && state.settings.lineHeight) || 1.6);
              if (elSize > pageLimit) elSize = pageLimit * 0.85;
              if (elSize <= 0) elSize = 20;
            }
          }
        }
        leaves.push({ html: html, elSize: elSize, _hasImage: leafContainsImage(html) });
      }
    } else {
      var tmp = document.createElement('div');
      tmp.innerHTML = content.innerHTML;
      var childNodes = Array.from(tmp.childNodes);
      for (var j = 0; j < childNodes.length; j++) {
        var node = childNodes[j];
        if (node.nodeType === Node.TEXT_NODE) {
          var t = node.textContent.trim();
          if (!t) continue;
          leaves.push({ html: escHtml(t), elSize: estimateTextSize(t, pageContentW, pageContentH, isVertical), isText: true });
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          leaves.push({ html: node.outerHTML, elSize: 0 });
        }
      }
    }

    if (!leaves.length) {
      console.warn('[calcPagesAsync] 无叶子，跳过');
      body.style.overflow = '';
      if (container) container.innerHTML = '';
      if (typeof done === 'function') done();
      return;
    }

    // ===== Step 2: Group leaves into pages (SINGLE synchronous pass) =====
    var t0 = performance.now();
    var groups = [[]];
    var accumH = 0;
    for (var k = 0; k < leaves.length; k++) {
      var lf = leaves[k];
      var sz = lf.elSize || 0;

      // 图片单独成页：包含图片的叶子不跟文字挤在一起
      if (lf._hasImage) {
        if (groups[groups.length - 1].length > 0) groups.push([]);
        groups[groups.length - 1].push(lf);
        groups.push([]);
        accumH = 0;
        continue;
      }

      if (accumH + sz > pageLimit && groups[groups.length - 1].length > 0) {
        groups.push([lf]);
        accumH = sz;
      } else {
        groups[groups.length - 1].push(lf);
        accumH += sz;
      }
    }
    while (groups.length > 0 && groups[groups.length - 1].length === 0) groups.pop();

    var t1 = performance.now();
    console.log('[calcPagesAsync] ' + leaves.length + ' leaves → ' + groups.length + ' pages, ' + (t1 - t0).toFixed(1) + 'ms');

    // ===== Step 3: Save state =====
    state._calcLeaves = leaves;
    state._pageGroups = groups;
    state.pageIndex = 0;

    // ===== Step 4: Show paginate UI =====
    body.style.overflow = 'hidden';
    container.style.display = 'flex';
    indicator.style.display = 'block';
    var navZones = body.querySelector('.nav-zones');
    if (navZones) navZones.style.display = 'none';

    // ===== Step 5: Callback & render =====
    if (typeof done === 'function') done();
    renderSpread();

  } catch (e) {
    console.error('[calcPagesAsync] 分页异常，回退到滚动模式:', e);
    try {
      if (body) body.style.overflow = '';
      if (container) { container.style.display = 'none'; container.innerHTML = ''; }
      if (indicator) indicator.style.display = 'none';
      var nz = body && body.querySelector('.nav-zones');
      if (nz) nz.style.display = '';
      state.readingMode = 'scroll';
      if (typeof updateReadingModeUI === 'function') updateReadingModeUI();
      if (typeof showToast === 'function') showToast('⚠️ 分页失败，已切换到滚动模式');
    } catch(e2) {
      console.error('[calcPagesAsync] fallback 也失败了:', e2);
    }
  }
}

function calcPages() {
  calcPagesAsync(function() {});
}

// ===== 轻量安全兜底（5s 骨架屏超时）=====
(function() {
  var _origShow = window.showChapterLoading;
  if (typeof _origShow === 'function') {
    window.showChapterLoading = function() {
      if (typeof _origShow === 'function') _origShow();
      clearTimeout(window._globalSafetyTimer);
      window._globalSafetyTimer = setTimeout(function() {
        var c = document.getElementById('page-container');
        if (c && c.querySelector('.chapter-loading-spinner')) {
          console.error('[SafetyNet] 5s skeleton timeout, force cleanup');
          var b = document.getElementById('reader-body');
          if (b) b.style.overflow = '';
          if (c) c.innerHTML = '';
          state.readingMode = 'scroll';
          if (typeof updateReadingModeUI === 'function') updateReadingModeUI();
          if (typeof showToast === 'function') showToast('⚠️ 加载超时，已切换到滚动模式');
        }
      }, 5000);
    };
  }
  var _origRender = window.renderSpread;
  if (typeof _origRender === 'function') {
    window.renderSpread = function() {
      clearTimeout(window._globalSafetyTimer);
      return _origRender.apply(this, arguments);
    };
  }
})();

