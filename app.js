const DB_NAME = 'MediaArchiveDB';
const DB_VERSION = 2;
const ITEMS_STORE = 'media';
const GROUPS_STORE = 'groups';

const state = {
  items: [],
  groups: [],
  selectedId: null,
  selectedGroupId: 'all',
  filter: 'all',
  search: '',
  selection: new Set(),   // 批量多选的条目 id 集合
  lastSelectedId: null    // Shift 范围选择的基准
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(GROUPS_STORE)) {
        db.createObjectStore(GROUPS_STORE, { keyPath: 'id' });
      }
    };
  });
}

async function withStore(storeName, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(storeName, mode);
  const store = tx.objectStore(storeName);
  const result = await fn(store);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
  });
}

async function loadItems() {
  return withStore(ITEMS_STORE, 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
}

async function loadGroups() {
  return withStore(GROUPS_STORE, 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  });
}

async function saveItem(item) {
  return withStore(ITEMS_STORE, 'readwrite', (store) => store.put(item));
}

async function saveGroup(group) {
  return withStore(GROUPS_STORE, 'readwrite', (store) => store.put(group));
}

async function deleteItem(id) {
  return withStore(ITEMS_STORE, 'readwrite', (store) => store.delete(id));
}

async function deleteGroup(id) {
  return withStore(GROUPS_STORE, 'readwrite', (store) => store.delete(id));
}

// 按"以磁盘为准"的库索引校正条目里存的绝对路径。
// 起因：数据目录被搬到别的盘之后，文件跟着走了，但条目里记的还是旧绝对路径，
// 于是「在资源管理器中显示 / 打开」全都点了没反应（缩略图存在 IndexedDB 里，看着一切正常）。
// 返回修正的条数；库里找不到的（比如外部文件、真被删了）不动，避免误改。
async function repairItemPaths() {
  const index = await window.electronAPI?.getLibraryIndex?.();
  if (!index || !index.ok || !index.files) return 0;

  let fixed = 0;
  for (const item of state.items) {
    const real = index.files[item.id];
    if (!real) continue;
    if (item.backupPath === real) continue;
    item.backupPath = real;
    await saveItem(item);
    fixed++;
  }
  return fixed;
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function renderMarkdown(md) {
  if (!md) return '';
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // code blocks
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.trim()}</code></pre>`);
  // inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // headings
  html = html.replace(/^###### (.*$)/gim, '<h6>$1</h6>');
  html = html.replace(/^##### (.*$)/gim, '<h5>$1</h5>');
  html = html.replace(/^#### (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
  // bold / italic / strike / underline
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  html = html.replace(/\+\+([^+]+)\+\+/g, '<u>$1</u>');
  // links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // blockquote
  html = html.replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>');
  // horizontal rule
  html = html.replace(/^---$/gim, '<hr>');
  // tables：连续的 | 行解析为表格（第二行是分隔行 | --- | --- |）
  html = html.replace(/(?:^\|.*\|\s*\n?)+/gim, (block) => {
    const rows = block.trim().split('\n').map((r) => r.trim()).filter(Boolean);
    if (rows.length < 2) return block;
    const isSep = (r) => /^\|?[\s:|-]+\|?$/.test(r) && r.includes('-');
    const cells = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const header = cells(rows[0]);
    const bodyRows = rows.slice(1).filter((r) => !isSep(r)).map(cells);
    if (!header.length) return block;
    const th = header.map((c) => `<th>${c}</th>`).join('');
    const tb = bodyRows.map((row) => `<tr>${row.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>`;
  });
  // task lists（须在无序列表规则之前处理）
  html = html.replace(/^\- \[x\] (.*$)/gim, '<li>☑ $1</li>');
  html = html.replace(/^\- \[ \] (.*$)/gim, '<li>☐ $1</li>');
  // unordered lists
  html = html.replace(/^\- (.*$)/gim, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (match) => `<ul>${match}</ul>`);
  // ordered lists
  html = html.replace(/^\d+\. (.*$)/gim, '<li>$1</li>');
  // paragraphs
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = `<p>${html}</p>`;
  // clean up empty paragraphs
  html = html.replace(/<p><\/p>/g, '');
  return html;
}

function getNoteExcerpt(content, max = 80) {
  if (!content) return '空白笔记';
  const isHtml = /<[a-z][^>]*>/i.test(content);
  const text = isHtml
    ? content.replace(/<[^>]+>/g, " ")
    : content.replace(/[#*`\[\]()>\-_]/g, ' ');
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

function formatDateTimeLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function readFileAsDataURL(file) {
  // 粘贴进来的"文件"只是普通对象（没有真 File 句柄可读），走主进程按路径读
  if (file && file.__sourcePath) {
    const res = await window.electronAPI?.readFileDataUrl?.(file.__sourcePath);
    return (res && res.ok) ? res.dataUrl : '';
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 列表卡片最宽也就 ~120px，256px 的缩略图足够清晰；
// 之前存 320px/0.85 偏大，而且生成失败时会退化成"整张原图 / 整段视频"的 base64 ——
// 那是列表渲染慢的主因（11 个条目的缩略图能撑到 6.8MB），所以这里既压小又绝不回退成大图。
const THUMB_MAX_EDGE = 256;
const THUMB_QUALITY = 0.72;
// 正常缩略图都在 30KB 以内，超过这个体积一定是早期版本存的异常数据
const THUMB_SANE_BYTES = 120 * 1024;

function getVideoThumbnail(videoURL) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 抽完帧立刻放开解码器，否则这个临时 video 会一直占着解码缓冲
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (_) { /* ignore */ }
      resolve(value);
    };
    // 万一解码卡住（损坏的视频 / 不支持的编码），别把导入流程挂死
    const timer = setTimeout(() => finish(null), 8000);

    video.src = videoURL;
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, video.duration / 10) || 0.1;
    };
    video.onseeked = () => {
      try {
        const scale = Math.min(1, THUMB_MAX_EDGE / (video.videoWidth || THUMB_MAX_EDGE));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((video.videoWidth || THUMB_MAX_EDGE) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || 180) * scale));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', THUMB_QUALITY));
      } catch (_) {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
  });
}

// 读取音频时长（秒），失败返回 0
function getAudioDuration(dataURL) {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 拿到时长就放开音频元素，别让元数据缓冲一直挂着
      try {
        audio.removeAttribute('src');
        audio.load();
      } catch (_) { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(0), 8000);   // 读不出来的音频别把导入挂死
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      finish(Number.isFinite(audio.duration) ? audio.duration : 0);
    };
    audio.onerror = () => finish(0);
    audio.src = dataURL;
  });
}

// 早期版本在缩略图生成失败时会退化成"整张原图 / 整段视频"的 base64（单个能到几 MB），
// 而每次渲染列表都要解析这些巨串 —— 启动后在空闲时间里把它们重做成正常尺寸。
// 扫一遍只是比长度（很快），修完就再也不会命中，属于一次性的自愈。
async function repairThumbnails() {
  const oversized = state.items.filter((it) => (it.thumbnail || '').length > THUMB_SANE_BYTES);
  if (!oversized.length) return 0;

  let fixed = 0;
  for (const item of oversized) {
    try {
      if (String(item.thumbnail).startsWith('data:image/')) {
        item.thumbnail = (await getImageThumbnail(item.thumbnail)) || '';
      } else if (item.type === 'video') {
        // 视频条目的"缩略图"位置存的其实是整段视频 → 重新抽一帧
        const diskPath = itemDiskPath(item);
        const res = diskPath ? await window.electronAPI?.readFileDataUrl?.(diskPath) : null;
        const frame = (res && res.ok) ? await getVideoThumbnail(res.dataUrl) : null;
        item.thumbnail = frame || '';
      } else {
        item.thumbnail = '';
      }
      await saveItem(item);
      fixed++;
    } catch (_) { /* 单个失败不影响其他 */ }
    // 让出主线程，修复过程不要影响正在进行的操作
    await new Promise((r) => setTimeout(r, 30));
  }

  if (fixed) {
    renderGrid();
    showToast(`已重建 ${fixed} 个过大的缩略图，列表翻页会更快`, { duration: 5000 });
  }
  return fixed;
}

// 图片缩略图：等比缩到最长边 256px 的 JPEG，避免把原图 base64 存进数据库。
// 生成失败时返回空字符串（卡片用扩展名兜底），绝不回退成原图 —— 否则数据库和列表都会被撑爆。
function getImageThumbnail(dataURL) {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // 用完把 img 的来源放开，避免解码结果被这个临时元素继续引用
      try { img.removeAttribute('src'); } catch (_) { /* ignore */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), 8000);   // 异常图片别把导入挂死

    img.onload = () => {
      try {
        const scale = Math.min(1, THUMB_MAX_EDGE / Math.max(img.width || 1, img.height || 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((img.width || THUMB_MAX_EDGE) * scale));
        canvas.height = Math.max(1, Math.round((img.height || THUMB_MAX_EDGE) * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', THUMB_QUALITY));
      } catch (_) {
        finish('');
      }
    };
    img.onerror = () => finish('');
    img.src = dataURL;
  });
}

// 条目在磁盘上的文件路径：优先库内文件，其次外部原路径
function itemDiskPath(item) {
  if (!item) return '';
  return item.backupPath || item.sourcePath || '';
}

// 条目所属分组的文件夹名（未分组 → 「未分组」文件夹）
function itemGroupFolder(item) {
  if (!item || !item.groupId) return getUngroupedName();
  const group = state.groups.find((g) => g.id === item.groupId);
  return group ? group.name : getUngroupedName();
}

// 分组 id → 文件夹名（'' 表示 library 根目录，即「全部」）
function groupFolderName(groupId) {
  if (!groupId || groupId === 'all') return '';
  if (groupId === 'ungrouped') return getUngroupedName();
  const group = state.groups.find((g) => g.id === groupId);
  return group ? group.name : getUngroupedName();
}

// 把条目的库内文件移动到它当前所属分组的文件夹，返回路径是否变化
async function relocateItemFile(item) {
  if (!item || !item.backupPath || !window.electronAPI?.placeMediaFile) return false;
  const res = await window.electronAPI.placeMediaFile(item.id, item.backupPath, itemGroupFolder(item));
  if (!res || !res.ok) return false;
  const changed = res.path !== item.backupPath;
  item.backupPath = res.path;
  return changed;
}

// 批量重新落位（分组变动后调用），并清理留下的空文件夹
async function relocateItemsFiles(items) {
  let moved = 0;
  for (const item of items) {
    if (await relocateItemFile(item)) {
      await saveItem(item);
      moved++;
    }
  }
  if (moved) window.electronAPI?.pruneLibraryFolders?.();
  return moved;
}

// ===== 整理资源：把所有资源文件归入"各自分组对应的文件夹" =====
// auto = true 时用于首次升级后自动跑一次（没有变化就静默结束）
async function organizeLibrary(auto = false) {
  const targets = state.items.filter((i) => i.type !== 'note');
  if (!targets.length) {
    if (!auto) showToast('还没有可整理的资源');
    return 0;
  }

  const steps = [];
  const mode = getImportMode();
  let moved = 0;
  let written = 0;
  let pulled = 0;
  let kept = 0;
  let failed = 0;

  for (const item of targets) {
    const folder = itemGroupFolder(item);

    // 1) 库内文件：挪进分组文件夹
    if (item.backupPath) {
      const res = await window.electronAPI?.placeMediaFile?.(item.id, item.backupPath, folder);
      if (res && res.ok) {
        if (res.path !== item.backupPath) {
          steps.push({ kind: 'move', id: item.id, from: item.backupPath, to: res.path });
          item.backupPath = res.path;
          await saveItem(item);
          moved++;
        } else {
          kept++;
        }
      } else {
        failed++;
      }
      continue;
    }

    // 2) 只有内嵌数据（老导入方式）：落盘到分组文件夹
    if (item.dataURL) {
      const res = await window.electronAPI?.ensureBackup?.(item.id, item.dataURL, folder);
      if (res && res.ok) {
        steps.push({ kind: 'materialize', id: item.id, to: res.path });
        item.backupPath = res.path;
        await saveItem(item);
        written++;
      } else {
        failed++;
      }
      continue;
    }

    // 3) 只有外部原路径：按当前导入方式收进库
    if (item.sourcePath) {
      const res = await window.electronAPI?.placeMediaFile?.(item.id, item.sourcePath, folder, mode);
      if (res && res.ok) {
        steps.push({ kind: 'import', id: item.id, from: item.sourcePath, to: res.path, mode });
        item.backupPath = res.path;
        if (mode !== 'copy') item.sourcePath = '';
        await saveItem(item);
        pulled++;
      } else {
        failed++;
      }
      continue;
    }

    failed++;
  }

  window.electronAPI?.pruneLibraryFolders?.();
  renderFolders();
  renderGrid();

  const changed = moved + written + pulled;
  if (auto && !changed) return 0;

  const parts = [];
  if (moved) parts.push(`${moved} 个文件已移入各自分组文件夹`);
  if (written) parts.push(`${written} 个内嵌数据已落盘`);
  if (pulled) parts.push(`${pulled} 个原文件已收入资源文件夹`);
  if (kept) parts.push(`${kept} 个已在正确位置`);
  if (failed) parts.push(`${failed} 个未能处理`);
  if (!parts.length) parts.push('所有资源都已在各自分组文件夹里');

  showToast(parts.join('，'), {
    duration: 9000,
    action: steps.length ? { label: '撤销', onAction: () => undoOrganize(steps) } : null
  });
  return changed;
}

// 撤销整理：文件与记录一起回滚
async function undoOrganize(steps) {
  const moves = [];
  for (const step of steps) {
    if (step.kind === 'move' || (step.kind === 'import' && step.mode !== 'copy')) {
      moves.push({ libraryPath: step.to, originalPath: step.from });
    }
  }
  if (moves.length) await window.electronAPI?.undoImportFiles?.(moves);

  for (const step of steps) {
    if (step.kind === 'materialize' || (step.kind === 'import' && step.mode === 'copy')) {
      await window.electronAPI?.trashFile?.(step.to);
    }
  }

  for (const step of steps) {
    const item = state.items.find((i) => i.id === step.id);
    if (!item) continue;
    if (step.kind === 'move') {
      item.backupPath = step.from;
    } else if (step.kind === 'materialize') {
      item.backupPath = '';
    } else if (step.kind === 'import') {
      item.sourcePath = step.from;
      item.backupPath = '';
    }
    await saveItem(item);
  }

  window.electronAPI?.pruneLibraryFolders?.();
  renderFolders();
  renderGrid();
  showToast('已撤销整理，文件已回到原位');
}

function getGroupName(groupId) {
  if (groupId === 'all') return '全部';
  if (groupId === 'ungrouped') return getUngroupedName();
  const group = state.groups.find((g) => g.id === groupId);
  return group ? group.name : getUngroupedName();
}

const UNGROUPED_NAME_KEY = 'memorie.ungroupedName';

function getUngroupedName() {
  return localStorage.getItem(UNGROUPED_NAME_KEY) || '未分组';
}

function setUngroupedName(name) {
  localStorage.setItem(UNGROUPED_NAME_KEY, name);
}

function countItemsInGroup(groupId) {
  if (groupId === 'all') return state.items.length;
  if (groupId === 'ungrouped') return state.items.filter((i) => !i.groupId).length;
  return state.items.filter((i) => i.groupId === groupId).length;
}

// 默认导入：把原文件"移动"进软件资源目录（userData/library）
// 只有拿不到磁盘路径时（如从剪贴板粘贴），才退回"base64 存进数据库"的兜底方案
// ===== 导入方式设置：move（默认，移动原文件）| copy（复制，保留原文件）=====
const IMPORT_MODE_KEY = 'memorie.importMode';
const HINT_MORE_KEY = 'memorie.hint.moreMenu';
const ORGANIZED_KEY = 'memorie.organizedOnce';

function getImportMode() {
  return localStorage.getItem(IMPORT_MODE_KEY) === 'copy' ? 'copy' : 'move';
}

function hasImportMode() {
  const v = localStorage.getItem(IMPORT_MODE_KEY);
  return v === 'copy' || v === 'move';
}

function setImportMode(mode) {
  localStorage.setItem(IMPORT_MODE_KEY, mode === 'copy' ? 'copy' : 'move');
}

// 首次导入必现的说明：文件会去哪 + 移动还是复制
async function ensureImportModeChosen() {
  if (hasImportMode()) return true;

  const choice = await confirmChoice({
    title: '文件会存到哪里？',
    message: '导入的文件会统一放进软件的资源文件夹。\n'
      + '（之后可在「⋯ → 打开软件资源文件夹」里查看）\n\n'
      + '请选择原文件的处理方式，之后可以在「⋯」菜单里随时修改：',
    optionA: '移动到资源文件夹（推荐：原位置不再保留文件）',
    optionB: '复制到资源文件夹（原文件保留在原处）',
    optionC: { label: '取消' }
  });
  if (!choice || choice === 'c') return false;

  setImportMode(choice === 'b' ? 'copy' : 'move');
  return true;
}

// 撤销一次导入：文件归位 + 删掉刚建的记录
async function undoImport(items, steps) {
  if (steps.length) await window.electronAPI?.undoImportFiles?.(steps);
  for (const item of items) {
    await deleteItem(item.id);
    state.items = state.items.filter((i) => i.id !== item.id);
  }
  if (items.some((i) => i.id === player.currentId)) stopMusic();
  if (items.some((i) => i.id === state.selectedId)) resetPreview();
  renderFolders();
  renderGrid();
  showToast('已撤销这次导入，文件已放回原处');
}

// 删除的撤销：把记录放回去（仅在没删文件时可用）
async function restoreItems(snapshots) {
  for (const snap of snapshots) {
    await saveItem(snap);
    state.items.push(snap);
  }
  renderFolders();
  renderGrid();
  showToast('已撤销删除');
}

// 判断文件属于哪一类：图片 / 视频 / 音频 / 其他文件
// （系统给不出 MIME 的冷门格式，按扩展名再判一次；仍认不出来就归「其他文件」）
const EXT_KINDS = {
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', '3gp'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mid', 'amr'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'avif', 'ico', 'tif', 'tiff', 'heic']
};

function kindOfFile(file) {
  const mime = String((file && file.type) || '');
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const ext = String((file && file.name) || '').split('.').pop().toLowerCase();
  for (const kind of Object.keys(EXT_KINDS)) {
    if (EXT_KINDS[kind].includes(ext)) return kind;
  }
  return 'other';
}

// 「其他文件」没有缩略图，封面 / 预览卡就用扩展名代替图标
function fileExtLabel(name) {
  const parts = String(name || '').split('.');
  const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
  return ext ? ext.slice(0, 5).toUpperCase() : 'FILE';
}

function isOtherItem(item) {
  return Boolean(item) && item.type === 'other';
}

// PDF / Office 这类文档不在应用内渲染：直接交给系统默认程序打开（保真度最高，
// 也不用背一个几 MB 的解析 bundle）。下面的 officeActions() 就是那个出口。
// 这排按钮会浮在文档右下角，所以标签保持简短，完整说明放 title；右侧还有个收起把手
function officeActions(item) {
  const bar = document.createElement('div');
  bar.className = 'office-actions';

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'btn btn--primary btn--sm';
  openBtn.textContent = '打开';
  openBtn.title = '用默认程序打开';
  openBtn.addEventListener('click', async () => {
    const res = await window.electronAPI?.openExternal?.(itemDiskPath(item));
    if (!res || !res.ok) showToast('打开失败：' + ((res && res.error) || '未知错误'));
  });

  const folderBtn = document.createElement('button');
  folderBtn.type = 'button';
  folderBtn.className = 'btn btn--secondary btn--sm';
  folderBtn.textContent = '位置';
  folderBtn.title = '在文件夹中显示';
  folderBtn.addEventListener('click', async () => {
    const diskPath = itemDiskPath(item);
    if (!diskPath) { showToast('这个条目还没有落盘文件'); return; }
    const res = await window.electronAPI?.showInExplorer?.(diskPath);
    if (res && !res.ok) showToast(res.error || '找不到这个文件');
  });

  bar.appendChild(openBtn);
  bar.appendChild(folderBtn);

  return bar;
}

