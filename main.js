const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

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
ipcMain.handle('ensure-backup', (event, { id, dataUrl }) => {
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
    const dir = path.join(app.getPath('userData'), 'library');
    fs.mkdirSync(dir, { recursive: true });
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
ipcMain.handle('place-media-file', (event, { id, sourcePath, group }) => {
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
    moveFileInto(sourcePath, target);
    return { ok: true, path: target };
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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
