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

// 截"鼠标所在那块屏幕"的原生分辨率画面，只负责返回 PNG 字节
// （入库与落盘统一由渲染进程走 save-capture，和录屏共用一条路径）
ipcMain.handle('capture-screen', async () => {
  try {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale)
      }
    });
    if (!sources.length) return { ok: false, error: '没有找到可截取的屏幕' };

    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    const image = source.thumbnail;
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

function sendToRenderer(channel, payload) {
  const win = BrowserWindow.getAllWindows()[0];
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

// 录屏由渲染进程（MediaRecorder）产出，这里只负责写进分组文件夹
ipcMain.handle('save-capture', (event, payload) => {
  try {
    const id = (payload && payload.id) || newCaptureId();
    const ext = (payload && payload.ext) || '.bin';
    const bytes = (payload && payload.bytes) || [];
    const buffer = Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const dir = groupDir(captureGroupName, true);
    const file = path.join(dir, `${id}${ext}`);
    fs.writeFileSync(file, buffer);
    return { ok: true, id, path: file, size: buffer.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

app.whenReady().then(() => {
  // 录屏不弹选择框，直接用鼠标所在的那块屏幕，并带上系统声音（回环采集）
  try {
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen'] })
        .then((list) => {
          const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
          const source = list.find((s) => String(s.display_id) === String(display.id)) || list[0];
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
  const activeHotkeys = {
    screenshot: registerCaptureHotkey(
      CAPTURE_HOTKEYS.screenshot.key,
      CAPTURE_HOTKEYS.screenshot.fallback,
      () => sendToRenderer('capture-take-screenshot'),
      '截图'
    ),
    record: registerCaptureHotkey(
      CAPTURE_HOTKEYS.record.key,
      CAPTURE_HOTKEYS.record.fallback,
      () => sendToRenderer('capture-toggle-recording'),
      '录屏'
    )
  };
  // 把最终生效的键告诉界面，提示文案才不会和实际按键脱节
  setTimeout(() => sendToRenderer('capture-hotkeys', activeHotkeys), 1500);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