// 其他文件：给一张"文件卡"，显示扩展名 + 文件名 +「打开 / 位置」两个出口
// （PDF / Office 也走这里：不在应用内渲染，直接用系统默认程序打开）
function renderOtherPreview(stage, item, note = '用「打开」交给系统默认程序（保真度最高），「位置」在文件夹中定位') {
  const wrap = document.createElement('div');
  wrap.className = 'audio-stage';

  const art = document.createElement('div');
  art.className = 'audio-stage__art audio-stage__art--file';
  art.textContent = fileExtLabel(item.name);

  const nameEl = document.createElement('div');
  nameEl.className = 'audio-stage__name';
  nameEl.textContent = item.name;

  wrap.appendChild(art);
  wrap.appendChild(nameEl);

  if (note) {
    const tip = document.createElement('div');
    tip.className = 'office-notice';
    tip.textContent = note;
    wrap.appendChild(tip);
  }

  // 能定位到磁盘文件时，给一个"交给系统默认程序"的出口
  if (itemDiskPath(item)) wrap.appendChild(officeActions(item));
  stage.appendChild(wrap);
}

async function addFiles(files) {
  const targetGroupId = state.selectedGroupId !== 'all' && state.selectedGroupId !== 'ungrouped'
    ? state.selectedGroupId
    : null;

  let added = 0;
  let placed = 0;
  let placeFailed = 0;
  const createdItems = [];
  const undoSteps = [];
  const usedModes = new Set();   // 一次导入可能混着"移动"和"复制"（粘贴的图片走移动，复制的文件走复制）

  for (const file of files) {
    // 图片 / 视频 / 音频 / 其他文件：认不出类型的（pdf、zip、txt…）统一归「其他文件」
    const mediaType = kindOfFile(file);
    // 粘贴进来的"文件"是普通对象（只有 name/size/__sourcePath），指定好来源与导入方式后
    // 就能走完整个导入流程：剪贴板图片 = 移动临时文件；复制的文件 = 复制一份（不动原文件）
    const mode = file.__forceMode || getImportMode();
    usedModes.add(mode);

    const id = generateId();
    const sourcePath = file.__sourcePath || (window.electronAPI?.getPathForFile
      ? window.electronAPI.getPathForFile(file)
      : '');

    // 缩略图 / 时长必须在移动文件本体之前生成（之后原路径就不存在了）
    // 「其他文件」不做缩略图、也不整个读进内存（可能是几百 MB 的压缩包），封面只显示扩展名
    const dataURL = (mediaType === 'other' && sourcePath) ? '' : await readFileAsDataURL(file);
    let thumbnail = '';
    let duration = 0;
    if (mediaType === 'video') {
      // 抽帧失败就留空（卡片显示 ▶），绝不把整段视频当缩略图存进去
      thumbnail = (await getVideoThumbnail(dataURL)) || '';
    } else if (mediaType === 'audio') {
      duration = await getAudioDuration(dataURL);
    } else if (mediaType === 'image') {
      thumbnail = await getImageThumbnail(dataURL);
    }

    let backupPath = '';
    let keptSourcePath = sourcePath;
    let storedDataURL = '';

    if (sourcePath && window.electronAPI?.placeMediaFile) {
      // 落到"当前分组对应的子文件夹"（未分组 → 「未分组」文件夹）
      const folder = targetGroupId ? groupFolderName(targetGroupId) : getUngroupedName();
      const res = await window.electronAPI.placeMediaFile(id, sourcePath, folder, mode);
      if (res && res.ok) {
        backupPath = res.path;                       // 已放进软件资源文件夹
        if (mode !== 'copy') keptSourcePath = '';    // 移动：原位置不再保留文件
        placed++;
        undoSteps.push({ libraryPath: res.path, originalPath: sourcePath });
      } else {
        placeFailed++;                               // 处理失败 → 退回"引用原路径"
      }
    }
    // 既没入库、又没有原路径 → 只能把内容本身存进库
    if (!backupPath && !keptSourcePath) storedDataURL = dataURL;

    const item = {
      id,
      name: file.name,
      type: mediaType,
      mime: file.type,
      size: file.size,
      dataURL: storedDataURL,
      thumbnail,
      duration,
      backupPath,
      sourcePath: keptSourcePath,
      createdAt: Date.now(),
      time: formatDateTimeLocal(new Date()),
      category: '',
      description: '',
      groupId: targetGroupId
    };

    await saveItem(item);
    state.items.push(item);
    createdItems.push(item);
    added++;
  }

  renderFolders();
  renderGrid();

  const parts = [`已导入 ${added} 个项目`];
  if (placed) {
    parts.push(usedModes.has('move')
      ? `${placed} 个文件已移入资源文件夹`
      : `${placed} 个文件已复制到资源文件夹`);
  }
  if (placeFailed) parts.push(`${placeFailed} 个未能入库（改为引用原路径）`);

  showToast(parts.join('，'), {
    duration: 8000,
    action: createdItems.length
      ? { label: '撤销', onAction: () => undoImport(createdItems, undoSteps) }
      : null
  });

  // 首次导入后一次性提示：更多操作藏在卡片上的 ⋯ 里
  if (added && !localStorage.getItem(HINT_MORE_KEY)) {
    localStorage.setItem(HINT_MORE_KEY, '1');
    setTimeout(() => {
      showToast('提示：鼠标移到卡片上会出现 ⋯ 按钮（右键也可以），复制 / 查看文件位置 / 删除都在里面', { duration: 8000 });
    }, 8200);
  }

  return createdItems;
}

// 剪贴板里的图片 / 复制的文件 → 当前分组
// 位图没有"原文件"可搬：主进程先落成临时 png，这里按"移动"入库（临时文件顺带被消费掉）
async function importFromClipboard() {
  const res = await window.electronAPI?.pasteClipboard?.();
  if (!res || !res.ok) {
    showToast('读取剪贴板失败：' + ((res && res.error) || '未知错误'));
    return;
  }
  if (res.kind === 'none') {
    showToast('剪贴板里没有图片或文件');
    return;
  }

  const sources = [];
  if (res.kind === 'image') {
    sources.push({
      name: res.name,
      type: 'image/png',
      size: res.size || 0,
      __sourcePath: res.path,
      __forceMode: 'move'
    });
  } else {
    for (const f of res.files || []) {
      // 复制来的文件一律"复制"一份，绝不因为粘贴就把原文件搬走
      sources.push({ name: f.name, type: '', size: f.size || 0, __sourcePath: f.path, __forceMode: 'copy' });
    }
  }
  if (!sources.length) {
    showToast('剪贴板里没有图片或文件');
    return;
  }

  const created = await addFiles(sources);
  if (!created || !created.length) return;

  // 粘进来的东西如果被当前筛选挡住，就切回「全部」，否则会以为没粘上
  const types = created.map((i) => i.type);
  if (state.filter !== 'all' && !types.includes(state.filter)) applyFilter('all');
  selectItem(created[created.length - 1].id);
}

// 切换文件类型筛选（chip 高亮 + 列表刷新）
function applyFilter(kind) {
  state.filter = kind;
  $$('.filter-chip').forEach((c) => c.classList.toggle('is-active', c.dataset.filter === kind));
  renderGrid();
}

async function createNote() {
  const targetGroupId = state.selectedGroupId !== 'all' && state.selectedGroupId !== 'ungrouped'
    ? state.selectedGroupId
    : null;

  const id = generateId();
  const now = Date.now();
  const item = {
    id,
    name: '未命名笔记',
    type: 'note',
    mime: 'text/markdown',
    size: 0,
    dataURL: '',
    thumbnail: '',
    createdAt: now,
    time: formatDateTimeLocal(new Date(now)),
    category: '',
    // 新笔记不再预填"在这里写下 Markdown 内容…"这句提示，免得每次都要手动删掉
    description: '# 新笔记',
    groupId: targetGroupId
  };

  await saveItem(item);
  state.items.push(item);

  applyFilter('note');

  renderFolders();
  selectItem(id);
  showToast('笔记已创建');
}

function getFilteredItems() {
  return state.items
    .filter((item) => {
      if (state.selectedGroupId === 'all') return true;
      if (state.selectedGroupId === 'ungrouped') return !item.groupId;
      return item.groupId === state.selectedGroupId;
    })
    .filter((item) => state.filter === 'all' || item.type === state.filter)
    .filter((item) => {
      if (!state.search) return true;
      const q = state.search.toLowerCase();
      return (
        item.name.toLowerCase().includes(q) ||
        (item.category || '').toLowerCase().includes(q) ||
        (item.description || '').toLowerCase().includes(q)
      );
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

// 音乐分组：由右键菜单「设为音乐分组」标记，不再看分组名
function isMusicGroup(groupId) {
  if (!groupId || groupId === 'all' || groupId === 'ungrouped') return false;
  const group = state.groups.find((g) => g.id === groupId);
  return Boolean(group && group.isMusic);
}

// 老数据迁移：以前靠"分组名含音乐"判断，首次加载时把这类分组补上标记
// （和旧行为一致：名字含音乐的分组本来就用播放器列表，里面的非音频资源同样是看不到的）
async function migrateMusicGroups() {
  for (const group of state.groups) {
    if (group.isMusic !== undefined) continue;
    group.isMusic = String(group.name || '').includes('音乐');
    await saveGroup(group);
  }
}

// 能否设为音乐分组：分组里不能有音频以外的资源（空分组可以）
function musicGroupBlocker(groupId) {
  const kinds = new Map();
  for (const item of state.items) {
    if (item.groupId !== groupId || item.type === 'audio') continue;
    kinds.set(item.type, (kinds.get(item.type) || 0) + 1);
  }
  if (!kinds.size) return '';
  const label = { image: '图片', video: '视频', note: '笔记', other: '其他文件' };
  const parts = [...kinds].map(([type, n]) => `${n} 个${label[type] || type}`);
  return `该分组里有 ${parts.join('、')}，不能设为音乐分组`;
}

// 播放器列表：只看当前分组里的音频，按文件名排序（顶部搜索框可按歌名过滤）
function getMusicItems() {
  return state.items
    .filter((item) => {
      if (state.selectedGroupId === 'all') return true;
      if (state.selectedGroupId === 'ungrouped') return !item.groupId;
      return item.groupId === state.selectedGroupId;
    })
    .filter((item) => item.type === 'audio')
    .filter((item) => {
      if (!state.search) return true;
      const q = state.search.toLowerCase();
      return item.name.toLowerCase().includes(q)
        || (item.category || '').toLowerCase().includes(q);
    })
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
}

function renderFolders() {
  const list = $('#folderList');
  // 侧栏只列分组：「全部」不再单独占一行 —— 没选中任何分组时就是「全部」，
  // 再点一次已选中的分组即可取消选择、回到「全部」
  const allGroups = [
    { id: 'ungrouped', name: getUngroupedName(), icon: '▣' },
    ...state.groups
  ];

  list.innerHTML = allGroups.map((group) => {
    const isActive = group.id === state.selectedGroupId;
    const count = countItemsInGroup(group.id);
    const isCustom = group.id !== 'ungrouped';
    return `
      <div class="folder-item ${isActive ? 'is-active' : ''}" data-id="${group.id}">
        <div class="folder-item__main">
          <span class="folder-item__icon">${group.isMusic ? '♪' : (group.icon || '▦')}</span>
          <input class="folder-item__name" value="${escapeHtml(group.name)}" readonly data-id="${group.id}" title="${isCustom ? '双击或点击 ✎ 重命名' : ''}">
        </div>
        <span class="folder-item__count">${count}</span>
        <button type="button" class="folder-item__more" data-more="${group.id}" title="更多操作" aria-label="更多操作">⋯</button>
      </div>
    `;
  }).join('');

  // 右键分组 → 在资源管理器中打开对应文件夹
  $$('.folder-item').forEach((el) => {
    el.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openGroupContextMenu(ev, el.dataset.id);
    });
  });

  // 行尾 ⋯ 按钮：和右键弹出同一个菜单（让"打开文件夹/重命名/删除"可被发现）
  $$('.folder-item__more').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openGroupContextMenu(e, btn.dataset.more);
    });
  });

  // 拖拽接收：把卡片/多选集合移动到目标分组（"全部"不作为目标）
  $$('.folder-item').forEach((el) => {
    const gid = el.dataset.id;
    if (gid === 'all') return;

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop-target');
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('is-drop-target');
      let ids = [];
      try {
        const parsed = JSON.parse(e.dataTransfer.getData('text/plain'));
        ids = Array.isArray(parsed) ? parsed : [parsed];
      } catch (_) { /* 非本应用数据，忽略 */ }
      ids = ids.filter(Boolean);
      if (ids.length) moveItemsToGroup(ids, gid);
    });
  });

  $$('.folder-item__main').forEach((main) => {
    const id = main.querySelector('.folder-item__name').dataset.id;
    main.addEventListener('click', (e) => {
      // 双击：进入重命名（未分组也可改名）
      if (e.detail === 2) {
        startRenameGroup(id);
        return;
      }
      // 再点一次已选中的分组 = 取消选择，回到「全部」
      state.selectedGroupId = state.selectedGroupId === id ? 'all' : id;
      renderFolders();
      renderGrid();
    });
  });


}

function startRenameGroup(groupId) {
  // "全部" 是系统分组，不可重命名；"未分组" 允许改名（持久化到 localStorage）
  if (groupId === 'all') {
    showToast('系统分组不可重命名');
    return;
  }

  const input = $(`.folder-item__name[data-id="${groupId}"]`);
  if (!input) return;

  input.readOnly = false;
  input.focus();
  input.select();

  const finish = async () => {
    const newName = input.value.trim();
    input.readOnly = true;
    if (!newName) {
      renderFolders();
      return;
    }

    if (groupId === 'ungrouped') {
      setUngroupedName(newName);
      await window.electronAPI?.ensureGroupFolder?.(newName);
      await relocateItemsFiles(state.items.filter((i) => !i.groupId));
      await window.electronAPI?.pruneLibraryFolders?.();
      renderFolders();
      renderMetaGroupOptions();
      showToast('未分组已改名，文件已归入新文件夹');
      return;
    }

    const group = state.groups.find((g) => g.id === groupId);
    if (group && group.name !== newName) {
      group.name = newName;
      await saveGroup(group);
      await window.electronAPI?.ensureGroupFolder?.(newName);
      await relocateItemsFiles(state.items.filter((i) => i.groupId === groupId));
      await window.electronAPI?.pruneLibraryFolders?.();
      renderFolders();
      renderMetaGroupOptions();
      showToast('分组已重命名，文件已归入新文件夹');
    }
  };

  input.addEventListener('blur', finish, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.readOnly = true;
      renderFolders();
    }
  }, { once: true });
}

async function createGroup(name = '新分组') {
  const group = {
    id: generateId(),
    name,
    icon: '▦',
    createdAt: Date.now()
  };
  await saveGroup(group);
  state.groups.push(group);
  // 建分组的同时就在资源文件夹里建好同名文件夹
  await window.electronAPI?.ensureGroupFolder?.(group.name);
  state.selectedGroupId = group.id;
  renderFolders();
  renderGrid();
  renderMetaGroupOptions();
  showToast('分组已创建，资源文件夹里已建好同名文件夹');
  // 创建后自动进入重命名模式，让用户立即命名
  setTimeout(() => startRenameGroup(group.id), 0);
}

async function removeGroup(groupId) {
  const group = state.groups.find((g) => g.id === groupId);
  if (!group) return;

  const itemsInGroup = state.items.filter((i) => i.groupId === groupId);
  const confirmed = await confirmDelete({
    title: '删除分组？',
    message: itemsInGroup.length > 0
      ? `「${group.name}」中有 ${itemsInGroup.length} 个项目，删除后这些项目将移至未分组。`
      : `确定要删除分组「${group.name}」吗？`,
    confirmText: '删除'
  });
  if (!confirmed) return;

  for (const item of itemsInGroup) {
    item.groupId = null;
    await saveItem(item);
  }
  // 项目落到「未分组」文件夹，原分组文件夹空了会被清理
  await relocateItemsFiles(itemsInGroup);

  await deleteGroup(groupId);
  state.groups = state.groups.filter((g) => g.id !== groupId);

  if (state.selectedGroupId === groupId) {
    state.selectedGroupId = 'all';
  }

  renderFolders();
  renderGrid();
  renderMetaGroupOptions();
  showToast('分组已删除，项目移至未分组');
}

