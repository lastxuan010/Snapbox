const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, dialog, globalShortcut,
  desktopCapturer, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');

// 打包库按需加载：万一它加载不了，也只影响"压缩备份"这一个功能，不会拖垮整个应用启动
let archiverLib = null;
function getArchiver() {
  if (!archiverLib) archiverLib = require('archiver');
  return archiverLib;
}

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.mid': 'audio/midi',
  '.m4b': 'audio/mp4'
};

// 主窗口引用：截图框选遮罩、录屏指示灯都是独立窗口，
// 不能再靠"取第 0 个窗口"来给界面发消息
let appWindow = null;

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#f5f5f7',
    show: false
  });

  appWindow = mainWindow;
  mainWindow.on('closed', () => {
    if (appWindow === mainWindow) appWindow = null;
    // 贴图是主界面的附属，主窗口关掉就把它们一起收掉，否则程序会一直留在屏幕上不走
    closeAllPins();
    hideRecordingIndicator();
    hideRecordingFrame();
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 用任务栏 / Alt+Tab 等方式把窗口拉回来时，立刻释放全局 J，别影响别处打字
  mainWindow.on('restore', () => disarmRestoreHotkey());
  mainWindow.on('show', () => disarmRestoreHotkey());
  mainWindow.on('focus', () => disarmRestoreHotkey());

}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on('window-minimize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.minimize();
});

ipcMain.on('window-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
});

ipcMain.on('window-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});

// ---------- Shift+Z：收起窗口 / 再按一次恢复 ----------
// 窗口收起后渲染进程收不到键盘事件，所以"恢复"只能由全局快捷键接管；
// 且只在窗口被这样收起期间注册，一恢复就注销，避免长期占用组合键。
const HIDE_HOTKEY = 'Shift+Z';
let restoreHotkeyArmed = false;

function disarmRestoreHotkey() {
  if (!restoreHotkeyArmed) return;
  restoreHotkeyArmed = false;
  try {
    globalShortcut.unregister(HIDE_HOTKEY);
  } catch (_) { /* ignore */ }
}

function restoreFromHotkey(win) {
  disarmRestoreHotkey();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function armRestoreHotkey(win) {
  if (restoreHotkeyArmed) return;
  restoreHotkeyArmed = true;

  const ok = globalShortcut.register(HIDE_HOTKEY, () => restoreFromHotkey(win));

  if (!ok) {
    // 注册不上也不影响：还能用任务栏把窗口点回来
    restoreHotkeyArmed = false;
    console.warn('[hotkey] 全局 ' + HIDE_HOTKEY + ' 注册失败，请用任务栏恢复窗口');
  }
}

ipcMain.on('window-hide-hotkey', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  win.minimize();
  armRestoreHotkey(win);
});

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
  } catch (_) { /* ignore */ }
});