function renderGrid() {
  const grid = $('#thumbGrid');
  const musicMode = isMusicGroup(state.selectedGroupId);

  // 有勾选时进入「批量模式」：所有卡片的左上角勾选框都显示出来，点一下就切换
  grid.classList.toggle('is-batch-mode', state.selection.size > 0);

  // 列表 / 分组 / 筛选 / 选中项变化都会影响"上一个 / 下一个"是否可用
  updatePreviewNav();

  $('.panel--left').classList.toggle('is-music', musicMode);
  $('#musicView').hidden = !musicMode;
  grid.hidden = musicMode;
  $('#searchInput').placeholder = musicMode ? '搜索歌名…' : '搜索...';

  // 分组名含「音乐」→ 中栏切换为播放器列表
  if (musicMode) {
    renderMusicList();
    $('#statusCount').textContent = `${player.queue.length} 首`;
    $('#statusType').textContent = '音乐';
    return;
  }

  const items = getFilteredItems();

  if (items.length === 0) {
    // 「其他文件」空的时候直接把"哪些文件会归到这里"讲清楚，别让人猜；
    // 每句都带上"空白处右键可以粘贴"，否则这个入口没人会发现
    const pasteHint = '在空白处右键可以粘贴剪贴板里的图片或文件';
    const hint = state.selectedGroupId !== 'all'
      ? '该分组为空 · ' + pasteHint
      : state.filter === 'other'
        ? 'PDF、压缩包、文档等非图片 / 视频 / 音频的文件都会归到这里，点上方「添加媒体」导入，也可以' + pasteHint
        : '点击上方按钮导入图片、视频、音频、其他文件，或新建笔记 · ' + pasteHint;
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">◫</div>
        <p>暂无项目</p>
        <p class="empty-state__hint">${hint}</p>
      </div>
    `;
  } else {
    grid.innerHTML = items.map((item) => {
      const isNote = item.type === 'note';
      const isOther = isOtherItem(item);
      const linked = isItemLinked(item);
      const media = isNote
        ? `<div class="thumb-card__media">✎</div>`
        : item.type === 'audio'
          ? `<div class="thumb-card__media">♪</div>`
          : isOther
            ? `<div class="thumb-card__media thumb-card__media--file"><b>${escapeHtml(fileExtLabel(item.name))}</b></div>`
            : item.thumbnail
              // decoding="async"：缩略图解压交给后台线程，切分组/滚动时不卡主线程
              ? `<img class="thumb-card__media" src="${item.thumbnail}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async" draggable="false">`
              : `<div class="thumb-card__media thumb-card__media--file"><b>${escapeHtml(fileExtLabel(item.name))}</b></div>`;
      const badge = isNote ? '✎'
        : linked ? '⤳'
        : item.type === 'video' ? '▶'
        : item.type === 'audio' ? '♪'
        : isOther ? '▦'
        : '◈';
      const badgeTip = linked ? ' title="链接（未导入，依赖原文件）"' : '';
      const name = isNote ? getNoteExcerpt(item.description) : item.name;
      const checked = state.selection.has(item.id);
      const classes = [
        'thumb-card',
        item.id === state.selectedId ? 'is-active' : '',
        checked ? 'is-selected' : ''
      ].filter(Boolean).join(' ');
      return `
        <div class="${classes}" draggable="true" data-id="${item.id}" data-type="${item.type}" title="${escapeHtml(item.name)}">
          ${media}
          <button type="button" class="thumb-card__check" data-check="${item.id}"
            title="${checked ? '取消选择' : '选择'}" aria-label="${checked ? '取消选择' : '选择'}"
            aria-pressed="${checked ? 'true' : 'false'}">✓</button>
          <span class="thumb-card__badge ${linked ? 'is-linked' : ''}"${badgeTip}>${badge}</span>
          <span class="thumb-card__name">${escapeHtml(name)}</span>
          <button type="button" class="thumb-card__more" data-more="${item.id}" title="更多操作" aria-label="更多操作">⋯</button>
        </div>
      `;
    }).join('');

    $$('.thumb-card').forEach((card) => {
      const cardId = card.dataset.id;

      // 拖拽移动到分组：携带单个 id 或整个多选集合
      card.addEventListener('dragstart', (e) => {
        const ids = state.selection.has(cardId) && state.selection.size > 1
          ? [...state.selection]
          : [cardId];
        e.dataTransfer.setData('text/plain', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('is-dragging');
      });
      card.addEventListener('dragend', () => {
        card.classList.remove('is-dragging');
        $$('.folder-item.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
      });

      // 右键菜单：若右键的卡片在多选集合中则作用于整个多选，否则单个
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const ids = state.selection.has(cardId) && state.selection.size > 1
          ? [...state.selection]
          : [cardId];
        openContextMenu(e, ids);
      });

      // ⋯ 按钮：和右键同一个菜单（不用右键也能找到这些操作）
      const moreBtn = card.querySelector('.thumb-card__more');
      if (moreBtn) {
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const ids = state.selection.has(cardId) && state.selection.size > 1
            ? [...state.selection]
            : [cardId];
          openContextMenu(e, ids);
        });
      }

      // 左上角勾选框：点一下就是选 / 取消，不打开详情、不影响其他已勾选项
      const checkBtn = card.querySelector('.thumb-card__check');
      if (checkBtn) {
        checkBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          toggleSelection(cardId);
        });
      }

      card.addEventListener('click', (e) => {
        const id = card.dataset.id;

        // Ctrl/Cmd + 点击：切换多选
        if (e.ctrlKey || e.metaKey) {
          toggleSelection(id);
          return;
        }

        // Shift + 点击：范围多选
        if (e.shiftKey && state.lastSelectedId) {
          const ordered = getFilteredItems();
          const a = ordered.findIndex((i) => i.id === state.lastSelectedId);
          const b = ordered.findIndex((i) => i.id === id);
          if (a !== -1 && b !== -1) {
            const [start, end] = a < b ? [a, b] : [b, a];
            for (let k = start; k <= end; k++) state.selection.add(ordered[k].id);
            syncGridSelection();
            updateBatchBar();
            return;
          }
        }

        // 普通点击：清空多选并预览
        if (state.selection.size) {
          state.selection.clear();
          syncGridSelection();
          updateBatchBar();
        }
        selectItem(id);
      });
    });
  }

  const filterLabels = { all: '全部', image: '图片', video: '视频', audio: '音频', note: '笔记', other: '其他文件' };
  $('#statusCount').textContent = `${items.length} 个项目`;
  $('#statusType').textContent = filterLabels[state.filter] || '全部';
}

// 预览区里的 <video>/<audio> 光把元素摘掉不会立刻释放解码帧和缓冲，
// 必须显式停掉 + 清空 src + load()，否则内存会一直挂着（切来切去越占越多）
function releaseStageMedia(stage) {
  if (!stage) return;
  for (const el of stage.querySelectorAll('video, audio')) {
    try {
      el.pause();
      el.removeAttribute('src');
      el.srcObject = null;
      el.load();
    } catch (_) { /* ignore */ }
  }
}

// 视频控件的 ResizeObserver：每次预览都会新建一个，不 disconnect 会一直持有旧元素
let previewResizeObserver = null;

function releasePreviewObserver() {
  if (!previewResizeObserver) return;
  try { previewResizeObserver.disconnect(); } catch (_) { /* ignore */ }
  previewResizeObserver = null;
}

// 只同步"选中 / 勾选"状态，不重建整张列表。
// 整表重建会让 Chromium 把每个缩略图重新解码一遍（GPUCache 与渲染进程内存一路涨），
// 所以条目和顺序没变时就只改 class —— 这是内存占用的主要来源之一。
function syncGridSelection() {
  const grid = $('#thumbGrid');

  if (isMusicGroup(state.selectedGroupId)) {
    renderGrid();
    return;
  }

  grid.classList.toggle('is-batch-mode', state.selection.size > 0);
  updatePreviewNav();

  const items = getFilteredItems();
  const cards = Array.from(grid.querySelectorAll('.thumb-card'));
  const sameList = cards.length === items.length
    && cards.every((card, idx) => card.dataset.id === items[idx].id);

  if (!sameList) {
    renderGrid();
    return;
  }

  for (const card of cards) {
    const id = card.dataset.id;
    card.classList.toggle('is-active', id === state.selectedId);
    card.classList.toggle('is-selected', state.selection.has(id));
  }
}

function renderMetaGroupOptions() {
  const select = $('#metaGroup');
  if (!select) return;

  const options = [
    { id: '', name: '未分组' },
    ...state.groups.map((g) => ({ id: g.id, name: g.name }))
  ];

  select.innerHTML = options.map((opt) =>
    `<option value="${opt.id}">${opt.name}</option>`
  ).join('');
}

// 解析条目的可预览 URL：优先库内 base64，其次库内文件 / 原路径
async function resolvePreviewUrl(item) {
  if (item.dataURL) return { ok: true, url: item.dataURL };
  const diskPath = itemDiskPath(item);
  if (diskPath && window.electronAPI?.readFileDataUrl) {
    const res = await window.electronAPI.readFileDataUrl(diskPath);
    if (res && res.ok) return { ok: true, url: res.dataUrl };
  }
  return { ok: false };
}

// 链接态：只有外部原路径、没有入库文件（默认导入不会产生这种条目）
function isItemLinked(item) {
  return Boolean(item && item.sourcePath && !item.backupPath && !item.dataURL);
}

function showMissingPreview(stage, item) {
  const missing = itemDiskPath(item);
  stage.innerHTML = `
    <div class="preview-placeholder preview-placeholder--missing">
      <div class="empty-state__icon">⚠</div>
      <p>文件不存在或无法读取</p>
      <p class="empty-state__hint" title="${escapeHtml(missing)}">${escapeHtml(missing)}</p>
      <p class="empty-state__hint">文件可能已被移动或删除，重新导入该项目即可恢复</p>
    </div>
  `;
}

// ===== 视频倍速：盖在原生控制条"更多选项"的位置上，悬停/点击选速度 =====
const VIDEO_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const VIDEO_RATE_KEY = 'memorie.playbackRate';
const rateLabel = (r) => (r === 1 || r === 2 ? r.toFixed(1) : String(r)) + '×';

function createSpeedControl(video, host) {
  const box = document.createElement('div');
  box.className = 'video-speed';

  // 沿用上次选过的倍速
  const saved = Number(localStorage.getItem(VIDEO_RATE_KEY));
  if (saved && VIDEO_SPEEDS.includes(saved)) video.playbackRate = saved;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'video-speed__btn';
  btn.title = '播放倍速';

  const menu = document.createElement('div');
  menu.className = 'video-speed__menu';
  menu.innerHTML = VIDEO_SPEEDS
    .map((r) => `<button type="button" data-rate="${r}" title="${r === 1 ? '正常速度' : '播放速度 ' + rateLabel(r)}">${rateLabel(r)}</button>`)
    .join('');

  const sync = () => {
    const rate = video.playbackRate;
    btn.textContent = rate === 1 ? '倍速' : rateLabel(rate);
    menu.querySelectorAll('button[data-rate]').forEach((b) => {
      b.classList.toggle('is-active', Number(b.dataset.rate) === rate);
    });
  };

  menu.addEventListener('click', (e) => {
    const option = e.target.closest('button[data-rate]');
    if (!option) return;
    e.stopPropagation();
    video.playbackRate = Number(option.dataset.rate);
    try {
      localStorage.setItem(VIDEO_RATE_KEY, String(video.playbackRate));
    } catch (_) { /* 存不下就算了 */ }
    box.classList.remove('is-open');
    sync();
  });

  // 点按钮直接钉住菜单（触控板 / 不想一直悬停时更好点）
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    box.classList.toggle('is-open');
  });

  box.appendChild(btn);
  box.appendChild(menu);
  sync();

  // 原生控制条在"悬停"和"暂停"两种情况下都会显示，倍速按钮要同步出现，
  // 否则暂停时原生控制条常显、那个 ⋮ 就露出来了
  const syncShown = () => box.classList.toggle('is-shown', video.paused);
  video.addEventListener('pause', syncShown);
  video.addEventListener('play', syncShown);
  video.addEventListener('ended', syncShown);
  syncShown();

  // 播放中鼠标移开后，原生控制条还会停留两三秒才淡出 —— 倍速按钮也停留同样久，
  // 不然这几秒里那个 ⋮ 会闪出来。
  // 注意别把"暂停时常显"这个状态丢掉：暂停时原生控制条一直显示，倍速也必须一直在
  let hideTimer = null;
  if (host) {
    host.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      syncShown();
    });
    host.addEventListener('mouseleave', () => {
      clearTimeout(hideTimer);
      if (video.paused) { syncShown(); return; }
      hideTimer = setTimeout(() => {
        if (!video.paused) box.classList.remove('is-shown');
      }, 3200);
    });
  }

  // 把控件对齐到视频右下角 —— 也就是原生控制条"更多选项"所在的位置
  const place = () => {
    if (!video.isConnected || !box.isConnected) return;
    const vr = video.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    box.style.left = Math.round(vr.right - hr.left - 6) + 'px';
    box.style.top = Math.round(vr.bottom - hr.top - 6) + 'px';

    // 视频上方放不下就把菜单翻到下面
    const stageTop = hr.top;
    const need = menu.offsetHeight + 46;
    box.classList.toggle('is-below', vr.bottom - need < stageTop);
  };

  place();
  if (window.ResizeObserver) {
    // 视频尺寸一变（元数据加载、窗口缩放）就重新对齐；
    // 存成模块级变量，切预览时统一 disconnect（否则每个预览都留一个观察者）
    releasePreviewObserver();
    previewResizeObserver = new ResizeObserver(place);
    previewResizeObserver.observe(video);
  }

  return box;
}

async function selectItem(id) {
  state.selectedId = id;
  syncGridSelection();   // 只改选中态，不重建列表（省下重复解码缩略图的开销与内存）

  const item = state.items.find((i) => i.id === id);
  if (!item) return;

  const stage = $('#previewStage');
  const notePreview = $('#notePreview');
  const previewPanel = $('#previewPanel');

  releaseStageMedia(stage);
  releasePreviewObserver();
  stage.innerHTML = '';
  notePreview.hidden = true;

  if (item.type === 'note') {
    previewPanel.classList.add('is-note-mode');
    stage.hidden = true;
    notePreview.hidden = false;
    renderNotePreview(notePreview, item.description || '');
    enterMarkdownMode(false, true);
    $('#saveBtn').hidden = true;
    $('#editNoteBtn').hidden = false;
    $('#importBtn').hidden = true;
    $('#metaDesc').closest('.field--markdown').hidden = true;
    $('.form-actions').hidden = true;
  } else {
    stage.hidden = false;
    stage.innerHTML = '<div class="preview-placeholder"><p>加载中…</p></div>';

    // 「其他文件」不走 data URL（可能是几百 MB 的压缩包，读成 base64 太浪费）；
    // PDF / Office 这些文档也不在应用内渲染，统一给"文件卡 + 用默认程序打开"
    const preview = isOtherItem(item) ? { ok: true, other: true } : await resolvePreviewUrl(item);
    // 期间用户可能已切换选中项
    if (state.selectedId !== item.id) return;
    stage.innerHTML = '';

    if (preview.other) {
      renderOtherPreview(stage, item);
    } else if (!preview.ok) {
      showMissingPreview(stage, item);
    } else if (item.type === 'audio') {
      const wrap = document.createElement('div');
      wrap.className = 'audio-stage';
      wrap.innerHTML = '<div class="audio-stage__art">♪</div>'
        + '<div class="audio-stage__name">' + escapeHtml(item.name) + '</div>';
      const playBtn = document.createElement('button');
      playBtn.type = 'button';
      playBtn.className = 'btn btn--primary';
      playBtn.textContent = player.currentId === item.id ? '正在播放' : '播放';
      playBtn.addEventListener('click', () => playMusicItem(item));
      wrap.appendChild(playBtn);
      stage.appendChild(wrap);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = preview.url;
      video.controls = true;
      video.autoplay = false;
      video.muted = true;
      video.playsInline = true;
      // 预览里的"全屏"不直接进系统全屏，而是先打开大播放器（见 openTheater）
      video.dataset.videoFor = item.id;
      video.__theater = () => openTheater(item, video);

      stage.appendChild(video);
      // 原生控制条上的"更多选项"改不了，就在同一位置盖一个"倍速"入口
      stage.appendChild(createSpeedControl(video, stage));
    } else {
      const img = document.createElement('img');
      img.src = preview.url;
      img.alt = item.name;
      stage.appendChild(img);
    }
    previewPanel.classList.remove('is-note-mode');
    enterMarkdownMode(false, true);
    $('#saveBtn').hidden = false;
    $('#editNoteBtn').hidden = true;
    $('#importBtn').hidden = !isItemLinked(item);
    $('#metaDesc').closest('.field--markdown').hidden = false;
    $('.form-actions').hidden = false;
  }

  $('#metaName').textContent = item.name;
  $('#metaTime').value = item.time || formatDateTimeLocal(new Date(item.createdAt));
  $('#metaCategory').value = item.category || '';
  $('#metaDesc').value = item.description || '';

  renderMetaGroupOptions();
  $('#metaGroup').value = item.groupId || '';

  if (item.type === 'note') {
    $('#fileInfo').textContent = `Markdown · ${new Date(item.createdAt).toLocaleString('zh-CN')}`;
    $('#fileInfo').title = '';
  } else {
    const diskPath = itemDiskPath(item);
    const stateLabel = isItemLinked(item) ? '链接（未入库）' : '已入库';
    // 「其他文件」没有 MIME，用扩展名（如 PDF 文件）代替
    const kindLabel = isOtherItem(item) ? `${fileExtLabel(item.name)} 文件` : item.mime;
    const pathLabel = diskPath ? ` · ${diskPath}` : '';
    $('#fileInfo').textContent = `${stateLabel} · ${kindLabel} · ${formatFileSize(item.size)} · ${new Date(item.createdAt).toLocaleString('zh-CN')}${pathLabel}`;
    $('#fileInfo').title = diskPath;
  }

  $('#metaPanel').hidden = false;
}

let markdownPreviewMode = false;

function enterMarkdownMode(preview = false, forcePlain = false) {
  const btn = $('#markdownModeBtn');
  const textarea = $('#metaDesc');
  const previewBox = $('#markdownPreviewBox');
  const label = $('#metaDescLabel');

  if (forcePlain) {
    btn.hidden = true;
    previewBox.hidden = true;
    textarea.hidden = false;
    textarea.dataset.mode = '';
    textarea.placeholder = '写下关于这张图片或视频的备注…';
    label.textContent = '简介';
    markdownPreviewMode = false;
    return;
  }

  btn.hidden = false;
  markdownPreviewMode = preview;

  if (preview) {
    btn.textContent = '编辑';
    textarea.hidden = true;
    previewBox.hidden = false;
    previewBox.innerHTML = renderMarkdown(textarea.value);
  } else {
    btn.textContent = '预览';
    textarea.hidden = false;
    previewBox.hidden = true;
    textarea.dataset.mode = 'source';
    textarea.placeholder = '支持 Markdown 语法…';
    label.textContent = 'Markdown';
  }
}

function updateNotePreview() {
  const item = state.items.find((i) => i.id === state.selectedId);
  if (item && item.type === 'note') {
    $('#notePreview').innerHTML = renderMarkdown($('#metaDesc').value);
  }
}

// "导入到库"：把链接态条目的原文件移动进软件资源目录
async function importCurrentItem() {
  const item = state.items.find((i) => i.id === state.selectedId);
  if (!item || !isItemLinked(item)) return;

  showToast('正在导入…');
  const res = await window.electronAPI?.placeMediaFile?.(item.id, item.sourcePath, itemGroupFolder(item));
  if (!res || !res.ok) {
    showToast('导入失败：' + ((res && res.error) || '原文件不存在或无法读取'));
    return;
  }

  item.backupPath = res.path;
  item.sourcePath = '';
  await saveItem(item);

  await selectItem(item.id);   // selectItem 自己会重画列表，这里不用再画一次
  showToast('已导入到库');
}

// ===== 批量多选 / 批量导入 / 批量删除 =====

// 当前列表里可见的条目（音乐视图走播放列表）
function currentListItems() {
  return isMusicGroup(state.selectedGroupId) ? getMusicItems() : getFilteredItems();
}

function updateBatchBar() {
  const bar = $('#batchBar');
  if (!bar) return;
  const count = state.selection.size;
  bar.hidden = count === 0;

  const linkedCount = state.items.filter((i) => state.selection.has(i.id) && isItemLinked(i)).length;
  $('#batchCount').textContent = `已选 ${count} 项`;
  $('#batchImportBtn').textContent = linkedCount > 0 ? `导入到库（${linkedCount}）` : '导入到库';
  $('#batchImportBtn').disabled = count === 0 || linkedCount === 0;
  $('#batchDeleteBtn').textContent = count ? `删除（${count}）` : '删除';

  const total = currentListItems().length;
  const allSelected = total > 0 && count >= total;
  $('#batchSelectAllBtn').disabled = allSelected;
  $('#batchSelectAllBtn').textContent = allSelected ? '已全选' : '全选';
}

// 全选当前列表（受分组 / 搜索 / 筛选影响；音乐视图选全部歌曲）
function selectAllInList() {
  const items = currentListItems();
  if (!items.length) {
    showToast('当前列表没有可选择的项目');
    return;
  }
  for (const item of items) state.selection.add(item.id);
  state.lastSelectedId = items[items.length - 1].id;
  syncGridSelection();
  updateBatchBar();
}

// 批量删除选中项（走统一的删除确认：可选"仅移除"或"连文件一起删"）
function deleteSelection() {
  const ids = [...state.selection];
  if (!ids.length) {
    showToast('请先选择要删除的项目');
    return null;
  }
  return confirmDeleteFlow(ids);
}

function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  syncGridSelection();
  updateBatchBar();
}

// 切换单个条目的勾选状态（卡片左上角勾选框、Ctrl/Cmd+点击共用）
function toggleSelection(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  state.lastSelectedId = id;
  syncGridSelection();
  updateBatchBar();
}

// 批量导入：把选中的链接态条目原文件移动进库
async function importSelected() {
  const targets = state.items.filter((i) => state.selection.has(i.id) && isItemLinked(i));
  if (!targets.length) {
    const count = state.selection.size;
    showToast(count
      ? `所选 ${count} 项均已在库内，无需导入`
      : '请先用 Ctrl+点击 选中要导入的项目');
    return;
  }
  if (!window.electronAPI?.placeMediaFile) {
    showToast('导入功能不可用：请完全关闭应用后重新启动');
    return;
  }

  let ok = 0;
  let fail = 0;
  for (let idx = 0; idx < targets.length; idx++) {
    showToast(`正在导入 ${idx + 1}/${targets.length}…`);
    const item = targets[idx];
    const res = await window.electronAPI.placeMediaFile(item.id, item.sourcePath, itemGroupFolder(item));
    if (res && res.ok) {
      item.backupPath = res.path;
      item.sourcePath = '';
      await saveItem(item);
      ok++;
    } else {
      fail++;
    }
  }

  state.selection.clear();
  renderGrid();
  updateBatchBar();
  if (state.selectedId) await selectItem(state.selectedId);
  showToast(`导入完成：成功 ${ok} 项${fail ? `，失败 ${fail} 项（原文件缺失）` : ''}`);
}

// 拖拽移动：把一批条目移到目标分组（gid 为 'ungrouped' 时表示移到未分组）
async function moveItemsToGroup(ids, gid) {
  const target = gid === 'ungrouped' ? null : gid;
  const movedItems = [];
  let changed = 0;

  for (const id of ids) {
    const item = state.items.find((i) => i.id === id);
    if (!item || item.groupId === target) continue;
    item.groupId = target;
    await saveItem(item);
    movedItems.push(item);
    changed++;
  }

  if (!changed) return;

  // 库内文件跟着分组走
  await relocateItemsFiles(movedItems);

  // 移走之后它们已经不在当前列表里了，清掉选中
  state.selection.clear();

  renderFolders();
  renderGrid();
  renderMetaGroupOptions();
  updateBatchBar();
  if (state.selectedId && ids.includes(state.selectedId)) {
    $('#metaGroup').value = target || '';
  }
  showToast(`已移动 ${changed} 个项目到「${getGroupName(gid)}」`);
}

async function saveCurrentMeta() {
  if (!state.selectedId) return;

  const item = state.items.find((i) => i.id === state.selectedId);
  if (!item) return;

  const prevGroupId = item.groupId;
  item.time = $('#metaTime').value;
  item.category = $('#metaCategory').value.trim();
  item.description = $('#metaDesc').value.trim();
  item.groupId = $('#metaGroup').value || null;

  await saveItem(item);
  // 在编辑栏里改了分组，文件也跟着走
  if (item.groupId !== prevGroupId) await relocateItemsFiles([item]);
  renderFolders();
  renderGrid();
  showToast('信息已保存');
}

function resetPreview() {
  state.selectedId = null;
  const stage = $('#previewStage');
  releaseStageMedia(stage);       // 先把播放器停掉并清空 src，内存立刻回收
  releasePreviewObserver();
  stage.hidden = false;
  stage.innerHTML = `
    <div class="preview-placeholder">
      <img class="preview-placeholder__art" src="assets/empty-preview.webp" alt="">
      <p>选择一个项目查看详情</p>
    </div>
  `;
  $('#previewPanel').classList.remove('is-note-mode');
  $('#notePreview').hidden = true;
  $('#metaPanel').hidden = true;
  enterMarkdownMode(false, true);
  updatePreviewNav();
}

// 执行删除：deleteFile 为 true 时把磁盘上的文件（库内文件 / 原文件）移入回收站
async function removeItems(ids, deleteFile) {
  let removed = 0;
  let trashed = 0;
  let failFiles = 0;
  const snapshots = []; // 用于"撤销"（只在没删文件时可用）

  for (const id of ids) {
    const item = state.items.find((i) => i.id === id);
    if (!item) continue;

    if (deleteFile) {
      const diskPath = itemDiskPath(item);
      if (diskPath) {
        const res = await window.electronAPI?.trashFile?.(diskPath);
        if (res && res.ok) {
          trashed++;
        } else {
          failFiles++;
          continue; // 文件删除失败时保留记录，避免出现指向已删文件的条目静默丢失
        }
      }
    }

    snapshots.push({ ...item });
    await deleteItem(id);
    state.items = state.items.filter((i) => i.id !== id);
    removed++;
  }

  if (!removed && !failFiles) return;

  if (ids.includes(player.currentId)) stopMusic(); // 正在播放的条目被删掉 → 停止播放
  if (ids.includes(state.selectedId)) resetPreview();
  state.selection.clear();
  renderFolders();
  renderGrid();
  updateBatchBar();

  const parts = [`已移除 ${removed} 个项目`];
  if (trashed) parts.push(`文件已移入回收站 ${trashed} 个（可从回收站还原）`);
  if (failFiles) parts.push(`${failFiles} 个文件删除失败（记录已保留）`);

  // 没动文件时提供"撤销"；删了文件就只能去回收站找
  const canUndo = !trashed && !failFiles && snapshots.length > 0;
  showToast(parts.join('，'), {
    duration: canUndo ? 8000 : 6000,
    action: canUndo ? { label: '撤销', onAction: () => restoreItems(snapshots) } : null
  });
}

// 确认对话框：resolve 'a' | 'b' | 'c' | null(取消)
// optionC 可选：{ label, disabledHint } —— disabledHint 存在时按钮呈半可用态，点击仅弹提示
function confirmChoice({ title, message, optionA, optionB, optionC }) {
  return new Promise((resolve) => {
    const overlay = $('#choiceOverlay');
    const btnA = $('#choiceBtnA');
    const btnB = $('#choiceBtnB');
    const btnC = $('#choiceBtnC');

    $('#choiceTitle').textContent = title;
    $('#choiceMessage').textContent = message;
    btnA.textContent = optionA;
    btnB.textContent = optionB;

    if (optionC) {
      btnC.hidden = false;
      btnC.textContent = optionC.label;
      btnC.classList.toggle('is-muted', Boolean(optionC.disabledHint));
      btnC.dataset.hint = optionC.disabledHint || '';
    } else {
      btnC.hidden = true;
      btnC.dataset.hint = '';
    }

    const cleanup = (result) => {
      overlay.classList.remove('is-visible');
      setTimeout(() => { overlay.hidden = true; }, 200);
      btnA.removeEventListener('click', onA);
      btnB.removeEventListener('click', onB);
      btnC.removeEventListener('click', onC);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };
    const onA = () => cleanup('a');
    const onB = () => cleanup('b');
    const onC = () => {
      // 未备份时点击不关闭对话框，只弹提示
      if (optionC && optionC.disabledHint) {
        showToast(optionC.disabledHint);
        return;
      }
      cleanup('c');
    };
    const onOverlayClick = (e) => { if (e.target === overlay) cleanup(null); };
    const onKeydown = (e) => { if (e.key === 'Escape') cleanup(null); };

    btnA.addEventListener('click', onA);
    btnB.addEventListener('click', onB);
    btnC.addEventListener('click', onC);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);

    overlay.hidden = false;
    overlay.offsetHeight;
    overlay.classList.add('is-visible');
  });
}

// 删除流程：磁盘上有关联文件的条目，询问"仅移除记录"还是"连文件一起删"
async function confirmDeleteFlow(ids) {
  const targets = ids
    .map((id) => state.items.find((i) => i.id === id))
    .filter(Boolean);
  if (!targets.length) return;

  const withFile = targets.filter((t) => itemDiskPath(t));
  const names = targets.length === 1 ? `「${targets[0].name}」` : `选中的 ${targets.length} 个项目`;
  const where = withFile.length
    ? `\n\n文件位置：${itemDiskPath(withFile[0])}${withFile.length > 1 ? ` 等 ${withFile.length} 个` : ''}`
    : '';

  if (!withFile.length) {
    // 没有磁盘文件（笔记 / 纯内嵌数据），删掉记录本身即可
    const confirmed = await confirmDelete({
      title: '从软件中删除？',
      message: `确定要删除${names}吗？\n删除后可以点提示条上的「撤销」找回。`,
      confirmText: '删除'
    });
    if (!confirmed) return;
    await removeItems(ids, false);
    return;
  }

  // 同时有"原文件 + 资源文件夹里的文件"（复制导入 / 老数据）时才出现第三个选项
  const withBoth = targets.filter((t) => t.sourcePath && itemDiskPath(t) !== t.sourcePath).length;

  const choice = await confirmChoice({
    title: `删除${names}？`,
    message: '这些项目在磁盘上有对应文件，请选择处理方式：' + where,
    optionA: '仅从列表移除（文件保留在资源文件夹）',
    optionB: `移除并删除文件（${withFile.length} 个，移入回收站）`,
    optionC: withBoth > 0
      ? { label: `只删除原文件，保留资源文件夹里的文件（${withBoth} 个）` }
      : null
  });
  if (!choice) return;

  if (choice === 'c') {
    await removeSourceKeepBackup(ids);
    return;
  }

  await removeItems(ids, choice === 'b');
}

// 删除源文件但保留软件内的记录与备份；仅对已备份的条目生效，未备份的跳过
async function removeSourceKeepBackup(ids) {
  let trashed = 0;
  let skipped = 0;
  let fail = 0;

  for (const id of ids) {
    const item = state.items.find((i) => i.id === id);
    if (!item || !item.sourcePath) continue;
    // 只有"资源文件夹里有文件"或"库内还有内嵌备份"时，删源文件才安全
    if (!item.backupPath && !item.dataURL) {
      skipped++;
      continue;
    }
    const res = await window.electronAPI?.trashFile?.(item.sourcePath);
    if (res && res.ok) {
      item.sourcePath = '';
      await saveItem(item);
      trashed++;
    } else {
      fail++;
    }
  }

  // 选中的条目还在的话走 selectItem（顺带重画列表），否则单独重画一次
  if (state.selectedId) await selectItem(state.selectedId);
  else renderGrid();

  const parts = [`已删除 ${trashed} 个源文件（移入回收站），软件内备份保留`];
  if (skipped) parts.push(`${skipped} 项未备份已跳过`);
  if (fail) parts.push(`${fail} 个删除失败`);
  showToast(parts.join('，'));
}

async function removeCurrentItem() {
  if (!state.selectedId) return;
  await confirmDeleteFlow([state.selectedId]);
}

// ===== 截图 / 录屏：F4 截图、F6 开关录屏（含系统声音），都存进默认分组「截图/录屏」=====
const CAPTURE_GROUP_NAME = '截图/录屏';
let mediaRecorder = null;
let recordedChunks = [];
let pickingRegion = false;       // 正在框选，此时重复按热键先忽略
let stopCropPipeline = null;     // 区域裁剪的收尾函数
// 实际生效的热键由主进程下发（换键时界面提示会自动跟上），先给个默认值兜底
let captureHotkeys = { screenshot: 'F4', record: 'F6' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function prettyHotkey(key) {
  return String(key || '')
    .replace(/CommandOrControl|Control|Cmd|Command/g, 'Ctrl')
    .replace(/\+/g, '+');
}

// 默认分组不存在就建一个（同时建好磁盘上的同名文件夹）
async function ensureCaptureGroup() {
  let group = state.groups.find((g) => g.name === CAPTURE_GROUP_NAME);
  if (!group) {
    group = { id: generateId(), name: CAPTURE_GROUP_NAME, icon: '▦', createdAt: Date.now() };
    state.groups.push(group);
    await saveGroup(group);
    await window.electronAPI?.ensureGroupFolder?.(group.name);
    renderFolders();
    renderMetaGroupOptions();
  }
  // 告诉主进程截图/录屏往哪个分组文件夹里写
  window.electronAPI?.setCaptureGroup?.(CAPTURE_GROUP_NAME);
  return group;
}

function captureFileName(kind) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return kind === 'video' ? `录屏 ${stamp}.webm` : `截图 ${stamp}.png`;
}

// 文件已经躺在分组文件夹里了，这里把它登记成 app 内的条目
async function addCaptureItem(payload) {
  const group = await ensureCaptureGroup();
  const kind = payload && payload.kind === 'video' ? 'video' : 'image';

  let thumbnail = '';
  try {
    const res = await window.electronAPI?.readFileDataUrl?.(payload.path);
    if (res && res.ok) {
      thumbnail = kind === 'video'
        ? (await getVideoThumbnail(res.dataUrl)) || ''
        : (await getImageThumbnail(res.dataUrl)) || '';
    }
  } catch (_) { /* 缩略图失败不影响入库 */ }

  const item = {
    id: payload.id || generateId(),
    name: captureFileName(kind),
    type: kind,
    mime: kind === 'video' ? 'video/webm' : 'image/png',
    size: payload.size || 0,
    dataURL: '',
    thumbnail,
    backupPath: payload.path || '',
    sourcePath: '',
    createdAt: Date.now(),
    time: formatDateTimeLocal(new Date()),
    category: '',
    description: '',
    groupId: group.id,
    duration: 0
  };

  state.items.push(item);
  await saveItem(item);
  renderFolders();
  renderGrid();
  showToast(`已存入「${CAPTURE_GROUP_NAME}」：${item.name}`, {
    duration: 6000,
    action: {
      label: '查看',
      onAction: () => {
        state.selectedGroupId = group.id;
        renderFolders();
        selectItem(item.id);
      }
    }
  });
  return item;
}

// 截图热键：先框选区域 → 按操作条的动作走：保存入库 / 复制到剪贴板 / 固定到屏幕
async function takeScreenshot() {
  await ensureCaptureGroup();

  // 框选：不框直接回车 = 整屏；Esc / 右键 = 取消
  const region = await window.electronAPI?.pickRegion?.('shot');
  if (!region) {
    showToast('已取消截图');
    return null;
  }

  // 只复制到剪贴板：不落盘、不入库
  if (region.action === 'copy') {
    const res = await window.electronAPI?.regionAction?.('copy', region);
    showToast(res && res.ok ? '已复制到剪贴板' : ('复制失败：' + ((res && res.error) || '未知错误')));
    return null;
  }

  // 固定到屏幕上（贴图）
  if (region.action === 'pin') {
    const res = await window.electronAPI?.regionAction?.('pin', region);
    showToast(
      res && res.ok
        ? '已固定到屏幕 · 拖动移动、滚轮缩放、双击关闭'
        : ('固定失败：' + ((res && res.error) || '未知错误')),
      { duration: 6000 }
    );
    return null;
  }

  const shot = await window.electronAPI?.captureScreen?.(region);
  if (!shot || !shot.ok) {
    showToast('截图失败：' + ((shot && shot.error) || '未知错误'));
    return null;
  }

  const id = generateId();
  const saved = await window.electronAPI?.saveCapture?.({ id, ext: '.png', bytes: shot.bytes });
  if (!saved || !saved.ok) {
    showToast('截图保存失败：' + ((saved && saved.error) || '未知错误'));
    return null;
  }

  return addCaptureItem({ kind: 'image', id, path: saved.path, size: saved.size });
}

// ---- 录屏：按一下开始（先框选区域），再按一下结束 ----

// 采集分辨率 ÷ 遮罩宽度：把"遮罩里的 CSS 坐标"换算成画面像素
function captureScale(track, region) {
  try {
    const s = track.getSettings ? track.getSettings() : {};
    if (s && s.width && region.screenWidth) return s.width / region.screenWidth;
  } catch (_) { /* ignore */ }
  return window.devicePixelRatio || 1;
}

// 把整屏画面裁到选区：用 MediaStreamTrackProcessor 逐帧取原图 → 画进 canvas → 手动推帧。
// 之所以不用 requestAnimationFrame / 画布自动采样（captureStream(fps)）：
// 它们在窗口被遮挡或最小化时会被降频甚至停住，而这里每一帧都由视频流本身驱动，后台也照常出帧
function cropVideoTrack(sourceTrack, region, k) {
  if (typeof MediaStreamTrackProcessor !== 'function') return null;

  const sx = Math.max(0, Math.round(region.x * k));
  const sy = Math.max(0, Math.round(region.y * k));
  const sw = Math.max(2, Math.round(region.width * k));
  const sh = Math.max(2, Math.round(region.height * k));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // fps=0 → 不自动采样，只有 requestFrame() 时才产出一帧
  const outStream = canvas.captureStream(0);
  const outTrack = outStream.getVideoTracks()[0];
  if (!outTrack || typeof outTrack.requestFrame !== 'function') return null;

  let processor;
  try {
    processor = new MediaStreamTrackProcessor({ track: sourceTrack });
  } catch (_) {
    return null;
  }

  const reader = processor.readable.getReader();
  let stopped = false;
  let frameCount = 0; // 临时诊断用

  (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done) { if (frame) frame.close(); break; }
        if (stopped) { if (frame) frame.close(); break; }
        try {
          const vw = frame.codedWidth || frame.displayWidth || sw;
          const vh = frame.codedHeight || frame.displayHeight || sh;
          const cx = Math.max(0, Math.min(sx, Math.max(0, vw - 2)));
          const cy = Math.max(0, Math.min(sy, Math.max(0, vh - 2)));
          const cw = Math.max(2, Math.min(sw, vw - cx));
          const ch = Math.max(2, Math.min(sh, vh - cy));
          ctx.drawImage(frame, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
          outTrack.requestFrame();
          frameCount++;
          window.__cropFrames = frameCount; // 临时诊断
        } finally {
          frame.close();
        }
      }
    } catch (err) {
      if (!stopped) console.warn('[capture] 区域裁剪中断：' + ((err && err.message) || err));
    }
  })();

  return {
    track: outTrack,
    stop() {
      stopped = true;
      try { reader.cancel(); } catch (_) { /* ignore */ }
      try { outTrack.stop(); } catch (_) { /* ignore */ }
    }
  };
}

// 打开"屏幕 + 系统声音"的采集流。
// 首选 Electron 传统桌面采集（getUserMedia + chromeMediaSource:'desktop'）：
// 实测 getDisplayMedia 在当前环境几乎不出帧（3 秒 0~2 帧，运动画面等于幻灯片），
// 传统方式同样条件能到 23fps；它的 audio 用 chromeMediaSource:'desktop' 就是系统声音回环
async function openCaptureStream() {
  const src = await window.electronAPI?.getCaptureSource?.();
  if (src && src.ok && src.id) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'desktop' } },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: src.id,
            maxFrameRate: 30,
            minFrameRate: 30
          }
        }
      });
    } catch (_) { /* 传统方式不可用就落到下面的方案 */ }
  }
  // 兜底：getDisplayMedia（声音由主进程的 display-media 处理器以回环方式补上）
  return navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30, max: 30 } },
    audio: true
  });
}

function stopRecording() {
  if (!mediaRecorder) return;
  try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
  mediaRecorder = null;
  window.electronAPI?.setRecordingState?.(false); // 指示灯立刻收起，别让计时继续跑
  showToast('正在保存录屏…', { duration: 4000 });
}

async function toggleRecording() {
  if (mediaRecorder) {
    stopRecording();
    return;
  }
  if (pickingRegion) return; // 正在框选，重复按热键先忽略
  if (!navigator.mediaDevices?.getDisplayMedia) {
    showToast('当前环境不支持录屏');
    return;
  }

  // 先让用户框选区域（回车不选 = 整屏）
  pickingRegion = true;
  let region = null;
  try {
    region = await window.electronAPI?.pickRegion?.('record');
  } finally {
    pickingRegion = false;
  }
  if (!region) {
    showToast('已取消录屏');
    return;
  }

  let stream = null;
  try {
    // 遮罩刚关掉，等它从屏幕上消失，免得第一帧录进遮罩
    await sleep(260);

    // 屏幕画面 + 系统声音（不录麦克风）
    stream = await openCaptureStream();
    const hasAudio = stream.getAudioTracks().length > 0;
    const sourceTrack = stream.getVideoTracks()[0];

    // 按选区裁剪（整屏则不用裁）
    let videoTrack = sourceTrack;
    let cropNote = '';
    stopCropPipeline = null;
    if (!region.full) {
      const cropped = cropVideoTrack(sourceTrack, region, captureScale(sourceTrack, region));
      if (cropped) {
        videoTrack = cropped.track;
        stopCropPipeline = cropped.stop;
      } else {
        cropNote = '（当前环境不支持区域录制，本次录了整屏）';
      }
    }

    // 带音频时必须把音频编码器一起写进 mimeType，否则可能只录到画面
    const candidates = hasAudio
      ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = candidates.find((t) => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    const mixed = new MediaStream(hasAudio ? [videoTrack, ...stream.getAudioTracks()] : [videoTrack]);

    recordedChunks = [];
    const recorder = new MediaRecorder(mixed, { mimeType: mime });

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) recordedChunks.push(e.data);
    };
    recorder.onstop = async () => {
      window.electronAPI?.setRecordingState?.(false);
      if (stopCropPipeline) { try { stopCropPipeline(); } catch (_) { /* ignore */ } stopCropPipeline = null; }
      stream.getTracks().forEach((t) => t.stop());
      const chunks = recordedChunks;
      recordedChunks = [];
      if (!chunks.length) { showToast('录屏内容为空'); return; }

      const id = generateId();
      // webm 没有时长头，把实际录了多久一起交给主进程写进去（否则播放器显示 ∞）
      const durationMs = Math.max(1, Date.now() - startedAt);
      const buffer = await new Blob(chunks, { type: 'video/webm' }).arrayBuffer();
      const res = await window.electronAPI?.saveCapture?.({
        id,
        ext: '.webm',
        bytes: new Uint8Array(buffer),
        durationMs
      });
      if (!res || !res.ok) {
        showToast('录屏保存失败：' + ((res && res.error) || '未知错误'));
        return;
      }
      await addCaptureItem({ kind: 'video', id, path: res.path, size: res.size });
    };

    mediaRecorder = recorder;
    const startedAt = Date.now();
    recorder.start(1000);

    // 指示灯（常驻置顶：正在录屏 + 计时 + 停止按钮）+ 录制范围标线（把框的那块用红框标出来）
    window.electronAPI?.setRecordingState?.(true, region);
    showToast(
      `已开始${region.full ? '录屏' : '区域录屏'}${hasAudio ? '（含系统声音）' : ''}`
      + ` · 再按 ${captureHotkeys.record} 结束${cropNote}`,
      { duration: 6000 }
    );
  } catch (err) {
    mediaRecorder = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (stopCropPipeline) { try { stopCropPipeline(); } catch (_) { /* ignore */ } stopCropPipeline = null; }
    window.electronAPI?.setRecordingState?.(false);
    showToast('录屏启动失败：' + ((err && err.message) || err));
  }
}

// ===== 设置：截屏 / 录屏的全局快捷键 =====
const SETTINGS_HOTKEY_FIELDS = {
  screenshot: '#settingsShotKey',
  record: '#settingsRecordKey'
};

let hotkeyCaptureTarget = ''; // 正在等用户按下的那一项

// 把 KeyboardEvent 翻译成 Electron 的 accelerator 写法
function acceleratorFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.shiftKey) mods.push('Shift');
  if (e.altKey) mods.push('Alt');
  if (e.metaKey) mods.push('Super');

  const key = e.key;
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(key)) return ''; // 只按了修饰键，继续等
  if (key === 'Escape') return 'ESCAPE_CANCEL';

  let name = '';
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) name = key;             // F1 ~ F24
  else if (key === ' ') name = 'Space';
  else if (key === 'Enter') name = 'Return';
  else if (key === 'Tab') name = 'Tab';
  else if (key === 'Backspace' || key === 'Delete') return '';    // 太容易误触，不给用
  else if (key.length === 1) name = key.toUpperCase();            // 字母 / 数字
  else if (key.startsWith('Arrow')) name = key.slice(5);          // Up / Down / Left / Right
  else if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'PrintScreen'].includes(key)) name = key;
  else return '';

  return mods.concat([name]).join('+');
}

function renderHotkeySettings(state) {
  const configured = (state && state.configured) || {};
  const active = (state && state.active) || {};
  for (const which of Object.keys(SETTINGS_HOTKEY_FIELDS)) {
    const el = $(SETTINGS_HOTKEY_FIELDS[which]);
    if (!el) continue;
    const want = configured[which] || '';
    const real = active[which] || '';
    el.textContent = want || '未设置';
    // 被别的程序占用而降级过时，把"实际生效"的键也标出来
    const downgraded = Boolean(real && want && real !== want);
    el.classList.toggle('is-downgraded', downgraded);
    el.title = downgraded
      ? prettyHotkey(want) + ' 被其他程序占用，当前实际用的是 ' + prettyHotkey(real)
      : '点击后按下新的快捷键';
  }
}

function setSettingsNote(text, isError) {
  const note = $('#settingsNote');
  if (!note) return;
  note.textContent = text || '';
  note.classList.toggle('is-error', Boolean(isError));
}

function stopHotkeyCapture() {
  hotkeyCaptureTarget = '';
  $$('.settings-key').forEach((el) => el.classList.remove('is-recording'));
}

async function openSettings() {
  const overlay = $('#settingsOverlay');
  if (!overlay) return;
  overlay.hidden = false;
  setSettingsNote('');
  stopHotkeyCapture();

  // 面板打开期间先停掉全局热键，否则"按下想设置的键"会真的去截图/录屏
  await window.electronAPI?.pauseCaptureHotkeys?.(true);
  renderHotkeySettings(await window.electronAPI?.getCaptureHotkeySettings?.());
  await refreshDataDir();
}

async function closeSettings() {
  const overlay = $('#settingsOverlay');
  if (!overlay) return;
  overlay.hidden = true;
  stopHotkeyCapture();
  const res = await window.electronAPI?.pauseCaptureHotkeys?.(false);
  if (res && res.active) {
    if (res.active.screenshot) captureHotkeys.screenshot = prettyHotkey(res.active.screenshot);
    if (res.active.record) captureHotkeys.record = prettyHotkey(res.active.record);
  }
}

async function applyHotkey(which, accelerator) {
  setSettingsNote('正在应用…');
  const res = await window.electronAPI?.setCaptureHotkeys?.({ [which]: accelerator });
  if (!res) { setSettingsNote('设置失败：主进程没有响应', true); return; }
  renderHotkeySettings(res);
  if (res.failed && res.failed.length) {
    setSettingsNote(res.failed.join('；') + '，已保留原来的键', true);
    return;
  }
  const real = (res.active && res.active[which]) || accelerator;
  setSettingsNote('已改为 ' + prettyHotkey(real) + '，立即生效');
}

// ===== 设置：数据目录（默认 %APPDATA%\media-archive，可改到别的盘）=====

function setDataDirNote(text, isError) {
  const el = $('#dataDirNote');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('is-error', Boolean(isError));
}

async function refreshDataDir() {
  const el = $('#dataDirPath');
  if (!el) return;

  const info = await window.electronAPI?.getDataDir?.();
  if (!info || !info.ok) {
    el.textContent = '(读取数据目录失败)';
    setDataDirNote('');
    return;
  }

  el.textContent = info.dir;
  el.title = '点击可复制：' + info.dir;
  el.classList.toggle('is-pending', Boolean(info.pending));

  const changeBtn = $('#dataDirChangeBtn');
  const resetBtn = $('#dataDirResetBtn');
  const openBtn = $('#dataDirOpenBtn');

  // 环境变量优先级最高：这时界面里怎么改都不生效，直接说明白，别让人白点
  if (info.envOverride) {
    if (changeBtn) changeBtn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    if (openBtn) openBtn.disabled = false;
    setDataDirNote('当前由环境变量 SNAPBOX_DATA 指定（' + info.envOverride + '），这里的更改不会生效');
    return;
  }

  if (changeBtn) changeBtn.disabled = false;
  if (openBtn) openBtn.disabled = false;
  if (resetBtn) resetBtn.disabled = info.dir === info.defaultDir;

  if (info.pending) {
    setDataDirNote('已改为上面这个位置，重启后生效（当前还在用 ' + info.currentDir + '）');
  } else if (info.warning) {
    setDataDirNote(info.warning, true);
  } else {
    setDataDirNote('');
  }
}

async function handleDataDirResult(res) {
  if (!res || res.canceled) return;
  if (!res.ok) { setDataDirNote(res.error || '更改失败', true); return; }
  await refreshDataDir();
}

async function changeDataDir() {
  setDataDirNote('请在打开的窗口里选择目录…');
  await handleDataDirResult(await window.electronAPI?.chooseDataDir?.());
}

async function resetDataDir() {
  setDataDirNote('正在恢复默认位置…');
  await handleDataDirResult(await window.electronAPI?.resetDataDir?.());
}

async function openDataDir() {
  const res = await window.electronAPI?.openDataDir?.();
  if (res && !res.ok) setDataDirNote('打开失败：' + (res.error || '未知原因'), true);
}

function initSettings() {
  $('#settingsBtn')?.addEventListener('click', () => { openSettings(); });
  $('#settingsCloseBtn')?.addEventListener('click', () => { closeSettings(); });
  // 点面板外的灰底也能关掉
  $('#settingsOverlay')?.addEventListener('mousedown', (e) => {
    if (e.target && e.target.id === 'settingsOverlay') closeSettings();
  });

  // ===== 数据目录 =====
  $('#dataDirOpenBtn')?.addEventListener('click', () => { openDataDir(); });
  $('#dataDirChangeBtn')?.addEventListener('click', () => { changeDataDir(); });
  $('#dataDirResetBtn')?.addEventListener('click', () => { resetDataDir(); });

  // 路径点一下就复制，方便贴到别处或做备份说明
  $('#dataDirPath')?.addEventListener('click', async () => {
    const text = ($('#dataDirPath')?.textContent || '').trim();
    if (!text || text === '—') return;
    const res = await window.electronAPI?.copyText?.(text);
    setDataDirNote(res && res.ok ? '路径已复制' : '复制失败，可以手动选中路径复制', !(res && res.ok));
  });

  // 启动时如果数据目录有问题（比如设的那个盘不在了），立刻提醒 —— 别让人以为库丢了
  (async () => {
    const info = await window.electronAPI?.getDataDir?.();
    if (info && info.ok && info.warning) {
      showToast(info.warning, {
        duration: 15000,
        action: { label: '去设置', onAction: () => { openSettings(); } }
      });
    }
  })();

  $$('.settings-key').forEach((el) => {
    el.addEventListener('click', () => {
      hotkeyCaptureTarget = el.dataset.which;
      $$('.settings-key').forEach((b) => b.classList.toggle('is-recording', b === el));
      setSettingsNote('请按下新的快捷键…（按 Esc 取消）');
    });
  });

  $('#settingsResetBtn')?.addEventListener('click', async () => {
    setSettingsNote('正在恢复默认…');
    const res = await window.electronAPI?.setCaptureHotkeys?.({ screenshot: 'F4', record: 'F6' });
    if (!res) { setSettingsNote('恢复失败：主进程没有响应', true); return; }
    renderHotkeySettings(res);
    if (res.failed && res.failed.length) { setSettingsNote(res.failed.join('；'), true); return; }
    setSettingsNote('已恢复默认：截屏 F4 / 录屏 F6');
  });

  // 录制按键：用捕获阶段，避免被别处的快捷键处理挡掉
  document.addEventListener('keydown', (e) => {
    const overlay = $('#settingsOverlay');
    if (!overlay || overlay.hidden) return;

    // 没在录制按键时，Esc 关面板
    if (!hotkeyCaptureTarget) {
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    const acc = acceleratorFromEvent(e);
    if (acc === 'ESCAPE_CANCEL') { stopHotkeyCapture(); setSettingsNote('已取消'); return; }
    if (!acc) return; // 只按了修饰键，继续等

    const which = hotkeyCaptureTarget;
    stopHotkeyCapture();
    applyHotkey(which, acc);
  }, true);
}

function initCapture() {
  // 默认分组先备好（顺便把分组名告诉主进程）
  ensureCaptureGroup().catch(() => {});

  // 主进程下发的实际生效热键（降级过就用降级后的键）
  window.electronAPI?.onCaptureHotkeys?.((keys) => {
    if (!keys) return;
    if (keys.screenshot) captureHotkeys.screenshot = prettyHotkey(keys.screenshot);
    if (keys.record) captureHotkeys.record = prettyHotkey(keys.record);
  });

  // 截图 / 开关录屏
  window.electronAPI?.onTakeScreenshot?.(() => { takeScreenshot().catch(() => {}); });
  window.electronAPI?.onToggleRecording?.(() => { toggleRecording(); });

  // 贴图窗口点了「保存」：主进程已经写好文件，这里把它登记成条目
  window.electronAPI?.onRegisterCapture?.((payload) => {
    if (payload) addCaptureItem(payload).catch(() => {});
  });

  // 快捷键被别的程序占用时给个明确提示（不然按了没反应会莫名其妙）
  window.electronAPI?.onCaptureHotkeyNotice?.((payload) => {
    if (payload && payload.message) showToast(payload.message, { duration: 10000 });
  });
}

// ===== 视频大播放器：预览里的全屏先把画面放大到接近窗口尺寸，再由它去真全屏 =====
let theater = null;

// 拦截 <video> 的全屏请求：预览里的视频改为打开大播放器；
// 大播放器里的视频没有 __theater，照常走原生逻辑（真正全屏）
function installVideoFullscreenIntercept() {
  const proto = window.HTMLVideoElement && HTMLVideoElement.prototype;
  if (!proto || proto.__memorieFsPatched) return;
  proto.__memorieFsPatched = true;

  for (const name of ['webkitEnterFullscreen', 'requestFullscreen', 'webkitRequestFullscreen']) {
    const original = proto[name];
    proto[name] = function (...args) {
      if (typeof this.__theater === 'function') {
        this.__theater();
        return Promise.resolve();
      }
      return typeof original === 'function' ? original.apply(this, args) : Promise.resolve();
    };
  }

  // 兜底：万一原生控件绕过了上面两个 API 直接进了全屏，立刻退出并改为打开大播放器
  document.addEventListener('fullscreenchange', () => {
    const el = document.fullscreenElement || document.webkitFullscreenElement;
    if (!el || el.tagName !== 'VIDEO' || el.classList.contains('theater-video')) return;
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    const item = state.items.find((i) => i.id === (el.dataset ? el.dataset.videoFor : ''));
    if (item) openTheater(item, el);
  });
}

// 大播放器的尺寸记忆 + 边框拖拽伸缩
const THEATER_SIZE_KEY = 'memorie.theaterSize';
const THEATER_MIN_W = 420;
const THEATER_MIN_H = 280;

function applyTheaterSize() {
  const page = $('.theater-page');
  if (!page) return;
  page.classList.remove('is-floating');
  page.style.left = '';
  page.style.top = '';

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(THEATER_SIZE_KEY) || 'null');
  } catch (_) { /* 数据坏了就用默认尺寸 */ }

  if (saved && saved.w && saved.h) {
    // 窗口比记录的小时按窗口收一下
    page.style.width = Math.min(saved.w, window.innerWidth - 24) + 'px';
    page.style.height = Math.min(saved.h, window.innerHeight - 24) + 'px';
  } else {
    page.style.width = '';
    page.style.height = '';
  }
}

function initTheaterResize() {
  const page = $('.theater-page');
  const overlay = $('#theaterOverlay');
  if (!page || !overlay || page.__resizeReady) return;
  page.__resizeReady = true;

  for (const dir of ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('div');
    handle.className = 'theater-page__resize';
    handle.dataset.dir = dir;
    page.appendChild(handle);
  }

  let drag = null;

  page.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.theater-page__resize');
    if (!handle) return;
    e.preventDefault();

    // 先切到绝对定位再量尺寸，避免入场缩放动画影响基准值
    page.classList.add('is-floating');
    const rect = page.getBoundingClientRect();
    page.style.width = rect.width + 'px';
    page.style.height = rect.height + 'px';
    page.style.left = rect.left + 'px';
    page.style.top = rect.top + 'px';

    drag = { dir: handle.dataset.dir, startX: e.clientX, startY: e.clientY, rect };
    overlay.classList.add('is-resizing');
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_) { /* 合成事件没有真实 pointerId */ }
  });

  page.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.preventDefault();

    const dir = drag.dir;
    const { rect } = drag;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    const maxW = window.innerWidth - 8;
    const maxH = window.innerHeight - 8;

    let left = rect.left;
    let top = rect.top;
    let width = rect.width;
    let height = rect.height;

    if (dir.includes('e')) width = Math.min(maxW, Math.max(THEATER_MIN_W, rect.width + dx));
    if (dir.includes('s')) height = Math.min(maxH, Math.max(THEATER_MIN_H, rect.height + dy));
    if (dir.includes('w')) {
      width = Math.min(maxW, Math.max(THEATER_MIN_W, rect.width - dx));
      left = rect.left + (rect.width - width);
    }
    if (dir.includes('n')) {
      height = Math.min(maxH, Math.max(THEATER_MIN_H, rect.height - dy));
      top = rect.top + (rect.height - height);
    }

    // 别拖出窗口
    left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - height - 4));

    page.style.width = Math.round(width) + 'px';
    page.style.height = Math.round(height) + 'px';
    page.style.left = Math.round(left) + 'px';
    page.style.top = Math.round(top) + 'px';
  });

  const endDrag = () => {
    if (!drag) return;
    drag = null;
    overlay.classList.remove('is-resizing');
    try {
      localStorage.setItem(THEATER_SIZE_KEY, JSON.stringify({
        w: Math.round(parseFloat(page.style.width)),
        h: Math.round(parseFloat(page.style.height))
      }));
    } catch (_) { /* 存不下就算了 */ }
  };

  page.addEventListener('pointerup', endDrag);
  page.addEventListener('pointercancel', endDrag);
}

async function openTheater(item, fromVideo) {
  const overlay = $('#theaterOverlay');
  if (!overlay || !item) return;
  if (theater) closeTheater();

  const preview = await resolvePreviewUrl(item);
  if (!preview.ok) {
    showToast('打不开：文件不存在或无法读取');
    return;
  }

  const time = fromVideo && Number.isFinite(fromVideo.currentTime) ? fromVideo.currentTime : 0;
  const wasPlaying = fromVideo ? !fromVideo.paused : false;
  if (fromVideo) fromVideo.pause();

  applyTheaterSize();
  $('#theaterTitle').textContent = item.name || '视频';
  const stage = $('#theaterStage');
  stage.innerHTML = '';

  const video = document.createElement('video');
  video.className = 'theater-video';
  video.src = preview.url;
  video.controls = true;
  video.autoplay = true;
  video.playsInline = true;
  // 音量/静音沿用预览里的状态，避免突然出声
  if (fromVideo) {
    video.muted = fromVideo.muted;
    video.volume = fromVideo.volume;
  }
  if (time) video.addEventListener('loadedmetadata', () => { video.currentTime = time; });
  stage.appendChild(video);

  theater = { video, fromVideo, wasPlaying };

  overlay.hidden = false;
  requestAnimationFrame(() => overlay.classList.add('is-visible'));
  video.play().catch(() => {});
  $('#theaterCloseBtn').focus();
}

function closeTheater() {
  const overlay = $('#theaterOverlay');
  if (!overlay || !theater) return;

  const { video, fromVideo, wasPlaying } = theater;
  const time = video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  theater = null;

  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  $('#theaterStage').innerHTML = '';

  overlay.classList.remove('is-visible');
  setTimeout(() => { overlay.hidden = true; }, 220);

  // 把播放进度还回右侧预览里的那个视频，衔接得上
  if (fromVideo && fromVideo.isConnected) {
    try {
      fromVideo.currentTime = time;
    } catch (_) { /* 元数据还没加载好就算了 */ }
    if (wasPlaying) fromVideo.play().catch(() => {});
  }
}

// ===== 压缩备份：把一个分组打包成 library/zip/<分组名>.zip =====

// 笔记本身不是磁盘文件，导出成可独立打开的 HTML 写进压缩包
function noteToExportHtml(item) {
  const title = item.name || '未命名笔记';
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>',
    'body{margin:0 auto;padding:32px;max-width:820px;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.75;color:#1d1d1f;background:#fff;}',
    'h1{font-size:24px;}h2{font-size:19px;}img{max-width:100%;height:auto;border-radius:8px;}',
    'blockquote{margin:12px 0;padding:6px 14px;border-left:3px solid #d2d2d7;color:#6e6e73;}',
    'pre,code{background:#f5f5f7;border-radius:6px;padding:2px 6px;font-family:ui-monospace,Consolas,monospace;}',
    '</style>',
    '</head>',
    '<body>',
    noteToHtml(item.description || ''),
    '</body>',
    '</html>'
  ].join('\n');
}

// 打包一批条目（分组 / 全部 / 选中项都能用）
async function archiveItemsToZip(label, items) {
  if (!window.electronAPI?.archiveItems) {
    showToast('当前环境不支持打包');
    return null;
  }
  if (!items.length) {
    showToast(`「${label}」还没有可打包的内容`);
    return null;
  }

  const payloadItems = items.map((item) => (item.type === 'note'
    ? { kind: 'note', id: item.id, title: item.name || '未命名笔记', html: noteToExportHtml(item) }
    : { kind: 'file', id: item.id, name: item.name, path: itemDiskPath(item) }));

  // 大文件打包耗时较久，先给"进行中"提示，并订阅进度
  const noteCount = items.filter((i) => i.type === 'note').length;
  const noteHint = noteCount ? `，含 ${noteCount} 篇笔记` : '';
  let packed = false;
  showToast(`正在打包「${label}」…共 ${items.length} 项${noteHint}`, { duration: 120000 });
  window.electronAPI?.onArchiveProgress?.((p) => {
    if (packed) return; // 迟到的进度事件别把"已完成"提示覆盖掉
    if (p && p.total) showToast(`正在打包「${label}」… ${p.entries}/${p.total}`, { duration: 120000 });
  });

  const res = await window.electronAPI.archiveItems({ label, items: payloadItems });
  packed = true;
  window.electronAPI?.onArchiveProgress?.(() => {});

  if (!res || !res.ok) {
    showToast('打包失败：' + ((res && res.error) || '未知错误'));
    return null;
  }

  const parts = [`已备份「${label}」：${res.added} 个文件（${formatFileSize(res.size)}）`];
  if (res.missing && res.missing.length) parts.push(`${res.missing.length} 个文件在磁盘上找不到，已跳过`);
  showToast(parts.join('，'), {
    duration: 8000,
    action: { label: '查看压缩包', onAction: () => window.electronAPI?.showInExplorer?.(res.path) }
  });
  return res;
}

// 取某个分组的全部条目
function itemsInGroup(groupId) {
  if (groupId === 'all') return state.items.slice();
  if (groupId === 'ungrouped') return state.items.filter((i) => !i.groupId);
  return state.items.filter((i) => i.groupId === groupId);
}

async function archiveGroup(groupId) {
  const group = state.groups.find((g) => g.id === groupId);
  const label = groupId === 'all' ? '全部' : (groupId === 'ungrouped' ? getUngroupedName() : (group ? group.name : '分组'));
  await archiveItemsToZip(label, itemsInGroup(groupId));
}

// 打包当前勾选的条目
async function archiveSelection() {
  const items = state.items.filter((i) => state.selection.has(i.id));
  await archiveItemsToZip('选中项', items);
}

// ===== 右键菜单 =====

let contextMenuTargetIds = [];
let contextMenuContext = null; // { type: 'items', ids } | { type: 'group', id } | { type: 'app' }
let contextMenuAnchor = { x: 0, y: 0 };   // 菜单锚点（二级菜单沿用同一个位置）
let contextMenuStack = [];                 // 二级菜单的返回栈

function closeContextMenu() {
  const menu = $('#contextMenu');
  menu.hidden = true;
  contextMenuTargetIds = [];
  contextMenuContext = null;
  contextMenuStack = [];
}

async function handleContextAction(action) {
  const ids = [...contextMenuTargetIds];
  closeContextMenu();
  if (!ids.length) return;

  const item = state.items.find((i) => i.id === ids[0]);

  if (action === 'exportPdf') {
    await exportNoteAsPdf(item);
    return;
  }

  if (action === 'copy') {
    if (!item) return;
    if (item.type === 'note') {
      try {
        await navigator.clipboard.writeText(item.description || '');
        showToast('笔记内容已复制到剪贴板');
      } catch (_) {
        showToast('复制失败');
      }
      return;
    }
    const preview = await resolvePreviewUrl(item);
    if (!preview.ok) {
      showToast('复制失败：原文件不存在或无法读取');
      return;
    }
    const res = await window.electronAPI?.copyImage?.(preview.url);
    showToast(res && res.ok ? '图片已复制到剪贴板' : '复制失败');
    return;
  }

  if (action === 'revealBackupPath') {
    const diskPath = itemDiskPath(item);
    if (!diskPath) { showToast('这个条目没有记录文件路径'); return; }
    const res = await window.electronAPI?.showInExplorer?.(diskPath);
    if (res && !res.ok) showToast(res.error || '找不到这个文件');
    return;
  }

  if (action === 'openLibraryFolder') {
    window.electronAPI?.openLibraryFolder?.(item ? itemGroupFolder(item) : '');
    return;
  }

  if (action === 'revealBackup') {
    if (!item?.dataURL) return;
    const res = await window.electronAPI?.ensureBackup?.(item.id, item.dataURL);
    if (res && res.ok) {
      window.electronAPI?.showInExplorer?.(res.path);
    } else {
      showToast('导出备份文件失败');
    }
    return;
  }

  if (action === 'revealSource') {
    if (!item?.sourcePath) { showToast('这个条目没有记录原路径'); return; }
    const res = await window.electronAPI?.showInExplorer?.(item.sourcePath);
    if (res && !res.ok) showToast(res.error || '原文件不在这里了');
    return;
  }

  if (action === 'delete') {
    await confirmDeleteFlow(ids);
  }
}

// 把菜单放到锚点处（防止溢出屏幕），并聚焦第一个可用项
function placeContextMenu() {
  const menu = $('#contextMenu');
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const x = Math.min(contextMenuAnchor.x, window.innerWidth - rect.width - 8);
  const y = Math.min(contextMenuAnchor.y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(4, x)}px`;
  menu.style.top = `${Math.max(4, y)}px`;

  const first = menu.querySelector('button:not([disabled])');
  if (first) first.focus();
}

function contextMenuRowsToHtml(rows) {
  return rows.map((row) => {
    if (row.separator) return '<div class="context-menu__separator"></div>';
    const tip = row.tip ? ` title="${escapeHtml(row.tip)}"` : '';
    const cls = row.danger ? ' class="danger"' : '';
    return `<button type="button" data-action="${row.action}"${row.disabled ? ' disabled' : ''}${cls}${tip}>${row.label}</button>`;
  }).join('');
}

// 统一渲染菜单：定位到鼠标处，并聚焦第一个可用项（支持键盘操作）
function renderContextMenu(e, rows, context) {
  contextMenuContext = context;
  contextMenuAnchor = { x: e.clientX, y: e.clientY };
  contextMenuStack = [];

  $('#contextMenu').innerHTML = contextMenuRowsToHtml(rows);
  placeContextMenu();
}

// 进入二级菜单：把当前菜单压栈，换成新的（新菜单请自带「‹ 返回」）
function pushContextMenu(rows) {
  const menu = $('#contextMenu');
  contextMenuStack.push(menu.innerHTML);
  menu.innerHTML = contextMenuRowsToHtml(rows);
  placeContextMenu();
}

// 返回上一级菜单
function popContextMenu() {
  if (!contextMenuStack.length) return;
  const menu = $('#contextMenu');
  menu.innerHTML = contextMenuStack.pop();
  placeContextMenu();
}

// 菜单键盘导航：↑↓ 移动、Home/End 首尾、← 返回上级、Esc 关闭
function onContextMenuKeydown(e) {
  const menu = $('#contextMenu');
  if (menu.hidden) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    closeContextMenu();
    return;
  }
  if ((e.key === 'ArrowLeft' || e.key === 'Backspace') && contextMenuStack.length) {
    e.preventDefault();
    popContextMenu();
    return;
  }

  const btns = [...menu.querySelectorAll('button:not([disabled])')];
  if (!btns.length) return;

  const cur = btns.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    btns[cur < 0 ? 0 : (cur + 1) % btns.length].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    btns[cur < 0 ? btns.length - 1 : (cur - 1 + btns.length) % btns.length].focus();
  } else if (e.key === 'Home') {
    e.preventDefault();
    btns[0].focus();
  } else if (e.key === 'End') {
    e.preventDefault();
    btns[btns.length - 1].focus();
  }
}

// ===== 分组菜单（右键分组 / 行尾 ⋯ 按钮共用）=====
async function handleGroupContextAction(action) {
  const ctx = contextMenuContext;
  closeContextMenu();
  if (!ctx) return;
  const groupId = ctx.id;

  if (action === 'openInExplorer') {
    const res = await window.electronAPI?.openLibraryFolder?.(groupFolderName(groupId));
    if (res && !res.ok) showToast('打开失败：' + (res.error || '未知错误'));
    return;
  }
  if (action === 'renameGroup') {
    startRenameGroup(groupId);
    return;
  }
  if (action === 'deleteGroup') {
    await removeGroup(groupId);
    return;
  }
  if (action === 'setMusicGroup') {
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;
    if (group.isMusic) {
      showToast('已经是音乐分组了，不能取消');
      return;
    }
    const blocker = musicGroupBlocker(groupId);
    if (blocker) {
      showToast(blocker);
      return;
    }
    group.isMusic = true;
    await saveGroup(group);
    renderFolders();
    renderGrid();
    renderMetaGroupOptions();
    showToast(`「${group.name}」已设为音乐分组，中栏改用播放器列表`);
    return;
  }
  if (action === 'archiveGroup') {
    await archiveGroup(groupId);
    return;
  }
  if (action === 'openZipFolder') {
    window.electronAPI?.openZipFolder?.();
  }
}