// 读取任意本地路径文件，返回 data URL（供"路径引用"模式按需加载预览）
ipcMain.handle('read-file-data-url', (event, filePath) => {
  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext] || 'application/octet-stream';
    return { ok: true, dataUrl: `data:${mime};base64,${buffer.toString('base64')}` };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 检查原路径文件是否仍存在
ipcMain.handle('check-file-exists', (event, filePath) => {
  try {
    return { ok: fs.existsSync(filePath) };
  } catch (err) {
    return { ok: false };
  }
});

// 把图片（data URL）写入系统剪贴板
ipcMain.handle('copy-image', (event, dataUrl) => {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) return { ok: false, error: 'empty image' };
    clipboard.writeImage(image);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 在资源管理器中显示文件
ipcMain.handle('show-in-explorer', (event, filePath) => {
  try {
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 把文件移入回收站（比直接删除安全，可恢复）
ipcMain.handle('trash-file', async (event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 确保库内备份落盘为真实文件（用户数据目录/library/<id>.<ext>），返回路径
// 已存在则直接返回，实现"首次点击时导出"
ipcMain.handle('ensure-backup', (event, { id, dataUrl, group }) => {
  try {
    const match = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
    if (!match) return { ok: false, error: 'bad data url' };
    const mime = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const extMap = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
      'video/quicktime': '.mov',
      'video/x-msvideo': '.avi',
      'video/x-matroska': '.mkv',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'audio/flac': '.flac',
      'audio/mp4': '.m4a',
      'audio/aac': '.aac',
      'audio/ogg': '.ogg',
      'audio/opus': '.opus',
      'audio/x-ms-wma': '.wma',
      'audio/aiff': '.aiff'
    };
    const ext = extMap[mime] || '.bin';
    const dir = groupDir(group, true); // 放进该分组对应的文件夹
    const file = path.join(dir, `${id}${ext}`);
    if (!fs.existsSync(file)) fs.writeFileSync(file, buffer);
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---------- 资源目录：library/<分组名>/<id>.<ext> ----------

function libraryRoot() {
  return path.join(app.getPath('userData'), 'library');
}

// 分组名 → 合法文件夹名（去掉 Windows 非法字符、首尾点/空格）
function sanitizeFolderName(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 64)
    .trim();
}

// 分组文件夹的绝对路径（group 为空 → library 根目录）；create 为 true 时确保存在
function groupDir(group, create = false) {
  const folder = sanitizeFolderName(group);
  const dir = folder ? path.join(libraryRoot(), folder) : libraryRoot();
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function moveFileInto(sourcePath, target) {
  if (path.resolve(sourcePath) === path.resolve(target)) return;
  try {
    fs.renameSync(sourcePath, target);
  } catch (renameErr) {
    // 跨盘移动会抛 EXDEV，退回"复制 + 删除原文件"
    fs.copyFileSync(sourcePath, target);
    fs.unlinkSync(sourcePath);
  }
}

// 把文件放进"该分组对应的子文件夹"，返回库内新路径
// mode: 'move'（默认，移动原文件）| 'copy'（复制一份，原文件留在原处）
ipcMain.handle('place-media-file', (event, { id, sourcePath, group, mode }) => {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { ok: false, error: '文件不存在' };
    }
    const dir = groupDir(group, true);
    const ext = path.extname(sourcePath) || '.bin';
    const target = path.join(dir, `${id}${ext}`);

    if (path.resolve(target) === path.resolve(sourcePath)) {
      return { ok: true, path: target, unchanged: true };
    }
    if (fs.existsSync(target)) fs.unlinkSync(target);

    if (mode === 'copy') {
      fs.copyFileSync(sourcePath, target);
      return { ok: true, path: target, copied: true };
    }
    moveFileInto(sourcePath, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 撤销导入：把库内文件挪回原位（供 toast 上的"撤销"使用）
ipcMain.handle('undo-import-files', (event, { items }) => {
  try {
    let restored = 0;
    let failed = 0;
    for (const entry of (items || [])) {
      const from = entry && entry.libraryPath;
      const to = entry && entry.originalPath;
      if (!from || !to || !fs.existsSync(from)) { failed++; continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      if (fs.existsSync(to)) fs.unlinkSync(to);
      moveFileInto(from, to);
      restored++;
    }
    return { ok: true, restored, failed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 确保某个分组的文件夹存在（新建/重命名分组时调用，不打开资源管理器）
ipcMain.handle('ensure-group-folder', (event, payload) => {
  try {
    const dir = groupDir(payload && payload.group, true);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 在资源管理器中打开某个分组的文件夹（不存在则先创建）
ipcMain.handle('open-library-folder', (event, payload) => {
  try {
    const dir = groupDir(payload && payload.group, true);
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 清理 library 下的空子文件夹（移动 / 重命名 / 删除分组后调用）
ipcMain.handle('prune-library-folders', () => {
  try {
    const root = libraryRoot();
    if (!fs.existsSync(root)) return { ok: true, removed: 0 };
    let removed = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        removed++;
      }
    }
    return { ok: true, removed };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 保存文本文件：弹出系统保存对话框（用于笔记导出 HTML 等）
ipcMain.handle('save-text-file', async (event, { defaultName, content }) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName || 'export.html',
      properties: ['createDirectory', 'showOverwriteConfirmation']
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, content, 'utf-8');
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// 复制富文本（HTML + 纯文本）到剪贴板，可粘贴到公众号/知乎等平台
ipcMain.handle('copy-rich-text', (event, { html, text }) => {
  try {
    clipboard.write({ html: html || '', text: text || '' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

// ---------- 压缩备份：library/zip/<分组名>.zip ----------

function zipDir(create = false) {
  const dir = path.join(libraryRoot(), 'zip');
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 库内文件索引：<id>.<ext> 的 id → 绝对路径（扫描 library 根目录与各分组文件夹，跳过 zip 自身）
function buildLibraryIndex() {
  const index = new Map();
  const scan = (dir) => {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (_) {
      return;
    }
    for (const file of files) {
      const dot = file.indexOf('.');
      if (dot <= 0) continue;
      const key = file.slice(0, dot);
      if (!index.has(key)) index.set(key, path.join(dir, file));
    }
  };

  scan(libraryRoot());
  try {
    for (const entry of fs.readdirSync(libraryRoot(), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'zip') scan(path.join(libraryRoot(), entry.name));
    }
  } catch (_) { /* library 还没建 */ }
  return index;
}

// 压缩包内的文件名：去非法字符 + 重名自动加序号
function uniqueEntryName(name, used) {
  let base = String(name || 'file')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!base) base = 'file';

  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';

  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem} (${n})${ext}`;
    n++;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function timeStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 把一批条目打包成 library/zip/<label>.zip
// items: [{ kind: 'file', id, name, path } | { kind: 'note', title, html }]
ipcMain.handle('archive-items', async (event, payload) => {
  const items = (payload && payload.items) || [];
  const label = sanitizeFolderName(payload && payload.label) || '备份';
  let target = '';

  try {
    if (!items.length) return { ok: false, error: '没有可打包的内容' };

    const dir = zipDir(true);
    target = path.join(dir, `${label}.zip`);
    // 同名压缩包已存在时保留旧的那份，本次加时间戳，避免备份互相覆盖
    if (fs.existsSync(target)) target = path.join(dir, `${label}_${timeStamp()}.zip`);

    const index = buildLibraryIndex();
    const used = new Set();
    const entries = [];
    const missing = [];

    for (const it of items) {
      if (it.kind === 'note') {
        entries.push({
          entryName: uniqueEntryName((it.title || '未命名笔记') + '.html', used),
          html: it.html || ''
        });
        continue;
      }
      const file = [it.path, index.get(it.id)]
        .filter(Boolean)
        .find((p) => {
          try {
            return fs.statSync(p).isFile();
          } catch (_) {
            return false;
          }
        });
      if (!file) {
        missing.push(it.name || it.id);
        continue;
      }
      entries.push({ entryName: uniqueEntryName(it.name || path.basename(file), used), file });
    }

    if (!entries.length) {
      return { ok: false, error: '所选内容的文件都不在磁盘上了', missing };
    }

    const archiver = getArchiver();
    const output = fs.createWriteStream(target);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const finished = new Promise((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', (err) => {
        if (err && err.code !== 'ENOENT') reject(err);
      });
    });

    // 进度回传（按"已完成条目数"去重，避免刷屏）
    let lastSent = -1;
    archive.on('progress', (data) => {
      const processed = data && data.entries ? data.entries.processed : 0;
      if (processed === lastSent) return;
      lastSent = processed;
      try {
        event.sender.send('archive-progress', { entries: processed, total: entries.length });
      } catch (_) { /* 窗口可能已关闭 */ }
    });

    archive.pipe(output);
    for (const e of entries) {
      if (e.html !== undefined) archive.append(e.html, { name: e.entryName });
      else archive.file(e.file, { name: e.entryName });
    }

    await archive.finalize();
    await finished;

    return {
      ok: true,
      path: target,
      dir,
      added: entries.length,
      missing,
      size: fs.statSync(target).size
    };
  } catch (err) {
    // 失败时不留半个压缩包
    try {
      if (target && fs.existsSync(target)) fs.unlinkSync(target);
    } catch (_) { /* ignore */ }
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 打开压缩包文件夹（library/zip）
ipcMain.handle('open-zip-folder', () => {
  try {
    const dir = zipDir(true);
    shell.openPath(dir);
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------- 截图 / 录屏（F4 截图 / F6 录屏，录屏含系统声音）----------

// 想换键只改这里：界面上的提示文案会跟着这里走，不会写死
const CAPTURE_HOTKEYS = {
  screenshot: { key: 'F4', fallback: 'Control+F4' },
  record: { key: 'F6', fallback: 'Control+F6' }
};

let captureGroupName = '截图/录屏';

function newCaptureId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// 截"指定屏幕"的原生分辨率画面（可按选区裁剪），返回 nativeImage；失败返回 null
// region: pickRegion() 的结果（不传或 full=true 就是整屏）
async function captureRegionImage(region) {
  // 框选遮罩刚关掉，等它从屏幕上彻底消失再截，免得把遮罩一起拍进去
  await new Promise((resolve) => setTimeout(resolve, 250));

  const display = (region && region.displayId
    && screen.getAllDisplays().find((d) => String(d.id) === String(region.displayId)))
    || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.round(display.size.width * scale),
      height: Math.round(display.size.height * scale)
    }
  });
  if (!sources.length) return null;

  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  let image = source.thumbnail;

  // 按选区裁剪：遮罩给的是 CSS 像素，用"实际图像宽度 / 遮罩宽度"换算成像素再裁
  if (region && !region.full && region.screenWidth > 0 && !image.isEmpty()) {
    const img = image.getSize();
    const k = img.width / region.screenWidth;
    const x = Math.max(0, Math.min(Math.round(region.x * k), Math.max(0, img.width - 1)));
    const y = Math.max(0, Math.min(Math.round(region.y * k), Math.max(0, img.height - 1)));
    const width = Math.max(1, Math.min(Math.round(region.width * k), img.width - x));
    const height = Math.max(1, Math.min(Math.round(region.height * k), img.height - y));
    image = image.crop({ x, y, width, height });
  }
  return image;
}

// 截当前屏幕（可按选区裁剪），返回 PNG 字节
// （入库与落盘统一由渲染进程走 save-capture，和录屏共用一条路径）
ipcMain.handle('capture-screen', async (event, region) => {
  try {
    const image = await captureRegionImage(region);
    if (!image || image.isEmpty()) return { ok: false, error: '没有找到可截取的屏幕' };

    const size = image.getSize();
    const buffer = image.toPNG();

    return {
      ok: true,
      bytes: new Uint8Array(buffer),
      width: size.width,
      height: size.height,
      size: buffer.length
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------- 贴图：把截图钉在屏幕上（像 Snipaste 那样） ----------
const pinWindows = new Map(); // webContents.id → { win, image, pxW, pxH, dipW0, dipH0 }

function pinEntryOf(event) {
  return pinWindows.get(event.sender.id) || null;
}

function closeAllPins() {
  for (const entry of [...pinWindows.values()]) {
    if (entry.win && !entry.win.isDestroyed()) entry.win.close();
  }
  pinWindows.clear();
}

function createImagePin(image, region) {
  const size = image.getSize();
  if (!size.width || !size.height) return null;

  const display = (region && region.displayId
    && screen.getAllDisplays().find((d) => String(d.id) === String(region.displayId)))
    || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;

  // 屏幕坐标用 DIP：窗口尺寸 = 物理像素 ÷ 缩放比，这样贴出来的图跟你框的一样大
  const dipW = Math.max(24, Math.round(size.width / scale));
  const dipH = Math.max(24, Math.round(size.height / scale));

  // 默认就贴在原来框选的位置（所以看起来像"选区留在了屏幕上"）；整屏截图则居中
  const clampX = (v) => Math.round(Math.max(display.bounds.x, Math.min(v, display.bounds.x + display.size.width - dipW)));
  const clampY = (v) => Math.round(Math.max(display.bounds.y, Math.min(v, display.bounds.y + display.size.height - dipH)));
  const hasRect = region && !region.full && typeof region.x === 'number';
  const x = clampX(display.bounds.x + (hasRect ? region.x : Math.round((display.size.width - dipW) / 2)));
  const y = clampY(display.bounds.y + (hasRect ? region.y : Math.round((display.size.height - dipH) / 2)));

  const win = new BrowserWindow({
    x,
    y,
    width: dipW,
    height: dipH,
    frame: false,
    // 贴图本身就是一块矩形，不需要透明窗。
    // 透明（分层）窗口在 Windows 上每次改尺寸都要重新合成整窗，滚轮缩放时会一闪一闪的 —— 实测不透明窗就顺了
    transparent: false,
    backgroundColor: '#1d1d1f',
    hasShadow: false,
    resizable: false,   // 缩放走滚轮（要按光标位置缩放，交给主进程算）
    movable: false,     // 拖动也自己实现，否则 -webkit-app-region 会把滚轮事件一起吃掉
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,   // 不抢焦点，不然点一下贴图就打断你在别处的工作
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'pin-preload.js')
    }
  });

  const key = win.webContents.id;
  pinWindows.set(key, {
    win, image, pxW: size.width, pxH: size.height,
    dipW0: dipW, dipH0: dipH,
    // 缩放用浮点记住"逻辑尺寸"，只有写进窗口那一刻才取整
    scaleW: dipW, scaleH: dipH,
    // 外框与内容区的差值（无边框窗在 Windows 上也可能差 1~3px），缩放时要补回去
    padX: 0, padY: 0
  });

  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { /* ignore */ }
  win.loadFile(path.join(__dirname, 'pin-image.html'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;

    // 让"内容区"严格等于选区的 DIP 尺寸：
    // Windows 会按 DPI 网格微调窗口尺寸（实测要 300 高给了 303），差这点图就会被拉伸
    const fitContent = () => {
      try {
        const inner = win.getContentBounds ? win.getContentBounds() : win.getBounds();
        const dw = dipW - inner.width;
        const dh = dipH - inner.height;
        if (!dw && !dh) return;
        const cur = win.getBounds();
        win.setBounds({ x: cur.x, y: cur.y, width: cur.width + dw, height: cur.height + dh });
      } catch (_) { /* ignore */ }
    };
    // 量出来的"外框-内容"固定差值，缩放时要补回去
    const recordPad = () => {
      try {
        const entry = pinWindows.get(key);
        if (!entry) return;
        const outer = win.getBounds();
        const inner = win.getContentBounds ? win.getContentBounds() : outer;
        entry.padX = Math.max(0, outer.width - inner.width);
        entry.padY = Math.max(0, outer.height - inner.height);
      } catch (_) { /* ignore */ }
    };

    fitContent();
    win.showInactive();
    // setBounds 生效有延迟，稍后再校一次
    setTimeout(() => { if (!win.isDestroyed()) { fitContent(); recordPad(); } }, 90);
  });
  win.on('closed', () => { pinWindows.delete(key); });
  return win;
}

// 框选之后的动作：复制到剪贴板 / 固定到屏幕上（保存走渲染端的原有流程）
ipcMain.handle('region-action', async (event, payload) => {
  const region = (payload && payload.region) || null;
  const action = (payload && payload.action) || 'copy';
  try {
    const image = await captureRegionImage(region);
    if (!image || image.isEmpty()) return { ok: false, error: '没有截到画面' };

    if (action === 'copy') {
      clipboard.writeImage(image);
      const size = image.getSize();
      return { ok: true, action, width: size.width, height: size.height };
    }

    if (action === 'pin') {
      const win = createImagePin(image, region);
      return win ? { ok: true, action } : { ok: false, error: '贴图窗口创建失败' };
    }

    return { ok: false, error: '未知动作：' + action };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 贴图窗口取图（data URL + 原始像素尺寸）
ipcMain.handle('pin-get-image', (event) => {
  const entry = pinEntryOf(event);
  if (!entry) return { ok: false };
  return { ok: true, dataUrl: entry.image.toDataURL(), width: entry.pxW, height: entry.pxH };
});

// 拖动移动（增量由渲染端按屏幕坐标算好）
ipcMain.on('pin-move', (event, delta) => {
  const entry = pinEntryOf(event);
  if (!entry || entry.win.isDestroyed()) return;
  const dx = Math.round((delta && delta.dx) || 0);
  const dy = Math.round((delta && delta.dy) || 0);
  if (!dx && !dy) return;
  const b = entry.win.getBounds();
  entry.win.setBounds({ x: b.x + dx, y: b.y + dy, width: b.width, height: b.height });
});

// 滚轮缩放：以光标为锚点，保证光标下的那个点不动（和 Snipaste 一致）
ipcMain.on('pin-scale', (event, payload) => {
  const entry = pinEntryOf(event);
  if (!entry || entry.win.isDestroyed()) return;
  const factor = Number(payload && payload.factor) || 1;
  if (factor === 1) return;

  // 逻辑尺寸用浮点累乘：小倍率如果每步都取整会被吃掉，看起来就像"滚了没反应"
  const minW = 40;
  const maxW = entry.dipW0 * 4;
  const nextW = Math.max(minW, Math.min(maxW, entry.scaleW * factor));
  if (nextW === entry.scaleW) return;
  entry.scaleW = nextW;
  entry.scaleH = entry.dipH0 * (nextW / entry.dipW0);

  // 锚点按"内容区"算：页面里量到的尺寸就是内容区
  const padX = entry.padX || 0;
  const padY = entry.padY || 0;
  const contentW = Math.max(24, Math.round(entry.scaleW));
  const contentH = Math.max(16, Math.round(entry.scaleH));
  const inner = (entry.win.getContentBounds && entry.win.getContentBounds()) || entry.win.getBounds();
  const cursor = screen.getCursorScreenPoint();
  const relX = inner.width ? (cursor.x - inner.x) / inner.width : 0.5;
  const relY = inner.height ? (cursor.y - inner.y) / inner.height : 0.5;

  entry.win.setBounds({
    x: Math.round(cursor.x - relX * contentW - padX / 2),
    y: Math.round(cursor.y - relY * contentH - padY / 2),
    width: contentW + padX,
    height: contentH + padY
  });
});

// Ctrl+滚轮：调透明度
ipcMain.on('pin-opacity', (event, value) => {
  const entry = pinEntryOf(event);
  if (!entry || entry.win.isDestroyed()) return;
  const v = Math.max(0.15, Math.min(1, Number(value) || 1));
  entry.win.setOpacity(v);
});

ipcMain.on('pin-close', (event) => {
  const entry = pinEntryOf(event);
  if (entry && !entry.win.isDestroyed()) entry.win.close();
});

ipcMain.handle('pin-copy', (event) => {
  const entry = pinEntryOf(event);
  if (!entry) return { ok: false, error: '贴图已不存在' };
  clipboard.writeImage(entry.image);
  return { ok: true };
});

// 贴图窗口点「保存」：主进程写进分组文件夹，再让主界面登记成条目
ipcMain.handle('pin-save', (event) => {
  const entry = pinEntryOf(event);
  if (!entry) return { ok: false, error: '贴图已不存在' };
  try {
    const id = newCaptureId();
    const dir = groupDir(captureGroupName, true);
    const file = path.join(dir, `${id}.png`);
    const buffer = entry.image.toPNG();
    fs.writeFileSync(file, buffer);
    sendToRenderer('register-capture', { kind: 'image', id, path: file, size: buffer.length });
    return { ok: true, path: file, size: buffer.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 录屏要用的桌面源 id。
// 说明：这里给的是 Electron 传统桌面采集（renderer 里 getUserMedia + chromeMediaSource:'desktop'）用的源，
// 因为实测 getDisplayMedia 在当前环境里几乎不出帧（3 秒 0~2 帧），传统方式同样条件能到 20+ fps
ipcMain.handle('get-capture-source', async () => {
  try {
    const display = (captureDisplayId
      && screen.getAllDisplays().find((d) => String(d.id) === String(captureDisplayId)))
      || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 180 }
    });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source) return { ok: false, error: '没有找到可录制的屏幕' };
    return {
      ok: true,
      id: source.id,
      name: source.name,
      displayId: String(display.id),
      width: display.size.width,
      height: display.size.height,
      scaleFactor: display.scaleFactor || 1
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

function sendToRenderer(channel, payload) {
  const win = appWindow;
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// 注册截图/录屏热键：主键被别的程序占用时自动降级到 Ctrl+ 组合，并告诉界面
function registerCaptureHotkey(accelerator, fallback, handler, label) {
  if (globalShortcut.register(accelerator, handler)) return accelerator;

  if (globalShortcut.register(fallback, handler)) {
    console.warn('[capture] ' + accelerator + ' 被占用，已改用 ' + fallback);
    setTimeout(() => sendToRenderer('capture-hotkey-notice', {
      message: label + ' 快捷键 ' + accelerator + ' 被其他程序占用，已临时改成 ' + fallback
    }), 2000);
    return fallback;
  }

  console.warn('[capture] ' + accelerator + ' 与 ' + fallback + ' 都注册失败');
  setTimeout(() => sendToRenderer('capture-hotkey-notice', {
    message: label + ' 快捷键注册失败（' + accelerator + ' 被其他程序占用）'
  }), 2000);
  return '';
}

// 渲染进程会告诉主进程"截图/录屏存哪个分组"
ipcMain.on('set-capture-group', (event, name) => {
  const clean = String(name == null ? '' : name).trim();
  if (clean) captureGroupName = clean;
});

// ---------- 给录屏的 webm 补上时长 ----------
// MediaRecorder 边录边写，一开始不知道总时长，所以写出来的 webm 没有 Duration 元素，
// 播放器读到的时长是 ∞、进度条也拖不动。这里把时长补回去。
//
// 为什么能"插进去就不管了"：
//   1) Duration 只能放在 Info 里，所以在 Info 末尾插一个 11 字节的 Duration 元素
//      （ID 2 字节 + 长度 1 字节 + float64 8 字节），再把 Info 的长度字段加上对应字节数；
//   2) MediaRecorder 写的 Segment 是"未知长度"，不用同步改；
//   3) 文件里没有 SeekHead / Cues（它们存的是绝对偏移，插字节后会指错），
//      真有的话这里会直接放弃修改，宁可保持原样也不写出坏文件。
function encodeEbmlSize(value, len) {
  const max = Math.pow(2, 7 * len) - 2;
  if (!(value >= 0) || value > max) return null;
  const out = Buffer.alloc(len);
  let v = value;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0] |= 1 << (8 - len);
  return out;
}

function readEbmlElement(buf, pos) {
  if (pos < 0 || pos >= buf.length) return null;
  const first = buf[pos];
  if (!first) return null;

  let idLen = 1;
  for (let i = 0; i < 4; i++) {
    if (first & (0x80 >> i)) { idLen = i + 1; break; }
  }
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];

  const sizeFirst = buf[pos + idLen];
  if (sizeFirst === undefined || sizeFirst === 0) return null;
  let sizeLen = 1;
  for (let i = 0; i < 8; i++) {
    if (sizeFirst & (0x80 >> i)) { sizeLen = i + 1; break; }
  }
  let size = sizeFirst & (0xFF >> sizeLen);
  let allOnes = size === (0xFF >> sizeLen);
  for (let i = 1; i < sizeLen; i++) {
    const b = buf[pos + idLen + i];
    size = size * 256 + b;
    if (b !== 0xFF) allOnes = false;
  }
  const dataStart = pos + idLen + sizeLen;
  return {
    id, idLen, sizeLen,
    pos,
    sizePos: pos + idLen,
    dataStart,
    size: allOnes ? null : size,
    dataEnd: allOnes ? buf.length : Math.min(buf.length, dataStart + size)
  };
}

function patchWebmDuration(buf, durationMs) {
  try {
    const ebml = readEbmlElement(buf, 0);
    if (!ebml || ebml.id !== 0x1A45DFA3) return buf;           // EBML
    const seg = readEbmlElement(buf, ebml.dataEnd);
    if (!seg || seg.id !== 0x18538067) return buf;             // Segment

    // 找 Info；顺带确认没有偏移表（有就放弃，免得改坏）
    let info = null;
    let pos = seg.dataStart;
    while (pos < seg.dataEnd) {
      const el = readEbmlElement(buf, pos);
      if (!el || el.dataEnd <= pos) return buf;
      if (el.id === 0x114D9B74 || el.id === 0x1C53BB6B) {      // SeekHead / Cues
        console.warn('[capture] webm 里带偏移表，跳过补时长');
        return buf;
      }
      if (el.id === 0x1549A966) { info = el; break; }          // Info
      pos = el.dataEnd;
    }
    if (!info || info.size === null) return buf;

    // Info 里已经有 Duration 就不重复写
    let timecodeScale = 1000000;
    for (let p = info.dataStart; p < info.dataEnd;) {
      const c = readEbmlElement(buf, p);
      if (!c || c.dataEnd <= p) break;
      if (c.id === 0x4489) return buf;                         // Duration 已存在
      if (c.id === 0x2AD7B1 && c.size) timecodeScale = buf.readUIntBE(c.dataStart, c.size);
      p = c.dataEnd;
    }

    const dur = Buffer.alloc(11);
    dur.writeUInt16BE(0x4489, 0);
    dur.writeUInt8(0x88, 2);                                   // 长度字段：8 字节
    // Duration 的单位是 TimecodeScale（默认 1000000ns，也就是 1ms）
    dur.writeDoubleBE(Math.max(1, durationMs) * 1e6 / timecodeScale, 3);

    const infoData = Buffer.concat([buf.subarray(info.dataStart, info.dataEnd), dur]);
    let sizeBuf = encodeEbmlSize(infoData.length, info.sizeLen);
    for (let len = info.sizeLen + 1; !sizeBuf && len <= 8; len++) {
      sizeBuf = encodeEbmlSize(infoData.length, len);
    }
    if (!sizeBuf) return buf;

    const delta = (info.idLen + sizeBuf.length + infoData.length)
      - (info.idLen + info.sizeLen + info.size);

    const before = Buffer.from(buf.subarray(0, info.pos));      // 拷贝一份，便于顺带改 Segment 长度
    if (seg.size !== null) {
      const segSizeBuf = encodeEbmlSize(seg.size + delta, seg.sizeLen);
      if (!segSizeBuf) return buf;
      before.set(segSizeBuf, seg.sizePos);
    }

    return Buffer.concat([
      before,
      buf.subarray(info.pos, info.pos + info.idLen),
      sizeBuf,
      infoData,
      buf.subarray(info.dataEnd)
    ]);
  } catch (err) {
    console.warn('[capture] 补 webm 时长失败：' + ((err && err.message) || err));
    return buf;
  }
}

// 录屏由渲染进程（MediaRecorder）产出，这里只负责写进分组文件夹
ipcMain.handle('save-capture', (event, payload) => {
  try {
    const id = (payload && payload.id) || newCaptureId();
    const ext = (payload && payload.ext) || '.bin';
    const bytes = (payload && payload.bytes) || [];
    let buffer = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    // 录屏的 webm 补上时长头，否则播放器显示 ∞、进度条拖不动
    if (ext === '.webm' && payload && payload.durationMs > 0) {
      buffer = patchWebmDuration(buffer, payload.durationMs);
    }
    const dir = groupDir(captureGroupName, true);
    const file = path.join(dir, `${id}${ext}`);
    fs.writeFileSync(file, buffer);
    return { ok: true, id, path: file, size: buffer.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ---------- 区域框选：一块全屏遮罩，让用户拖个矩形出来 ----------
let regionPicker = null;
let regionPickerResolve = null;
let regionPickerDisplayId = '';
// 最近一次框选所在的屏幕：录屏时优先用它，避免鼠标移开导致录错屏
let captureDisplayId = '';

function regionPickerActive() {
  return Boolean(regionPicker && !regionPicker.isDestroyed());
}

function closeRegionPicker(result) {
  const win = regionPicker;
  const resolve = regionPickerResolve;
  regionPicker = null;
  regionPickerResolve = null;
  regionPickerDisplayId = '';
  if (win && !win.isDestroyed()) win.close();
  if (resolve) resolve(result || null);
}

// 打开遮罩让用户框选，resolve 出选区（坐标为遮罩窗口内的 CSS 像素）；取消则 resolve null
// mode: 'shot' 显示操作条（复制/保存/固定），'record' 只用来框选录屏范围
function pickRegion(mode) {
  return new Promise((resolve) => {
    if (regionPickerActive()) closeRegionPicker(null);

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'overlay-preload.js')
      }
    });

    regionPicker = win;
    regionPickerResolve = resolve;
    regionPickerDisplayId = String(display.id);
    captureDisplayId = String(display.id);

    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { /* ignore */ }
    win.loadFile(path.join(__dirname, 'region-select.html'), {
      query: { mode: mode === 'record' ? 'record' : 'shot' }
    });
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return;
      // 窗口刚创建时会被系统压到"工作区"大小（盖不住任务栏），这里再放开到整块屏幕
      try { win.setBounds(display.bounds); } catch (_) { /* ignore */ }
      win.show();
      win.focus();
    });
    // 窗口被意外关掉也按"取消"处理，别让 Promise 永远挂着
    win.on('closed', () => {
      if (regionPicker === win) {
        const pending = regionPickerResolve;
        regionPicker = null;
        regionPickerResolve = null;
        if (pending) pending(null);
      }
    });
  });
}

ipcMain.handle('pick-region', (event, mode) => pickRegion(mode));

ipcMain.on('region-result', (event, payload) => {
  if (!regionPickerActive()) return;
  closeRegionPicker(payload ? { ...payload, displayId: regionPickerDisplayId } : null);
});

// ---------- 录屏指示灯：常驻置顶的小药丸，明确告诉你"正在录屏" ----------
let indicatorWindow = null;

function showRecordingIndicator() {
  if (indicatorWindow && !indicatorWindow.isDestroyed()) return;

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = 236;
  const height = 54;
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(display.workArea.x + display.workArea.width - width - 18),
    y: Math.round(display.workArea.y + display.workArea.height - height - 18),
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false, // 不抢焦点，别打断正在录的操作
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.js')
    }
  });

  indicatorWindow = win;
  try {
    // 关键：把这个窗口从任何录屏/截图里排除掉，否则它会出现在录出来的画面里
    win.setContentProtection(true);
  } catch (_) { /* 老系统不支持，就只能被录进去了 */ }
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { /* ignore */ }
  win.loadFile(path.join(__dirname, 'recording-indicator.html'));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  win.on('closed', () => {
    if (indicatorWindow === win) indicatorWindow = null;
  });
}

function hideRecordingIndicator() {
  const win = indicatorWindow;
  indicatorWindow = null;
  if (win && !win.isDestroyed()) win.close();
}

// ---------- 录制范围标线：把用户框的那块用一圈红线标出来 ----------
let recordingFrame = null;

function showRecordingFrame(region) {
  // 整屏录制就不用画了（没有"范围"可言）
  if (!region || region.full || !region.width || !region.height) return null;
  if (recordingFrame && !recordingFrame.isDestroyed()) return recordingFrame;

  const display = (region.displayId
    && screen.getAllDisplays().find((d) => String(d.id) === String(region.displayId)))
    || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());

  // 框选给的就是 DIP 坐标；窗口再向外扩 PAD，让这圈线完全落在录制范围之外
  const PAD = 4;
  const x = Math.round(display.bounds.x + region.x) - PAD;
  const y = Math.round(display.bounds.y + region.y) - PAD;
  const width = Math.round(region.width) + PAD * 2;
  const height = Math.round(region.height) + PAD * 2;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    transparent: true,   // 只有这圈线可见，中间要透出被录的内容
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'overlay-preload.js')
    }
  });

  recordingFrame = win;
  try { win.setContentProtection(true); } catch (_) { /* ignore */ }
  try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { /* ignore */ }
  // 关键：整窗鼠标穿透，不然会挡住被录的内容，用户点不动里面
  try { win.setIgnoreMouseEvents(true); } catch (_) { /* ignore */ }
  win.loadFile(path.join(__dirname, 'recording-frame.html'));
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  win.on('closed', () => { if (recordingFrame === win) recordingFrame = null; });
  return win;
}

function hideRecordingFrame() {
  const win = recordingFrame;
  recordingFrame = null;
  if (win && !win.isDestroyed()) win.close();
}

ipcMain.on('recording-state', (event, on, region) => {
  // 只认主窗口的信号（遮罩/指示灯窗口自己发的消息不作数）
  const from = BrowserWindow.fromWebContents(event.sender);
  if (from && appWindow && from.id !== appWindow.id) return;
  if (on) {
    showRecordingIndicator();
    showRecordingFrame(region);
  } else {
    hideRecordingIndicator();
    hideRecordingFrame();
  }
});

// 指示灯上的「停止」按钮：和再按一次热键等价
ipcMain.on('indicator-stop', () => {
  sendToRenderer('capture-toggle-recording');
});

app.whenReady().then(() => {
  // 录屏不弹选择框，直接用鼠标所在的那块屏幕，并带上系统声音（回环采集）
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((list) => {
          const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
          // 优先用刚框选过的那块屏，避免框选之后鼠标移开、录到另一块屏
          const wanted = captureDisplayId;
          const source = (wanted && list.find((s) => String(s.display_id) === String(wanted)))
            || list.find((s) => String(s.display_id) === String(display.id))
            || list[0];
          if (!source) return callback({});

          const grant = { video: source };
          // 回环采集：把扬声器正在播放的声音一起录进去（不用麦克风，也不会录到环境噪音）
          // 只有 Windows 原生支持；其它平台硬塞会直接导致录制失败，所以不塞
          if (process.platform === 'win32' && !(request && request.audioRequested === false)) {
            grant.audio = 'loopback';
          }
          callback(grant);
        })
        .catch(() => callback({}));
    });
  } catch (err) {
    console.warn('[capture] 录屏源处理器设置失败：' + err);
  }

  // 全局注册，App 不在前台也能用
  // 框选过程中再按热键 = 取消框选（否则会以为按键没反应）
  const activeHotkeys = {
    screenshot: registerCaptureHotkey(
      CAPTURE_HOTKEYS.screenshot.key,
      CAPTURE_HOTKEYS.screenshot.fallback,
      () => {
        if (regionPickerActive()) closeRegionPicker(null);
        else sendToRenderer('capture-take-screenshot');
      },
      '截图'
    ),
    record: registerCaptureHotkey(
      CAPTURE_HOTKEYS.record.key,
      CAPTURE_HOTKEYS.record.fallback,
      () => {
        if (regionPickerActive()) closeRegionPicker(null);
        else sendToRenderer('capture-toggle-recording');
      },
      '录屏'
    )
  };
  // 把最终生效的键告诉界面，提示文案才不会和实际按键脱节
  setTimeout(() => sendToRenderer('capture-hotkeys', activeHotkeys), 1500);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