function openGroupContextMenu(e, groupId) {
  const count = itemsInGroup(groupId).length;
  const rows = [
    {
      label: count ? `压缩备份该分组（${count} 项）` : '压缩备份该分组',
      action: 'archiveGroup',
      disabled: count === 0,
      tip: count ? '打包成一个 zip，存到 library/zip/' : '该分组还没有内容'
    },
    { separator: true },
    { label: '在资源管理器中打开', action: 'openInExplorer' }
  ];

  if (groupId !== 'all') {
    rows.push({ separator: true });
    rows.push({ label: '重命名分组', action: 'renameGroup' });
  }
  if (groupId !== 'all' && groupId !== 'ungrouped') {
    const group = state.groups.find((g) => g.id === groupId) || {};
    if (group.isMusic) {
      // 单向：已经设过的不能取消
      rows.push({
        label: '✓ 已是音乐分组（不可取消）',
        action: 'none',
        disabled: true,
        tip: '音乐分组只能开启，不能关闭'
      });
    } else {
      const blocker = musicGroupBlocker(groupId);
      rows.push({
        label: '设为音乐分组',
        action: 'setMusicGroup',
        disabled: Boolean(blocker),
        tip: blocker || '音乐分组的中栏会用播放器列表显示'
      });
    }
    rows.push({ label: '删除分组', action: 'deleteGroup', danger: true });
  }
  rows.push({ separator: true });
  rows.push({ label: '打开压缩包文件夹', action: 'openZipFolder' });

  contextMenuTargetIds = [];
  renderContextMenu(e, rows, { type: 'group', id: groupId });
}

// ===== 「批量操作」二级菜单：点了之后让用户自己挑要做什么 =====
function batchLinkedCount() {
  return state.items.filter((i) => state.selection.has(i.id) && isItemLinked(i)).length;
}

function openBatchContextMenu() {
  const list = currentListItems();
  const count = state.selection.size;
  const linked = batchLinkedCount();

  pushContextMenu([
    {
      label: `全选当前列表（${list.length} 项）`,
      action: 'batchSelectAll',
      disabled: !list.length,
      tip: list.length ? '' : '当前列表没有项目'
    },
    {
      label: count ? `取消选择（${count} 项）` : '取消选择',
      action: 'batchClear',
      disabled: !count
    },
    { separator: true },
    {
      label: '移到分组…',
      action: 'batchMove',
      disabled: !count,
      tip: count ? '' : '先勾选要移动的项目'
    },
    {
      label: linked ? `导入到库（${linked} 项）` : '导入到库',
      action: 'batchImport',
      disabled: !linked,
      tip: linked ? '' : '所选项目都已在库内'
    },
    {
      label: count ? `压缩备份选中项（${count} 项）` : '压缩备份选中项',
      action: 'batchArchive',
      disabled: !count,
      tip: count ? '打包成一个 zip，存到 library/zip/' : '先勾选要备份的项目'
    },
    { separator: true },
    {
      label: count ? `删除选中的 ${count} 项` : '删除选中项',
      action: 'batchDelete',
      danger: true,
      disabled: !count,
      tip: count ? '' : '先勾选要删除的项目'
    },
    { separator: true },
    { label: '‹ 返回', action: '__back' }
  ]);
}

function openBatchMoveMenu() {
  const rows = [{ label: getUngroupedName(), action: 'batchMoveTo:ungrouped' }];
  for (const group of state.groups) {
    rows.push({ label: group.name, action: 'batchMoveTo:' + group.id });
  }
  rows.push({ separator: true });
  rows.push({ label: '‹ 返回', action: '__back' });
  pushContextMenu(rows);
}

// ===== 工具栏「⋯」菜单：批量操作入口 + 导入方式等设置 =====
async function handleAppContextAction(action) {
  // 返回上一级（不能先关菜单）
  if (action === '__back') {
    popContextMenu();
    return;
  }
  // 二级菜单里的动作也不需要关闭菜单（pushContextMenu 自己会换）
  if (action === 'batch') {
    openBatchContextMenu();
    return;
  }
  if (action === 'batchMove') {
    openBatchMoveMenu();
    return;
  }
  if (action.startsWith('batchMoveTo:')) {
    const gid = action.slice('batchMoveTo:'.length);
    const ids = [...state.selection];
    closeContextMenu();
    if (ids.length) await moveItemsToGroup(ids, gid);
    return;
  }

  const ids = [...state.selection];
  closeContextMenu();

  if (action === 'batchSelectAll') {
    selectAllInList();
    return;
  }
  if (action === 'batchClear') {
    clearSelection();
    return;
  }
  if (action === 'batchImport') {
    await importSelected();
    return;
  }
  if (action === 'batchArchive') {
    await archiveSelection();
    return;
  }
  if (action === 'batchDelete') {
    if (ids.length) await confirmDeleteFlow(ids);
    else showToast('请先勾选要删除的项目');
    return;
  }

  if (action === 'importMove') {
    setImportMode('move');
    showToast('导入方式已设为：移动原文件到资源文件夹');
    return;
  }
  if (action === 'importCopy') {
    setImportMode('copy');
    showToast('导入方式已设为：复制（原文件保留在原处）');
    return;
  }
  if (action === 'openLibraryRoot') {
    window.electronAPI?.openLibraryFolder?.('');
    return;
  }
  if (action === 'openZipFolder') {
    window.electronAPI?.openZipFolder?.();
    return;
  }
  if (action === 'organize') {
    await organizeLibrary();
  }
}

// ===== 列表空白处右键：粘贴 / 导入文件 / 新建笔记 / 全选 =====
async function openListBlankMenu(e) {
  contextMenuTargetIds = [];

  // 先探一下剪贴板里有没有能粘的东西（只探测，不落临时文件）
  let probe = { ok: true, kind: 'none' };
  try {
    probe = (await window.electronAPI?.pasteClipboard?.({ peek: true })) || probe;
  } catch (_) { /* 读不到就当没有 */ }

  const has = Boolean(probe.ok) && probe.kind !== 'none';
  const isImage = probe.kind === 'image';
  const label = isImage ? '粘贴图片' : (probe.kind === 'files' ? '粘贴文件' : '粘贴');

  renderContextMenu(e, [
    {
      label,
      action: 'paste',
      disabled: !has,
      tip: has
        ? `把剪贴板里的${isImage ? '图片' : '文件'}导入到当前分组（Ctrl+V 也可以）`
        : '剪贴板里没有图片或文件'
    },
    { separator: true },
    { label: '导入文件…', action: 'importFiles', tip: '打开文件选择器，可多选' },
    { label: '新建笔记', action: 'newNote' },
    { separator: true },
    { label: '全选', action: 'selectAll', disabled: currentListItems().length === 0 }
  ], { type: 'listBlank' });
}

async function handleListBlankAction(action) {
  closeContextMenu();
  if (action === 'paste') { await importFromClipboard(); return; }
  if (action === 'importFiles') { $('#fileInput')?.click(); return; }
  if (action === 'newNote') { await createNote(); return; }
  if (action === 'selectAll') selectAllInList();
}

function openAppContextMenu(e) {
  const mode = getImportMode();
  const listCount = currentListItems().length;
  const count = state.selection.size;

  contextMenuTargetIds = [];
  renderContextMenu(e, [
    {
      label: count ? `批量操作（已选 ${count} 项）` : '批量操作',
      action: 'batch',
      disabled: listCount === 0 && !count,
      tip: (listCount === 0 && !count) ? '当前列表没有项目' : '全选 / 移到分组 / 导入到库 / 删除'
    },
    { separator: true },
    { label: (mode === 'move' ? '✓ ' : '') + '导入时移动原文件到资源文件夹', action: 'importMove' },
    { label: (mode === 'copy' ? '✓ ' : '') + '导入时复制，原文件保留在原处', action: 'importCopy' },
    { separator: true },
    { label: '整理资源到分组文件夹', action: 'organize' },
    { label: '打开软件资源文件夹', action: 'openLibraryRoot' },
    { label: '打开压缩包文件夹', action: 'openZipFolder' }
  ], { type: 'app' });
}

function openContextMenu(e, ids) {
  const targets = ids
    .map((id) => state.items.find((i) => i.id === id))
    .filter(Boolean);
  if (!targets.length) return;

  contextMenuTargetIds = ids;
  const single = targets.length === 1 ? targets[0] : null;
  const isNote = single && single.type === 'note';
  const ipcReady = Boolean(window.electronAPI?.copyImage);

  const rows = [];
  if (single) {
    if (isNote) {
      rows.push({ label: '复制 Markdown', action: 'copy' });
      rows.push({ label: '导出为 PDF…', action: 'exportPdf', tip: '把这条笔记导出成 PDF 文件' });
    } else {
      rows.push({ label: '复制图片', action: 'copy', disabled: !ipcReady, tip: ipcReady ? '' : '需要重启应用后可用' });
      // 按文件的实际存放位置给出对应入口
      if (single.backupPath) {
        rows.push({ label: '在资源管理器中显示', action: 'revealBackupPath' });
        rows.push({ label: '打开所在分组文件夹', action: 'openLibraryFolder' });
      } else if (single.dataURL) {
        rows.push({ label: '在资源管理器中显示（软件内备份）', action: 'revealBackup' });
      }
      if (single.sourcePath) {
        rows.push({ label: '在资源管理器中显示（原路径）', action: 'revealSource' });
      }
      if (!single.backupPath && !single.dataURL && !single.sourcePath) {
        rows.push({ label: '在资源管理器中显示', disabled: true, tip: '无可用文件路径' });
      }
    }
  }
  rows.push({ separator: true });
  rows.push({
    label: targets.length > 1 ? `删除 ${targets.length} 项` : '删除',
    action: 'delete',
    danger: true
  });

  renderContextMenu(e, rows, { type: 'items', ids });
}

const META_COLLAPSED_KEY = 'memorie.metaCollapsed';

function applyMetaCollapsed(collapsed) {
  const panel = $('#metaPanel');
  const btn = $('#metaCollapseBtn');
  if (!panel || !btn) return;
  panel.classList.toggle('is-collapsed', collapsed);
  btn.textContent = collapsed ? '⌃' : '⌄';
  btn.title = collapsed ? '展开编辑栏' : '收起编辑栏';
}

function toggleMetaPanel() {
  const collapsed = !$('#metaPanel').classList.contains('is-collapsed');
  applyMetaCollapsed(collapsed);
  localStorage.setItem(META_COLLAPSED_KEY, collapsed ? '1' : '0');
}

function restoreMetaPanelState() {
  applyMetaCollapsed(localStorage.getItem(META_COLLAPSED_KEY) === '1');
}

// ===== 分组栏 / 列表栏的收起与展开 =====
const PANEL_FOLD_KEY = 'memorie.panelFold';

function readPanelFoldState() {
  try {
    return JSON.parse(localStorage.getItem(PANEL_FOLD_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

// which: 'folders'（分组栏）| 'list'（列表栏）
function setPanelFold(which, collapsed, persist = true) {
  const ws = $('.workspace');
  if (!ws) return;

  const isFolders = which === 'folders';
  ws.classList.toggle(isFolders ? 'is-folders-collapsed' : 'is-list-collapsed', collapsed);

  const btn = $(isFolders ? '#foldFoldersBtn' : '#foldListBtn');
  if (btn) {
    const label = (collapsed ? '展开' : '收起') + (isFolders ? '分组栏' : '列表栏');
    btn.textContent = collapsed ? '›' : '‹';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }

  if (persist) {
    const saved = readPanelFoldState();
    saved[which] = collapsed;
    localStorage.setItem(PANEL_FOLD_KEY, JSON.stringify(saved));
  }
}

function restorePanelFoldState() {
  const saved = readPanelFoldState();
  setPanelFold('folders', Boolean(saved.folders), false);
  setPanelFold('list', Boolean(saved.list), false);
}

function showToast(message, { action = null, duration = 2200 } = {}) {
  const toast = $('#toast');
  toast.textContent = '';

  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  toast.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(showToast.timer);
      toast.classList.remove('is-visible');
      if (typeof action.onAction === 'function') action.onAction();
    });
    toast.appendChild(btn);
  }

  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), duration);
}

function confirmDelete({ title = '确认删除？', message = '此操作无法撤销。', confirmText = '删除' } = {}) {
  return new Promise((resolve) => {
    const overlay = $('#confirmOverlay');
    const titleEl = $('#confirmTitle');
    const messageEl = $('#confirmMessage');
    const deleteBtn = $('#confirmDeleteBtn');
    const cancelBtn = $('#confirmCancelBtn');

    titleEl.textContent = title;
    messageEl.textContent = message;
    deleteBtn.textContent = confirmText;

    const cleanup = (result) => {
      overlay.classList.remove('is-visible');
      overlay.hidden = true;
      deleteBtn.removeEventListener('click', onDelete);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlayClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(result);
    };

    const onDelete = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => {
      if (e.target === overlay) cleanup(false);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') cleanup(false);
    };

    deleteBtn.addEventListener('click', onDelete);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlayClick);
    document.addEventListener('keydown', onKeydown);

    overlay.hidden = false;
    // Force reflow for transition
    overlay.offsetHeight;
    overlay.classList.add('is-visible');
  });
}

// ===== 笔记编辑器工具栏（路由到 CodeMirror 内核） =====
// ===== 富文本编辑器（contentEditable） =====
const RICH_EDITOR_ID = 'noteEditorRich';

function richEditor() { return $('#' + RICH_EDITOR_ID); }

// 内容格式适配：新数据为 HTML；旧 Markdown 数据打开时自动转换
// 渲染后给所有标题分配锚点 id（已有 id 的保留），供目录点击跳转
function noteToHtml(description) {
  const text = description || '';
  const html = /<[a-z][^>]*>/i.test(text) ? text : (renderMarkdown(text) || '<p><br></p>');
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((h, i) => {
    if (!h.id) h.id = 'nh-' + i;
  });
  return tpl.innerHTML;
}

// 浏览用预览：左侧竖排可收起目录 + 右侧正文（目录最多两级：H1 一级、H2 二级）
const NOTE_TOC_COLLAPSED_KEY = 'memorie.tocCollapsed';

function renderNotePreview(el, description) {
  const body = document.createElement('div');
  body.className = 'note-preview__content';
  body.innerHTML = noteToHtml(description);
  // 隐藏旧版本插入到内容里的目录块，避免与自动目录重复
  body.querySelectorAll('.note-toc--inline').forEach((n) => { n.style.display = 'none'; });

  const headings = [...body.querySelectorAll('h1, h2')];

  el.innerHTML = '';

  if (headings.length) {
    const items = headings.map((h, i) => {
      const level = Number(h.tagName[1]);
      if (!h.id) h.id = 'nh-' + i;
      return '<li class="note-toc__item note-toc__item--h' + level + '">'
        + '<a href="#' + h.id + '" title="' + escapeHtml(h.textContent) + '">'
        + escapeHtml(h.textContent) + '</a></li>';
    }).join('');

    const col = document.createElement('aside');
    col.className = 'note-toc-col';
    col.innerHTML =
      '<div class="note-toc-col__head">'
      + '<span class="note-toc-col__title">目录</span>'
      + '<button type="button" class="note-toc-col__toggle" title="收起目录" aria-label="收起目录">‹</button>'
      + '</div>'
      + '<ul class="note-toc__list">' + items + '</ul>';

    col.querySelector('.note-toc-col__toggle').addEventListener('click', () => {
      applyNoteTocCollapsed(el, !el.classList.contains('is-toc-collapsed'));
    });

    el.appendChild(col);
    applyNoteTocCollapsed(el, localStorage.getItem(NOTE_TOC_COLLAPSED_KEY) === '1');
  }

  el.appendChild(body);
}

// 目录竖栏的收起/展开（状态写入 localStorage，下次打开沿用）
function applyNoteTocCollapsed(el, collapsed) {
  el.classList.toggle('is-toc-collapsed', collapsed);
  const btn = el.querySelector('.note-toc-col__toggle');
  if (btn) {
    const label = collapsed ? '展开目录' : '收起目录';
    btn.textContent = collapsed ? '›' : '‹';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  localStorage.setItem(NOTE_TOC_COLLAPSED_KEY, collapsed ? '1' : '0');
}

function richExec(command, value = null) {
  richEditor().focus();
  document.execCommand(command, false, value);
}

// 当前所在块级标签（用于标题/引用的 toggle）
function currentBlockTag() {
  const sel = window.getSelection();
  let node = sel && sel.anchorNode;
  while (node && node !== richEditor()) {
    if (node.nodeType === 1) {
      const tag = node.tagName.toLowerCase();
      if (['h1', 'h2', 'h3', 'blockquote', 'p', 'div'].includes(tag)) return tag;
    }
    node = node.parentNode;
  }
  return 'p';
}

function toggleBlock(tag) {
  richExec('formatBlock', currentBlockTag() === tag ? '<p>' : '<' + tag + '>');
}

function execEditorCommand(cmd) {
  switch (cmd) {
    case 'undo': richExec('undo'); break;
    case 'redo': richExec('redo'); break;
    case 'bold': richExec('bold'); break;
    case 'italic': richExec('italic'); break;
    case 'underline': richExec('underline'); break;
    case 'strike': richExec('strikeThrough'); break;
    case 'code': {
      const sel = window.getSelection();
      const text = sel ? sel.toString() : '';
      richExec('insertHTML', '<code>' + escapeHtml(text || '代码') + '</code>');
      // 光标移入 code 元素内末尾，方便继续输入（内容变长自动扩展）
      const selNow = window.getSelection();
      let node = selNow.anchorNode;
      if (node && node.nodeName !== 'CODE') node = node.previousSibling;
      if (node && node.nodeName === 'CODE') {
        const r = document.createRange();
        r.selectNodeContents(node);
        r.collapse(false);
        selNow.removeAllRanges();
        selNow.addRange(r);
      }
      break;
    }
    case 'codeblock':
      richExec('insertHTML', '<pre><code><br></code></pre><p><br></p>');
      break;
    case 'link':
      openLinkDialog();
      break;
    case 'h1': toggleBlock('h1'); break;
    case 'h2': toggleBlock('h2'); break;
    case 'h3': toggleBlock('h3'); break;
    case 'quote': toggleBlock('blockquote'); break;
    case 'hr': richExec('insertHorizontalRule'); break;
    case 'clear': richExec('removeFormat'); break;
    case 'table':
      richExec('insertHTML', '<table><thead><tr><th>列1</th><th>列2</th><th>列3</th></tr></thead><tbody><tr><td>内容</td><td>内容</td><td>内容</td></tr><tr><td>内容</td><td>内容</td><td>内容</td></tr></tbody></table><p><br></p>');
      break;
    case 'image':
      $('#insertImageInput').click();
      break;
  }
}

// ===== 笔记内容搜索（顶部工具栏搜索框）=====
// 用 CSS Custom Highlight API 做高亮：不改动编辑器 DOM，因此不会被写进笔记内容
const FIND_HL = 'note-find';
const FIND_HL_ACTIVE = 'note-find-active';
let findRanges = [];
let findIndex = -1;

function clearNoteFind() {
  findRanges = [];
  findIndex = -1;
  if (window.CSS && CSS.highlights) {
    CSS.highlights.delete(FIND_HL);
    CSS.highlights.delete(FIND_HL_ACTIVE);
  }
  const count = $('#noteFindCount');
  if (count) count.textContent = '';
}

function collectFindRanges(root, query) {
  const ranges = [];
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node;
  while ((node = walker.nextNode())) {
    const text = (node.nodeValue || '').toLowerCase();
    if (!text) continue;
    let from = text.indexOf(needle);
    while (from !== -1) {
      const range = document.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
      from = text.indexOf(needle, from + needle.length);
    }
  }
  return ranges;
}

function runNoteFind(query) {
  clearNoteFind();
  const editor = richEditor();
  if (!editor || !query) return;

  findRanges = collectFindRanges(editor, query);
  const count = $('#noteFindCount');
  if (!findRanges.length) {
    if (count) count.textContent = '无结果';
    return;
  }
  if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
    CSS.highlights.set(FIND_HL, new Highlight(...findRanges));
  }
  focusFindMatch(0);
}

function focusFindMatch(index) {
  const total = findRanges.length;
  if (!total) return;
  findIndex = ((index % total) + total) % total;

  const range = findRanges[findIndex];
  if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
    CSS.highlights.set(FIND_HL_ACTIVE, new Highlight(range));
  }
  const host = range.startContainer.nodeType === 1
    ? range.startContainer
    : range.startContainer.parentElement;
  if (host) host.scrollIntoView({ block: 'center', behavior: 'smooth' });

  const count = $('#noteFindCount');
  if (count) count.textContent = (findIndex + 1) + '/' + total;
}

function stepFindMatch(delta) {
  if (!findRanges.length) return;
  focusFindMatch(findIndex + delta);
}

function openNoteEditor() {
  const item = state.items.find((i) => i.id === state.selectedId);
  if (!item || item.type !== 'note') return;

  const overlay = $('#noteEditorOverlay');
  const editor = richEditor();

  editor.innerHTML = noteToHtml(item.description);
  // 每次打开都清空上一次的搜索状态
  const findInput = $('#noteFindInput');
  if (findInput) findInput.value = '';
  clearNoteFind();

  overlay.hidden = false;
  overlay.offsetHeight;
  overlay.classList.add('is-visible');
  editor.focus();
}

function closeNoteEditor() {
  const overlay = $('#noteEditorOverlay');
  const bar = $('#selToolbar');
  if (bar) bar.hidden = true;
  clearNoteFind();
  overlay.classList.remove('is-visible');
  setTimeout(() => {
    overlay.hidden = true;
  }, 250);
}

// 只把编辑器内容写回笔记（不关闭编辑器），返回是否保存成功
async function persistNoteEditor() {
  const item = state.items.find((i) => i.id === state.selectedId);
  if (!item || item.type !== 'note') return false;

  const editor = richEditor();
  const isEmpty = !editor.innerText.trim() && !editor.querySelector('img');
  item.description = isEmpty ? '' : editor.innerHTML.trim();
  await saveItem(item);

  renderNotePreview($('#notePreview'), item.description);
  $('#metaDesc').value = item.description;
  renderGrid();
  return true;
}

// 把一条笔记导出成 PDF：排版交给主进程（隐藏窗口渲染 + printToPDF），这里只负责取名与提示
async function exportNoteAsPdf(item, liveHtml) {
  if (!item) return;

  const html = liveHtml != null ? liveHtml : (item.description || '');
  if (!html.trim()) {
    showToast('这条笔记还是空的，没什么可导出的');
    return;
  }

  // 文件名优先用笔记名；还是默认名的话退化成正文开头
  const rawTitle = (item.name && item.name !== '未命名笔记') ? item.name : getNoteExcerpt(html, 20);
  const title = rawTitle || '笔记';
  const fileName = String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.pdf';

  showToast('正在生成 PDF…', { duration: 1600 });
  const res = await window.electronAPI?.exportNotePdf?.({ title, html, fileName });

  if (!res) { showToast('导出失败：主进程没有响应'); return; }
  if (res.canceled) return;
  if (!res.ok) { showToast('导出失败：' + (res.error || '未知错误')); return; }

  showToast(`已导出 PDF（${formatFileSize(res.size)}）`, {
    duration: 8000,
    action: { label: '查看位置', onAction: () => window.electronAPI?.showInExplorer?.(res.path) }
  });
}

// "返回"按钮：默认先自动保存，再退出编辑器
async function saveNoteEditor() {
  const ok = await persistNoteEditor();
  if (!ok) return;
  closeNoteEditor();
  showToast('笔记已保存');
}

// 编辑器右上角"关闭"：先自动保存，再关闭窗口，避免未保存内容丢失
async function saveNoteEditorAndClose() {
  await persistNoteEditor();
  window.electronAPI?.close?.();
}

// 插入链接面板：文本 + 链接两个输入框，确认后插入 <a>
let savedLinkRange = null;

function openLinkDialog() {
  const sel = window.getSelection();
  savedLinkRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  const text = sel ? sel.toString() : '';

  $('#linkText').value = text;
  $('#linkUrl').value = '';
  $('#linkConfirmBtn').disabled = true;

  const overlay = $('#linkDialogOverlay');
  overlay.hidden = false;
  overlay.classList.add('is-visible');
  setTimeout(() => (text ? $('#linkUrl') : $('#linkText')).focus(), 50);
}

function closeLinkDialog() {
  const overlay = $('#linkDialogOverlay');
  overlay.classList.remove('is-visible');
  setTimeout(() => { overlay.hidden = true; }, 180);
}

function confirmLinkDialog() {
  const url = $('#linkUrl').value.trim();
  const text = $('#linkText').value.trim();
  if (!url) {
    showToast('请输入或粘贴链接');
    return;
  }
  const href = /^(https?:\/\/|mailto:)/i.test(url) ? url : 'https://' + url;
  const label = escapeHtml(text || url);

  closeLinkDialog();
  const editor = richEditor();
  editor.focus();
  if (savedLinkRange) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedLinkRange);
  } else {
    // 无保存选区：把光标移到编辑器末尾
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  richExec('insertHTML', '<a href="' + escapeHtml(href) + '">' + label + '</a>');
  savedLinkRange = null;
}

// （目录已改为浏览时自动生成，不再向内容插入目录块）

// ===== 音乐播放器 =====
const player = {
  queue: [],
  index: -1,
  mode: 'list',   // list=列表循环 | one=单曲循环 | shuffle=随机播放
  currentId: null
};

function audioEl() { return $('#musicAudio'); }

function formatTime(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function musicModeLabel(mode) {
  if (mode === 'one') return '单曲循环';
  if (mode === 'shuffle') return '随机播放';
  return '列表循环';
}

function renderMusicBar() {
  const bar = $('#musicBar');
  if (!bar) return;
  const audio = audioEl();
  bar.hidden = !player.currentId;

  const item = state.items.find((i) => i.id === player.currentId);
  $('#musicTitle').textContent = item ? item.name : '未播放';
  $('#musicSub').textContent = item
    ? (item.category || formatFileSize(item.size || 0))
    : '—';
  $('#musicPlay').textContent = audio && !audio.paused ? '❚❚' : '▶';
  $('#musicMode').textContent = musicModeLabel(player.mode);
}

// 播放指定条目
async function playMusicItem(item, { silent = false } = {}) {
  const audio = audioEl();
  if (!audio || !item) return false;

  const res = await resolvePreviewUrl(item);
  if (!res.ok) {
    if (!silent) showToast('播放失败：文件不存在或无法读取');
    return false;
  }

  player.currentId = item.id;
  player.index = player.queue.findIndex((i) => i.id === item.id);
  audio.src = res.url;
  audio.volume = Number($('#musicVolume').value) / 100;
  try { await audio.play(); } catch (_) { /* 自动播放可能被拦截 */ }

  renderMusicBar();
  renderMusicList();
  if (state.selectedId !== item.id) selectItem(item.id);
  return true;
}

function syncMusicQueue() {
  player.queue = getMusicItems();
  player.index = player.currentId
    ? player.queue.findIndex((i) => i.id === player.currentId)
    : -1;
}

// 上一首 / 下一首（"播放结束自动下一首"也走这里）
async function playMusicStep(delta = 1) {
  syncMusicQueue();
  const queue = player.queue;
  if (!queue.length) return;

  if (player.index < 0) {
    player.index = 0;   // 还没在播 → 从第一首开始
  } else if (player.mode === 'shuffle' && queue.length > 1) {
    let next = player.index;
    while (next === player.index) next = Math.floor(Math.random() * queue.length);
    player.index = next;
  } else {
    player.index = ((player.index + delta) % queue.length + queue.length) % queue.length;
  }

  await playMusicItem(queue[player.index], { silent: true });
}

async function toggleMusicPlay() {
  const audio = audioEl();
  if (!audio) return;

  if (!player.currentId) {
    syncMusicQueue();
    if (!player.queue.length) {
      showToast('该分组里还没有音频文件');
      return;
    }
    await playMusicItem(player.queue[0]);
    return;
  }

  if (audio.paused) {
    try { await audio.play(); } catch (_) {}
  } else {
    audio.pause();
  }
  renderMusicBar();
}

function stopMusic() {
  const audio = audioEl();
  if (audio) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  player.currentId = null;
  player.index = -1;
  renderMusicBar();
}

// 中栏播放器列表
function renderMusicList() {
  const list = $('#musicList');
  if (!list) return;

  // 有勾选时进入「批量模式」：每一行的左侧勾选框都显示出来
  list.classList.toggle('is-batch-mode', state.selection.size > 0);

  const items = getMusicItems();
  player.queue = items;
  player.index = player.currentId ? items.findIndex((i) => i.id === player.currentId) : -1;

  // 清掉已经不在列表里的选中项（比如刚被移到别的分组）
  const liveIds = new Set(items.map((i) => i.id));
  for (const id of [...state.selection]) {
    if (!liveIds.has(id)) state.selection.delete(id);
  }

  if (!items.length) {
    list.innerHTML = '<li class="music-list__empty">'
      + (state.search
        ? '没有匹配的歌曲'
        : '该分组暂无音频<br>点上方「添加媒体」导入 mp3 / flac / m4a / wav 等')
      + '</li>';
    return;
  }

  list.innerHTML = items.map((item, i) => {
    const active = item.id === player.currentId;
    const selected = state.selection.has(item.id);
    return `<li class="music-row${active ? ' is-playing' : ''}${selected ? ' is-selected' : ''}" draggable="true" data-id="${item.id}" title="${escapeHtml(item.name)}">
      <button type="button" class="music-row__check" data-check="${item.id}"
        title="${selected ? '取消选择' : '选择'}" aria-label="${selected ? '取消选择' : '选择'}"
        aria-pressed="${selected ? 'true' : 'false'}">✓</button>
      <span class="music-row__index">${active ? '♪' : i + 1}</span>
      <span class="music-row__cover">♪</span>
      <span class="music-row__main">
        <span class="music-row__title">${escapeHtml(item.name)}</span>
        <span class="music-row__sub">${escapeHtml(item.category || formatFileSize(item.size || 0))}</span>
      </span>
      <span class="music-row__dur">${formatTime(item.duration || 0)}</span>
      <button type="button" class="music-row__more" data-more="${item.id}" title="更多操作" aria-label="更多操作">⋯</button>
    </li>`;
  }).join('');

  list.querySelectorAll('.music-row').forEach((row) => {
    const rowId = row.dataset.id;

    // 左侧勾选框：点一下即选 / 取消，不触发播放、不影响其他已勾选项
    const checkBtn = row.querySelector('.music-row__check');
    if (checkBtn) {
      checkBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleSelection(rowId);
      });
    }

    // 普通点击 = 播放；Ctrl/Cmd 加选；Shift 范围选
    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) {
        toggleSelection(rowId);
        return;
      }
      if (e.shiftKey && state.lastSelectedId) {
        const ordered = currentListItems();
        const a = ordered.findIndex((i) => i.id === state.lastSelectedId);
        const b = ordered.findIndex((i) => i.id === rowId);
        if (a !== -1 && b !== -1) {
          const [start, end] = a < b ? [a, b] : [b, a];
          for (let k = start; k <= end; k++) state.selection.add(ordered[k].id);
          renderMusicList();
          updateBatchBar();
          return;
        }
      }
      if (state.selection.size) {
        state.selection.clear();
        renderMusicList();
        updateBatchBar();
      }
      const item = state.items.find((i) => i.id === rowId);
      if (item) playMusicItem(item);
    });

    // 拖到左侧分组 = 批量移动（文件也跟着走）
    row.addEventListener('dragstart', (e) => {
      const ids = state.selection.has(rowId) && state.selection.size > 1
        ? [...state.selection]
        : [rowId];
      e.dataTransfer.setData('text/plain', JSON.stringify(ids));
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      $$('.folder-item.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    });

    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ids = state.selection.has(rowId) && state.selection.size > 1
        ? [...state.selection]
        : [rowId];
      openContextMenu(e, ids);
    });

    const moreBtn = row.querySelector('.music-row__more');
    if (moreBtn) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const ids = state.selection.has(rowId) && state.selection.size > 1
          ? [...state.selection]
          : [rowId];
        openContextMenu(e, ids);
      });
    }
  });
}

function initTitleBar() {
  const btns = $('.titlebar__controls');
  if (!btns) return;

  btns.querySelector('[aria-label="最小化"]').addEventListener('click', () => {
    if (window.electronAPI?.minimize) window.electronAPI.minimize();
  });
  btns.querySelector('[aria-label="最大化"]').addEventListener('click', () => {
    if (window.electronAPI?.maximize) window.electronAPI.maximize();
  });
  btns.querySelector('[aria-label="关闭"]').addEventListener('click', () => {
    if (window.electronAPI?.close) window.electronAPI.close();
  });
}

// ===== Shift+Z：收起整个窗口；收起来之后再按一次 Shift+Z 恢复 =====
const HOTKEY_HINT_KEY = 'memorie.hideHotkeyHint2';

function isTypingTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || '');
}

function onHideHotkeyKeydown(e) {
  if (e.isComposing) return; // 中文输入法组字中不算
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.code !== 'KeyZ' && String(e.key).toLowerCase() !== 'z') return;
  if (e.repeat) return;
  // 正在输入文字时不触发（搜索框、分组重命名、笔记正文…）
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;

  hideWindowByHotkey();
}

function hideWindowByHotkey() {
  if (!window.electronAPI?.hideWindowWithHotkey) return;

  // 第一次用先把"怎么恢复"说清楚，之后再按就立即收起
  if (!localStorage.getItem(HOTKEY_HINT_KEY)) {
    localStorage.setItem(HOTKEY_HINT_KEY, '1');
    showToast('已收起窗口 · 想恢复时再按一次 Shift+Z', { duration: 1600 });
    setTimeout(() => window.electronAPI.hideWindowWithHotkey(), 1400);
    return;
  }
  window.electronAPI.hideWindowWithHotkey();
}

// ===== 预览区左右切换：跳到当前列表里的上一个 / 下一个资源 =====
function updatePreviewNav() {
  const prev = $('#previewPrevBtn');
  const next = $('#previewNextBtn');
  if (!prev || !next) return;

  const items = currentListItems();
  const idx = items.findIndex((i) => i.id === state.selectedId);
  // 只有一个项目、或当前选中项不在这个列表里 → 不显示
  const useless = items.length < 2 || idx === -1;

  prev.hidden = useless;
  next.hidden = useless;
  prev.disabled = idx <= 0;
  next.disabled = idx === -1 || idx >= items.length - 1;
}

function stepPreview(delta) {
  const items = currentListItems();
  const idx = items.findIndex((i) => i.id === state.selectedId);
  if (idx === -1) return;

  const target = items[idx + delta];
  if (!target) return;

  selectItem(target.id);
  // 让中栏里对应的卡片 / 歌曲行也滚进可视范围
  const el = document.querySelector(`.thumb-card[data-id="${target.id}"]`)
    || document.querySelector(`.music-row[data-id="${target.id}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function initEvents() {
  initTitleBar();
  initSettings();

  // 分组栏 / 列表栏收起
  $('#foldFoldersBtn').addEventListener('click', () => {
    setPanelFold('folders', !$('.workspace').classList.contains('is-folders-collapsed'));
  });
  $('#foldListBtn').addEventListener('click', () => {
    setPanelFold('list', !$('.workspace').classList.contains('is-list-collapsed'));
  });

  // Shift+Z：收起窗口（恢复靠主进程的全局快捷键）
  document.addEventListener('keydown', onHideHotkeyKeydown);

  // 预览区左右切换按钮
  $('#previewPrevBtn').addEventListener('click', () => stepPreview(-1));
  $('#previewNextBtn').addEventListener('click', () => stepPreview(1));

  // ===== 视频大播放器：关闭按钮 / 点空白 / Esc =====
  $('#theaterCloseBtn').addEventListener('click', closeTheater);
  $('#theaterOverlay').addEventListener('click', (e) => {
    if (e.target === $('#theaterOverlay')) closeTheater();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && theater) {
      e.preventDefault();
      closeTheater();
    }
  });

  // ===== 音乐播放器 =====
  const musicAudio = audioEl();
  let musicSeeking = false;

  musicAudio.addEventListener('play', renderMusicBar);
  musicAudio.addEventListener('pause', renderMusicBar);
  musicAudio.addEventListener('ended', () => {
    if (player.mode === 'one') {
      musicAudio.currentTime = 0;
      musicAudio.play();
      return;
    }
    playMusicStep(1); // 自动下一首
  });
  musicAudio.addEventListener('loadedmetadata', () => {
    $('#musicDur').textContent = formatTime(musicAudio.duration);
    // 顺手把时长补进条目，方便列表显示
    const item = state.items.find((i) => i.id === player.currentId);
    if (item && item.type === 'audio' && Number.isFinite(musicAudio.duration) && !item.duration) {
      item.duration = musicAudio.duration;
      saveItem(item).then(() => renderMusicList()).catch(() => {});
    }
  });
  musicAudio.addEventListener('timeupdate', () => {
    if (musicSeeking) return;
    const dur = musicAudio.duration;
    $('#musicSeek').value = Number.isFinite(dur) && dur > 0
      ? String(Math.round((musicAudio.currentTime / dur) * 1000))
      : '0';
    $('#musicCur').textContent = formatTime(musicAudio.currentTime);
  });

  const seekBar = $('#musicSeek');
  seekBar.addEventListener('pointerdown', () => { musicSeeking = true; });
  seekBar.addEventListener('input', () => {
    const dur = musicAudio.duration;
    if (Number.isFinite(dur) && dur > 0) {
      musicAudio.currentTime = (Number(seekBar.value) / 1000) * dur;
    }
  });
  window.addEventListener('pointerup', () => { musicSeeking = false; });

  $('#musicVolume').addEventListener('input', () => {
    musicAudio.volume = Number($('#musicVolume').value) / 100;
  });
  $('#musicPlay').addEventListener('click', toggleMusicPlay);
  $('#musicPrev').addEventListener('click', () => playMusicStep(-1));
  $('#musicNext').addEventListener('click', () => playMusicStep(1));
  $('#musicMode').addEventListener('click', () => {
    player.mode = player.mode === 'list' ? 'one' : player.mode === 'one' ? 'shuffle' : 'list';
    renderMusicBar();
    showToast(musicModeLabel(player.mode));
  });
  renderMusicBar();

  $('#newFolderBtn').addEventListener('click', () => createGroup());
  $('#newNoteBtn').addEventListener('click', () => createNote());

  // 添加媒体：首次导入先说明"文件会去哪 + 移动还是复制"
  $('#addMediaBtn').addEventListener('click', async (e) => {
    if (hasImportMode()) return; // 已经选过，直接走 <label> 的默认行为
    e.preventDefault();
    if (await ensureImportModeChosen()) $('#fileInput').click();
  });

  $('#fileInput').addEventListener('change', (e) => {
    if (e.target.files.length) {
      addFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  });

  $('#searchInput').addEventListener('input', (e) => {
    state.search = e.target.value.trim();
    renderGrid();
  });

  $$('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.filter-chip').forEach((c) => c.classList.remove('is-active'));
      chip.classList.add('is-active');
      state.filter = chip.dataset.filter;
      renderGrid();
    });
  });

  $('#metaForm').addEventListener('submit', (e) => {
    e.preventDefault();
    saveCurrentMeta();
  });

  $('#deleteBtn').addEventListener('click', removeCurrentItem);

  $('#markdownModeBtn').addEventListener('click', () => {
    enterMarkdownMode(!markdownPreviewMode);
  });

  $('#metaDesc').addEventListener('input', () => {
    updateNotePreview();
  });

  $('#editNoteBtn').addEventListener('click', openNoteEditor);
  $('#metaCollapseBtn').addEventListener('click', toggleMetaPanel);
  $('#importBtn').addEventListener('click', importCurrentItem);
  $('#batchImportBtn').addEventListener('click', importSelected);
  $('#batchCancelBtn').addEventListener('click', clearSelection);
  $('#batchSelectAllBtn').addEventListener('click', selectAllInList);
  $('#batchDeleteBtn').addEventListener('click', deleteSelection);

  // 右键菜单：按钮分发 + 点击别处/Esc 关闭
  $('#contextMenu').addEventListener('click', (e) => {
    // 菜单内部的点击一律不冒泡到 document：
    // 否则二级菜单会在自己重绘后，被"点击外部关闭"的逻辑误判关掉
    e.stopPropagation();

    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const type = contextMenuContext ? contextMenuContext.type : 'items';
    if (type === 'group') handleGroupContextAction(action);
    else if (type === 'app') handleAppContextAction(action);
    else if (type === 'listBlank') handleListBlankAction(action);
    else handleContextAction(action);
  });
  // 菜单键盘导航
  document.addEventListener('keydown', onContextMenuKeydown);

  // 列表空白处右键：粘贴剪贴板 / 导入文件 / 新建笔记
  const leftPanel = $('.panel--left');
  if (leftPanel) {
    leftPanel.addEventListener('contextmenu', (e) => {
      // 卡片、歌曲行、按钮、输入框保持各自的行为（卡片有自己的右键菜单）；
      // 空状态、网格空白处、状态栏都算"空白处"，在这里也能粘贴
      if (e.target && e.target.closest
        && e.target.closest('.thumb-card, .music-row, button, input, textarea, label')) {
        return;
      }
      e.preventDefault();
      openListBlankMenu(e);
    });
  }

  // Ctrl+V：把剪贴板里的图片 / 复制的文件粘进当前分组
  document.addEventListener('paste', (e) => {
    const settings = $('#settingsOverlay');
    if (settings && !settings.hidden) return;
    if (isTypingTarget(e.target)) return;   // 输入框、笔记编辑器里的粘贴交给系统
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    if (!items.some((it) => it.kind === 'file')) return;  // 纯文本粘贴不拦
    e.preventDefault();
    importFromClipboard();
  });

  // 工具栏「⋯」：导入方式 / 打开资源文件夹
  $('#moreMenuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openAppContextMenu(e);
  });
  document.addEventListener('click', (e) => {
    const menu = $('#contextMenu');
    if (!menu.hidden && !menu.contains(e.target)) closeContextMenu();
  });

  document.addEventListener('keydown', (e) => {
    // Esc：先关右键菜单，再清空多选（弹层打开时让位给弹层自身的 Esc 逻辑）
    if (e.key === 'Escape') {
      if (!$('#contextMenu').hidden) {
        closeContextMenu();
        return;
      }
      if (state.selection.size) {
        const noteEditorOpen = $('#noteEditorOverlay').classList.contains('is-visible');
        const confirmOpen = $('#confirmOverlay').classList.contains('is-visible');
        if (!noteEditorOpen && !confirmOpen) clearSelection();
      }
    }
  });
  // 返回：自动保存后退出编辑器
  // 批量选择的快捷键：Ctrl/Cmd+A 全选当前列表，Delete 删除选中项
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || (t && t.isContentEditable)) return; // 输入框里保留原生行为
    if ($('#noteEditorOverlay').classList.contains('is-visible')) return;             // 笔记编辑器里用原生全选

    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'a') {
      e.preventDefault();
      selectAllInList();
      return;
    }
    if (e.key === 'Delete' && state.selection.size) {
      e.preventDefault();
      deleteSelection();
    }
  });

  $('#closeNoteEditorBtn').addEventListener('click', saveNoteEditor);
  // 右上角窗口控制
  $('#noteMinBtn').addEventListener('click', () => window.electronAPI?.minimize?.());
  $('#noteMaxBtn').addEventListener('click', () => window.electronAPI?.maximize?.());
  $('#noteCloseBtn').addEventListener('click', saveNoteEditorAndClose);

  // 工具栏：mousedown + preventDefault 保持编辑器焦点与选区
  $('#noteToolbar').addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-cmd], button[data-level]');
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.level) richExec('formatBlock', '<' + btn.dataset.level + '>');
    else execEditorCommand(btn.dataset.cmd);
  });

  // 工具栏「导出 PDF」：先把编辑器内容落盘，保证导出的就是眼前这份（含没保存的改动）
  $('#noteToolbar').addEventListener('mousedown', async (e) => {
    if (!e.target.closest || !e.target.closest('#noteExportPdfBtn')) return;
    e.preventDefault();
    const item = state.items.find((i) => i.id === state.selectedId);
    if (!item || item.type !== 'note') return;
    await persistNoteEditor();
    await exportNoteAsPdf(item);
  });

  // 顶部工具栏搜索框：搜索笔记内容
  const findInput = $('#noteFindInput');
  let findTimer = 0;
  findInput.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runNoteFind(findInput.value.trim()), 140);
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      stepFindMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      findInput.value = '';
      runNoteFind('');
    }
  });
  $('#noteFindPrev').addEventListener('mousedown', (e) => { e.preventDefault(); stepFindMatch(-1); });
  $('#noteFindNext').addEventListener('mousedown', (e) => { e.preventDefault(); stepFindMatch(1); });

  // Ctrl/Cmd+F：聚焦搜索框
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      if (!$('#noteEditorOverlay').classList.contains('is-visible')) return;
      e.preventDefault();
      findInput.focus();
      findInput.select();
    }
  });

  // 选区变化时同步 B/I/U/S 按钮激活态
  document.addEventListener('selectionchange', () => {
    const editor = richEditor();
    const sel = window.getSelection();
    if (!editor || !sel || !sel.anchorNode || !editor.contains(sel.anchorNode)) return;
    const states = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikeThrough' };
    for (const [cmd, state] of Object.entries(states)) {
      const btn = $('#noteToolbar button[data-cmd="' + cmd + '"]');
      if (btn) btn.classList.toggle('is-on', document.queryCommandState(state));
    }
  });

  // 选中文字浮动工具栏：mouseup/键盘选择时显示（比 selectionchange 可靠）
  const selToolbar = $('#selToolbar');

  function showSelToolbar() {
    const editor = richEditor();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed
      || !editor.contains(sel.anchorNode) || !sel.toString().trim()) {
      selToolbar.hidden = true;
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height) {
      selToolbar.hidden = true;
      return;
    }
    selToolbar.hidden = false;
    const half = selToolbar.offsetWidth / 2;
    selToolbar.style.top = Math.max(8, rect.top - 56) + 'px';
    selToolbar.style.left = Math.min(
      Math.max(8, rect.left + rect.width / 2 - half),
      window.innerWidth - selToolbar.offsetWidth - 8
    ) + 'px';
  }

  document.addEventListener('mouseup', (e) => {
    if (richEditor().contains(e.target)) showSelToolbar();
  });
  richEditor().addEventListener('keyup', (e) => {
    // Shift+方向键 / Ctrl+A 等键盘选择
    if (e.shiftKey || e.ctrlKey) showSelToolbar();
  });
  richEditor().addEventListener('mousedown', () => {
    selToolbar.hidden = true; // 开始新的选择，等 mouseup 再显示
  });
  document.addEventListener('selectionchange', () => {
    const editor = richEditor();
    const sel = window.getSelection();
    if (selToolbar.hidden) return;
    if (!sel || !sel.rangeCount || sel.isCollapsed || !editor.contains(sel.anchorNode)) {
      selToolbar.hidden = true;
    }
  });
  selToolbar.addEventListener('mousedown', (e) => {
    e.preventDefault(); // 保持选区与光标
  });
  selToolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.cmd) execEditorCommand(btn.dataset.cmd);
    else if (btn.dataset.level) richExec('formatBlock', '<' + btn.dataset.level + '>');
    selToolbar.hidden = true;
  });

  // 插入下拉菜单
  const insertMenu = $('#insertMenu');
  $('#insertBtn').addEventListener('mousedown', (e) => {
    e.preventDefault();
    insertMenu.hidden = !insertMenu.hidden;
  });
  insertMenu.addEventListener('mousedown', (e) => {
    const btn = e.target.closest('button[data-insert]');
    if (!btn || btn.disabled) return;
    e.preventDefault();
    insertMenu.hidden = true;
    if (btn.dataset.insert === 'image') {
      $('#insertImageInput').click();
      return;
    }
    execEditorCommand(btn.dataset.insert);
  });
  document.addEventListener('mousedown', (e) => {
    if (!insertMenu.hidden && !$('#insertWrap').contains(e.target)) insertMenu.hidden = true;
  });

  // 插入链接面板
  const linkOverlay = $('#linkDialogOverlay');
  const linkConfirm = $('#linkConfirmBtn');
  $('#linkUrl').addEventListener('input', () => {
    linkConfirm.disabled = !$('#linkUrl').value.trim();
  });
  $('#linkText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#linkUrl').focus(); }
  });
  $('#linkUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !linkConfirm.disabled) { e.preventDefault(); confirmLinkDialog(); }
  });
  linkConfirm.addEventListener('click', confirmLinkDialog);
  $('#linkCancelBtn').addEventListener('click', closeLinkDialog);
  linkOverlay.addEventListener('mousedown', (e) => {
    if (e.target === linkOverlay) closeLinkDialog();
  });

  // 预览目录点击：平滑滚动到对应标题并高亮一下
  $('#notePreview').addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('flash-target');
    setTimeout(() => target.classList.remove('flash-target'), 1200);
  });

  // 编辑器内点击目录锚点：滚动到对应标题
  richEditor().addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const target = richEditor().querySelector(a.getAttribute('href'));
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('flash-target');
    setTimeout(() => target.classList.remove('flash-target'), 1200);
  });

  // 插入图片：选完文件转 base64 写入编辑器
  $('#insertImageInput').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    let pending = files.length;
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          richExec('insertHTML', '<img src="' + reader.result + '" alt="' + escapeHtml(file.name) + '"><p><br></p>');
        }
        if (--pending === 0) richEditor().focus();
      };
      reader.readAsDataURL(file);
    }
  });
}

async function init() {
  state.items = await loadItems();
  state.groups = await loadGroups();

  // 数据目录搬过位置 → 条目里还存着旧的绝对路径，按磁盘上的真实位置校正一遍（一次性自愈）
  const fixedPaths = await repairItemPaths();
  if (fixedPaths) {
    showToast(`已修正 ${fixedPaths} 个文件的路径（数据目录搬过位置）`, { duration: 7000 });
  }

  await migrateMusicGroups();
  installVideoFullscreenIntercept();
  initTheaterResize();
  renderFolders();
  renderGrid();
  initEvents();
  restoreMetaPanelState();
  restorePanelFoldState();
  initCapture();

  // 启动稳定之后再去修历史遗留的超大缩略图（首次会提示一条，之后都是空跑）
  setTimeout(() => { repairThumbnails().catch(() => {}); }, 1500);

  // 该功能上线前导入的资源还在旧位置：首次启动自动整理一次（只跑一次）
  if (!localStorage.getItem(ORGANIZED_KEY)) {
    localStorage.setItem(ORGANIZED_KEY, '1');
    setTimeout(() => { organizeLibrary(true).catch(() => {}); }, 800);
  }
}

init().catch((err) => {
  console.error('初始化失败:', err);
  showToast('初始化失败，请检查浏览器权限');
});
