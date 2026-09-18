const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, dialog, globalShortcut,
  desktopCapturer, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------- 数据目录 ----------
// 资源库 / 分组 / 设置 / 缩略图缓存全在这一个目录里。
// 默认是 %APPDATA%\media-archive —— 显式钉死（打包后 productName 会改变 Electron 默认的
// userData 名称，换个显示名不该让老用户的库"消失"）。
// 用户可以在「设置 → 数据目录」里把它改到别的盘（比如 D 盘）。
// 指针写在固定的 %APPDATA%\Snapbox\config.json —— 特意放在数据目录"外面"，
// 否则数据目录一搬走，指针就跟着一起搬走了，下次启动会找不到。
// 优先级：环境变量 SNAPBOX_DATA > 指针文件 > 默认位置。
const DEFAULT_DATA_DIR = path.join(app.getPath('appData'), 'media-archive');
const LOCATOR_DIR = path.join(app.getPath('appData'), 'Snapbox');
const LOCATOR_FILE = path.join(LOCATOR_DIR, 'config.json');

// 给界面看的状态：当前用哪个目录、来自哪里、要不要提醒用户
const dataDirState = {
  dir: DEFAULT_DATA_DIR,
  source: 'default',   // 'default' | 'config' | 'env'
  warning: '',         // 例如"设置的目录不可用，已临时用默认位置"
  pendingDir: '',      // 本次运行里改了、但还没重启生效的目录
  needSetup: false     // 首次启动、还没决定放哪儿 → 启动后弹一次向导
};

function readLocator() {
  try {
    const raw = JSON.parse(fs.readFileSync(LOCATOR_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch (_) {
    return null;
  }
}

function writeLocator(obj) {
  try {
    fs.mkdirSync(LOCATOR_DIR, { recursive: true });
    fs.writeFileSync(LOCATOR_FILE, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

// 目录能不能用：能创建、能写入。真写一个探测文件，避免"看着在但只读"（U 盘写保护、网络盘掉线）
function dirUsable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.snapbox-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

// b 是否在 a 里面（含相等）
function isInside(a, b) {
  const rel = path.relative(path.resolve(a), path.resolve(b));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// 整份搬移：先复制，成功了才删源目录 —— 中途失败不会两边都不全
function moveDataDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
  fs.rmSync(from, { recursive: true, force: true });
}

// 执行上次运行里"待搬移"的请求（用户选了"一起搬过去"）
// 必须在 app ready 之前跑完：Chromium 一旦初始化，Cache / IndexedDB 就被占用，搬不干净
function applyPendingMove() {
  const loc = readLocator();
  if (!loc || !loc.moveFrom || !loc.dataDir) return;

  const from = path.resolve(String(loc.moveFrom));
  const to = path.resolve(String(loc.dataDir));

  // 源已经不存在（搬过了或手动挪走）、或本来就同一个 → 清掉标记直接用目标
  if (from === to || !fs.existsSync(from)) {
    writeLocator({ dataDir: to, setupDone: true });
    return;
  }

  try {
    moveDataDir(from, to);
    writeLocator({ dataDir: to, setupDone: true });
  } catch (err) {
    // 搬移失败：退回原目录，并把原因留下来告诉用户，绝不让人打开后看到空库
    writeLocator({ dataDir: from, setupDone: true, moveError: String((err && err.message) || err) });
  }
}

// 这个目录里已经有东西了吗（老用户 / 之前用过）—— 决定要不要弹首次启动向导
function dirHasData(dir) {
  try {
    return fs.existsSync(path.join(dir, 'library')) || fs.existsSync(path.join(dir, 'IndexedDB'));
  } catch (_) {
    return false;
  }
}

// 真正切过去。必须在建任何窗口、碰 session 之前调用
function applyDataDir() {
  try {
    fs.mkdirSync(dataDirState.dir, { recursive: true });
    app.setPath('userData', dataDirState.dir);
  } catch (_) {
    // 兜底：指不过去就用 Electron 默认目录，别让应用起不来
  }
}

function resolveDataDir() {
  applyPendingMove();

  const loc = readLocator();
  const envDir = String(process.env.SNAPBOX_DATA || '').trim();

  const candidates = [];
  if (envDir) candidates.push({ dir: path.resolve(envDir), source: 'env', label: '环境变量 SNAPBOX_DATA 指定的目录' });
  if (loc && typeof loc.dataDir === 'string' && loc.dataDir.trim()) {
    candidates.push({ dir: path.resolve(loc.dataDir.trim()), source: 'config', label: '设置里指定的数据目录' });
  }
  candidates.push({ dir: DEFAULT_DATA_DIR, source: 'default', label: '默认位置' });

  for (const c of candidates) {
    if (dirUsable(c.dir)) {
      dataDirState.dir = c.dir;
      dataDirState.source = c.source;
      break;
    }
    // 默认位置都写不进去就没什么可回退的了，不用再提示
    if (c.source !== 'default') {
      dataDirState.warning = c.label + '（' + c.dir + '）当前不可用，已临时改用默认位置'
        + ' —— 请检查磁盘是否插好 / 是否被移动，或到「设置 → 数据目录」里改回来';
    }
  }

  const moveError = loc && loc.moveError ? String(loc.moveError) : '';
  if (moveError && !dataDirState.warning) {
    dataDirState.warning = '上次搬移数据目录时出错，已保留原目录：' + moveError;
  }

  // 要不要弹"首次启动：数据放哪"：
  // 没有任何人指定过位置（没有指针、没有环境变量），而且这个位置里也还没有数据。
  // 老用户（目录里已经有 library / IndexedDB）直接跳过，不打扰；问过一次之后
  // setupDone 会写进指针文件，以后永不再问。
  const specified = Boolean(envDir) || Boolean(loc && loc.dataDir);
  dataDirState.needSetup = !(loc && loc.setupDone) && !specified && !dirHasData(dataDirState.dir);

  // 老用户悄悄补一个"已决定"的标记，免得哪天数据被清空又弹出来问
  if (!dataDirState.needSetup && !(loc && loc.setupDone)) {
    writeLocator({ dataDir: dataDirState.dir, setupDone: true });
  }

  applyDataDir();
}

// 首次启动向导：只问这一次。问完写进指针文件，之后再也不会打扰
// 注意：必须在 createWindow / 碰 session.defaultSession 之前执行 —— 否则 Chromium
// 会先把缓存和 IndexedDB 建在旧位置，导致"库文件在新目录、条目索引在旧目录"的分裂
async function runFirstRunSetup() {
  if (!dataDirState.needSetup) return;

  let dir = dataDirState.dir;

  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['就用这里（推荐）', '换个位置…'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Snapbox 首次启动',
    message: '你的文件、分组和备份都会存在这个文件夹里',
    detail: dir + '\n\n只问这一次。以后想换，可以在「设置 → 数据目录」里改。'
  });

  if (res.response === 1) {
    const picked = await dialog.showOpenDialog({
      title: '选择数据存放位置',
      defaultPath: app.getPath('home'),
      buttonLabel: '用这个文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    if (!picked.canceled && picked.filePaths.length) {
      const check = validateDataTarget(picked.filePaths[0]);
      if (check.ok) {
        dir = check.dir;
      } else {
        await dialog.showMessageBox({
          type: 'warning',
          buttons: ['知道了'],
          noLink: true,
          message: '这个位置不能用，先按默认位置继续',
          detail: check.error + '\n\n之后可以在「设置 → 数据目录」里再改。'
        });
      }
    }
  }

  dataDirState.dir = dir;
  dataDirState.source = path.resolve(dir) === path.resolve(DEFAULT_DATA_DIR) ? 'default' : 'config';
  dataDirState.needSetup = false;
  writeLocator({ dataDir: dir, setupDone: true });
  applyDataDir();
}

resolveDataDir();

const zlib = require('zlib');

// 少占内存：这个应用完全用不到的 Chromium 常驻服务全部关掉（每个都会占一块内存和后台线程）
app.commandLine.appendSwitch('disable-features', [
  'MediaRouter',                  // 投屏
  'Translate',                    // 网页翻译
  'BackForwardCache',             // 前进/后退缓存（本地应用没有页面导航）
  'OptimizationHints',            // 联网获取站点优化提示
  'InterestFeedContentSuggestions',
  'AutofillServerCommunication',  // 表单自动填充联网
  'SegmentationPlatform',
  'FederatedLearningOfCohorts',
  'PrivacySandboxSettings4'
].join(','));

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

// Windows 任务栏靠 AppUserModelID 关联应用（dev 模式下图标才认得准）
if (process.platform === 'win32') app.setAppUserModelId('com.traedesign.snapbox');

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // 应用图标（任务栏、窗口左上角）；源图是 webp，已转成 assets/app-icon.png
    icon: path.join(__dirname, 'assets', 'app-icon.png'),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // 不加载拼写检查词典（省内存；界面是中文，笔记也不需要英文红波浪线）
      spellcheck: false,
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

app.whenReady().then(async () => {
  // 首次启动：先问一次"数据放哪儿"。必须在碰 session / 建窗口之前
  await runFirstRunSetup();

  // 双保险：拼写检查器在 session 层也关掉
  try { session.defaultSession.setSpellCheckerEnabled(false); } catch (_) { /* ignore */ }

  // 录屏源 + 全局热键（也要等数据目录定下来再碰 session）
  setupCaptureFeatures();

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

// 用系统默认程序打开文件（PDF / Office 文档交给 Adobe / Office / WPS，保真度最高）
ipcMain.handle('open-external', async (event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '文件不存在' };
    const message = await shell.openPath(filePath);
    return message ? { ok: false, error: message } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
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

// ---------- 粘贴：把剪贴板里的东西导入当前分组 ----------
// 剪贴板里可能是「图片位图」（截图、网页里复制的图）或「资源管理器里复制的文件」。
// 优先取文件：复制的是图片文件时，保留原文件名和原始质量更合适。

// Windows 复制文件时格式是 FileNameW（UTF-16LE，多个路径用 \0 分隔）
function readClipboardFilePaths() {
  try {
    const formats = clipboard.availableFormats() || [];
    if (!formats.some((f) => /FileNameW|FileName|CF_HDROP/i.test(String(f)))) return [];
    const buf = clipboard.read('FileNameW');
    const raw = (buf && buf.length) ? buf : clipboard.read('FileName');
    if (!raw || !raw.length) return [];
    const text = Buffer.from(raw).toString('utf16le');
    return text
      .split('\u0000')
      .map((s) => s.replace(/\u0000/g, '').trim())
      .filter(Boolean)
      .map((p) => {
        try {
          const stat = fs.statSync(p);
          return stat.isFile() ? { path: p, name: path.basename(p), size: stat.size } : null;
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

// 粘贴用的临时目录：剪贴板里的位图没有"原文件"可搬，先落成临时 png 再走正常入库流程
function pasteTempDir(create = false) {
  const dir = path.join(app.getPath('temp'), 'snapbox-paste');
  if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 顺手清掉过期的粘贴临时文件（入库时是"移动"，正常不会留；异常中断才可能有残留）
function prunePasteTemp(olderThanMs) {
  try {
    const dir = pasteTempDir(false);
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > olderThanMs) fs.unlinkSync(file);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
}

function pastedImageName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `粘贴的图片-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

// peek = true 时只探测"剪贴板里有什么"（右键菜单要知道该不该置灰），不落临时文件
ipcMain.handle('paste-clipboard', (event, opts) => {
  try {
    const peek = Boolean(opts && opts.peek);

    const files = readClipboardFilePaths();
    if (files.length) return { ok: true, kind: 'files', files };

    const image = clipboard.readImage();
    if (!image || image.isEmpty()) return { ok: true, kind: 'none' };

    const size = image.getSize();
    const name = pastedImageName();
    if (peek) return { ok: true, kind: 'image', name, width: size.width, height: size.height };

    prunePasteTemp(6 * 60 * 60 * 1000);
    const buffer = image.toPNG();
    const file = path.join(pasteTempDir(true), `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.png`);
    fs.writeFileSync(file, buffer);
    return { ok: true, kind: 'image', name, path: file, size: buffer.length, width: size.width, height: size.height };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 在资源管理器中显示文件
// 路径不存在时必须明确报回来：shell.showItemInFolder 对不存在的路径是静默失败，
// 用户只会看到"点了没反应"，完全不知道发生了什么
ipcMain.handle('show-in-explorer', (event, filePath) => {
  try {
    if (!filePath) return { ok: false, error: '这个条目没有记录文件路径' };
    if (!fs.existsSync(filePath)) {
      return { ok: false, missing: true, error: '文件不在这里了：' + filePath };
    }
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

// ---------- 数据目录：查看 / 更改 / 恢复默认 ----------

// 弹窗的父窗口：不指定的话对话框可能跑到主窗口后面去
function dialogParent(event) {
  return (event && event.sender && BrowserWindow.fromWebContents(event.sender)) || null;
}

// 校验用户挑的目录，返回 { ok:true, dir } 或 { ok:false, error }
function validateDataTarget(input) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: '路径是空的' };

  const target = path.resolve(raw);
  if (target === path.resolve(dataDirState.dir)) return { ok: false, error: '这就是当前正在用的数据目录' };
  if (isInside(dataDirState.dir, target)) {
    return { ok: false, error: '不能设在当前数据目录里面（搬移时会自己套自己）' };
  }
  try {
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
      return { ok: false, error: '这个路径不是文件夹' };
    }
  } catch (_) { /* 探测不了就交给下面的可写性检查 */ }
  if (!dirUsable(target)) {
    return { ok: false, error: '这个位置不能写入（可能是只读、权限不足，或者磁盘没插好）' };
  }

  return { ok: true, dir: target };
}

// 问"现有数据怎么办"：一起搬 / 只换位置 / 取消。返回 true / false / null(取消)
async function askMoveOrNot(win, targetDir) {
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['一起搬过去（推荐）', '只换位置', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
    message: '数据目录改为：\n' + targetDir,
    detail: '「一起搬过去」：现有的文件、分组、设置、缩略图缓存会在下次启动时整体搬过去，'
      + '库大的话启动会慢一会儿（只搬这一次）。\n'
      + '「只换位置」：新位置从空库开始，原位置的数据原样保留、不会被删。'
  });
  if (res.response === 2) return null;
  return res.response === 0;
}

// 问"现在重启吗"；选立即重启就直接重启（搬移在下次启动时执行，必须在 ready 之前跑）
async function askRestart(win) {
  const res = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['立即重启', '稍后自己重启'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: '设置已保存，重启后生效',
    detail: '重启后应用会使用新的数据目录'
  });
  if (res.response === 0) {
    app.relaunch();
    app.exit(0);
  }
}

ipcMain.handle('get-data-dir', () => ({
  ok: true,
  dir: dataDirState.pendingDir || dataDirState.dir,
  currentDir: dataDirState.dir,
  defaultDir: DEFAULT_DATA_DIR,
  locatorFile: LOCATOR_FILE,
  source: dataDirState.source,
  envOverride: String(process.env.SNAPBOX_DATA || '').trim(),
  warning: dataDirState.warning,
  pending: Boolean(dataDirState.pendingDir)
}));

ipcMain.handle('open-data-dir', async () => {
  const err = await shell.openPath(dataDirState.dir);
  return { ok: !err, error: err || '' };
});

// 复制一段纯文本（设置里的数据目录路径点一下就能复制走）
ipcMain.handle('copy-text', (event, text) => {
  try {
    clipboard.writeText(String(text || ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('choose-data-dir', async (event) => {
  const win = dialogParent(event);
  const picked = await dialog.showOpenDialog(win, {
    title: '选择数据目录（文件、分组、备份都会存到这里）',
    defaultPath: dataDirState.dir,
    buttonLabel: '用这个文件夹',
    properties: ['openDirectory', 'createDirectory']
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, canceled: true };

  const check = validateDataTarget(picked.filePaths[0]);
  if (!check.ok) return { ok: false, error: check.error };

  const move = await askMoveOrNot(win, check.dir);
  if (move === null) return { ok: false, canceled: true };

  const wrote = writeLocator(move
    ? { dataDir: check.dir, setupDone: true, moveFrom: dataDirState.dir }
    : { dataDir: check.dir, setupDone: true });
  if (!wrote) return { ok: false, error: '写设置失败：' + LOCATOR_FILE };

  dataDirState.pendingDir = check.dir;
  await askRestart(win);
  return { ok: true, dir: check.dir, move, needsRestart: true };
});

ipcMain.handle('reset-data-dir', async (event) => {
  if (path.resolve(dataDirState.dir) === path.resolve(DEFAULT_DATA_DIR)) {
    return { ok: false, error: '已经在默认位置了' };
  }
  const win = dialogParent(event);

  const move = await askMoveOrNot(win, DEFAULT_DATA_DIR);
  if (move === null) return { ok: false, canceled: true };

  const wrote = writeLocator(move
    ? { dataDir: DEFAULT_DATA_DIR, setupDone: true, moveFrom: dataDirState.dir }
    : { dataDir: DEFAULT_DATA_DIR, setupDone: true });
  if (!wrote) return { ok: false, error: '写设置失败：' + LOCATOR_FILE };

  dataDirState.pendingDir = DEFAULT_DATA_DIR;
  await askRestart(win);
  return { ok: true, dir: DEFAULT_DATA_DIR, move, needsRestart: true };
});

// 库内文件索引（id → 真实绝对路径）：给渲染进程校正条目里存的旧路径用。
// 数据目录搬走后条目里还是老路径，靠这份"以磁盘为准"的索引自愈
ipcMain.handle('get-library-index', () => {
  try {
    const files = {};
    for (const [id, absPath] of buildLibraryIndex()) files[id] = absPath;
    return { ok: true, files, root: libraryRoot() };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
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

// ---------- 内置 ZIP 写入器 ----------
// 原来用 archiver，但它拉进来 39 个包、8.5MB（其中 5.2MB 的 bare-* 在 Node 上根本用不到）。
// 备份只需要"deflate 压缩 + 目录名 + UTF-8 文件名"这几件事，用 Node 自带的 zlib 直接写就够了。

const ZIP_CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ ZIP_CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

// 本身已压缩的格式不再二次压缩：省时间，体积几乎一样
const ZIP_STORE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.ico', '.heic',
  '.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.wmv', '.flv',
  '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wma',
  '.zip', '.7z', '.rar', '.gz', '.pdf', '.docx', '.xlsx', '.pptx', '.apk'
]);

const ZIP_DOS_EPOCH = new Date(1980, 0, 1);

function zipDosStamp(date) {
  const d = date && date > ZIP_DOS_EPOCH ? date : ZIP_DOS_EPOCH;
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    day: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// files: [{ entryName, file } | { entryName, buffer, mtime?, onProgress? }]
async function writeZip(target, files) {
  const handle = await fs.promises.open(target, 'w');
  const central = [];
  let offset = 0;
  let done = 0;

  try {
    for (const f of files) {
      const fromText = f.buffer !== undefined;
      const data = fromText ? Buffer.from(String(f.buffer), 'utf8') : await fs.promises.readFile(f.file);
      if (data.length >= 0xffffffff) throw new Error(`「${f.entryName}」超过 4GB，暂不支持打包备份`);

      const nameBuf = Buffer.from(f.entryName, 'utf8');
      const store = !fromText && ZIP_STORE_EXT.has(path.extname(f.entryName).toLowerCase());
      const compressed = store ? data : zlib.deflateRawSync(data, { level: 9 });
      const crc = crc32(data);
      const { time, day } = zipDosStamp(new Date());

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);      // 本地文件头
      local.writeUInt16LE(20, 4);              // 解压所需版本 2.0
      local.writeUInt16LE(0x0800, 6);          // 文件名按 UTF-8 解释（中文名不乱码）
      local.writeUInt16LE(store ? 0 : 8, 8);   // 0=存储 8=deflate
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(day, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);              // 扩展字段长度

      await handle.write(local);
      await handle.write(nameBuf);
      await handle.write(compressed);

      central.push({
        nameBuf,
        crc,
        method: store ? 0 : 8,
        time,
        day,
        compressed: compressed.length,
        size: data.length,
        offset
      });

      offset += local.length + nameBuf.length + compressed.length;
      if (offset > 0xffffffff) throw new Error('备份总大小超过 4GB，暂不支持');
      done++;
      if (typeof f.onProgress === 'function') f.onProgress(done, files.length);
    }

    // 中央目录
    const cdStart = offset;
    for (const e of central) {
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(0x02014b50, 0);
      rec.writeUInt16LE(20, 4);                // 创建版本
      rec.writeUInt16LE(20, 6);                // 解压所需版本
      rec.writeUInt16LE(0x0800, 8);
      rec.writeUInt16LE(e.method, 10);
      rec.writeUInt16LE(e.time, 12);
      rec.writeUInt16LE(e.day, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.compressed, 20);
      rec.writeUInt32LE(e.size, 24);
      rec.writeUInt16LE(e.nameBuf.length, 28);
      rec.writeUInt16LE(0, 30);                // 扩展字段
      rec.writeUInt16LE(0, 32);                // 注释
      rec.writeUInt16LE(0, 34);                // 起始磁盘
      rec.writeUInt16LE(0, 36);                // 内部属性
      rec.writeUInt32LE(0, 38);                // 外部属性
      rec.writeUInt32LE(e.offset, 42);
      await handle.write(rec);
      await handle.write(e.nameBuf);
      offset += rec.length + e.nameBuf.length;
    }
    const cdSize = offset - cdStart;

    // 中央目录结束记录
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await handle.write(eocd);
  } finally {
    await handle.close();
  }

  return { entries: central.length };
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

    // 进度回传（按"已完成条目数"去重，避免刷屏）
    let lastSent = -1;
    await writeZip(target, entries.map((e) => ({
      entryName: e.entryName,
      buffer: e.html,
      file: e.html === undefined ? e.file : undefined,
      onProgress: (done, total) => {
        if (done === lastSent) return;
        lastSent = done;
        try {
          event.sender.send('archive-progress', { entries: done, total });
        } catch (_) { /* 窗口可能已关闭 */ }
      }
    })));

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

// ---------- 截图 / 录屏（默认 F4 截图 / F6 录屏，录屏含系统声音）----------

// 快捷键可以在界面「设置」里改，存进 userData/capture-settings.json，下次启动照旧生效
const DEFAULT_CAPTURE_HOTKEYS = { screenshot: 'F4', record: 'F6' };
let captureHotkeys = { ...DEFAULT_CAPTURE_HOTKEYS };
// 实际注册成功的键（被别的程序占用时会降级成 Ctrl+ 组合）
let registeredCaptureKeys = { screenshot: '', record: '' };

function captureSettingsPath() {
  return path.join(app.getPath('userData'), 'capture-settings.json');
}

function loadCaptureHotkeys() {
  try {
    const raw = JSON.parse(fs.readFileSync(captureSettingsPath(), 'utf8'));
    for (const which of ['screenshot', 'record']) {
      if (raw && typeof raw[which] === 'string' && raw[which].trim()) {
        captureHotkeys[which] = raw[which].trim();
      }
    }
  } catch (_) { /* 文件不存在或坏了就用默认值 */ }
}

function saveCaptureHotkeys() {
  try {
    fs.writeFileSync(captureSettingsPath(), JSON.stringify(captureHotkeys, null, 2), 'utf8');
  } catch (err) {
    console.warn('[capture] 快捷键设置保存失败：' + err);
  }
}

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
    // 位置同样用浮点累加：系统会把窗口坐标取整，读回来再加增量每次都丢一点（实测每挪一次丢 1px）
    posX: x, posY: y,
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
    setTimeout(() => {
      if (win.isDestroyed()) return;
      fitContent();
      recordPad();
      // 校正过窗口尺寸后，把浮点位置也对齐到实际值，免得第一次拖动跳一下
      const entry = pinWindows.get(key);
      if (entry) {
        const cur = win.getBounds();
        entry.posX = cur.x;
        entry.posY = cur.y;
      }
    }, 90);
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
  // 尺寸必须用"记住的目标尺寸"重新写一遍，不能把 getBounds() 读回来的值再写回去：
  // 125% 这类非整数缩放下，系统会按物理像素网格把窗口尺寸取整，读回来的值已经被取整过，
  // 于是误差每挪一次累积一次 —— 实测 40 次拖动后内容区从 400x300 变成 452x336，
  // 图被 object-fit: contain 放大，看起来就是"拖动时被放大"。
  // 每次都写目标尺寸，取整误差就不会累积（实测 40 次后内容区仍是 400x300）。
  const contentW = Math.max(24, Math.round(entry.scaleW));
  const contentH = Math.max(16, Math.round(entry.scaleH));
  // 位置同理：用浮点累加再取整，不然每次都被系统取整，拖着会跟不上鼠标
  entry.posX = (Number.isFinite(entry.posX) ? entry.posX : b.x) + dx;
  entry.posY = (Number.isFinite(entry.posY) ? entry.posY : b.y) + dy;
  entry.win.setBounds({
    x: Math.round(entry.posX),
    y: Math.round(entry.posY),
    width: contentW + (entry.padX || 0),
    height: contentH + (entry.padY || 0)
  });
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

  // 缩放后位置变了，浮点位置要跟着同步，否则接下来第一次拖动会跳一下
  entry.posX = cursor.x - relX * contentW - padX / 2;
  entry.posY = cursor.y - relY * contentH - padY / 2;
  entry.win.setBounds({
    x: Math.round(entry.posX),
    y: Math.round(entry.posY),
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

// 按当前设置注册截图/录屏热键；改键时重新调用（会先注销上一批）
function registerCaptureHotkeys() {
  for (const which of ['screenshot', 'record']) {
    const key = registeredCaptureKeys[which];
    if (!key) continue;
    try { globalShortcut.unregister(key); } catch (_) { /* ignore */ }
    registeredCaptureKeys[which] = '';
  }

  const handlers = {
    // 框选过程中再按热键 = 取消框选（否则会以为按键没反应）
    screenshot: () => {
      if (regionPickerActive()) closeRegionPicker(null);
      else sendToRenderer('capture-take-screenshot');
    },
    record: () => {
      if (regionPickerActive()) closeRegionPicker(null);
      else sendToRenderer('capture-toggle-recording');
    }
  };
  const labels = { screenshot: '截图', record: '录屏' };

  for (const which of ['screenshot', 'record']) {
    const key = captureHotkeys[which];
    // 单键（如 F4）被占用时自动降级为 Ctrl+ 组合；用户自己设的组合键就不再降级
    const fallback = /\+/.test(key) ? key : 'Control+' + key;
    registeredCaptureKeys[which] = registerCaptureHotkey(key, fallback, handlers[which], labels[which]);
  }

  // 把最终生效的键告诉界面，提示文案才不会和实际按键脱节
  sendToRenderer('capture-hotkeys', { ...registeredCaptureKeys });
  return { ...registeredCaptureKeys };
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

// 录屏源处理器 + 全局热键。等数据目录定下来之后再跑：
// 它会碰 session.defaultSession，而一碰 Chromium 就会在"当时那个 userData"里建缓存和 IndexedDB
function setupCaptureFeatures() {
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

  // 全局注册，App 不在前台也能用（键值来自用户在「设置」里保存的值）
  loadCaptureHotkeys();
  registerCaptureHotkeys();
  // 界面这时可能还没加载完，稍后再补推一次，提示文案才不会和实际按键脱节
  setTimeout(() => sendToRenderer('capture-hotkeys', { ...registeredCaptureKeys }), 1500);
}

// 界面「设置」：读当前快捷键
ipcMain.handle('get-capture-hotkeys', () => ({
  ok: true,
  configured: { ...captureHotkeys },
  active: { ...registeredCaptureKeys },
  defaults: { ...DEFAULT_CAPTURE_HOTKEYS }
}));

// 界面「设置」：改快捷键（先试着注册，注册不上就回滚这一项）
ipcMain.handle('set-capture-hotkeys', (event, payload) => {
  const prev = { ...captureHotkeys };
  for (const which of ['screenshot', 'record']) {
    const value = payload && typeof payload[which] === 'string' ? payload[which].trim() : '';
    if (value) captureHotkeys[which] = value;
  }

  let active = registerCaptureHotkeys();
  const failed = [];
  for (const which of ['screenshot', 'record']) {
    if (!active[which]) {
      failed.push((which === 'screenshot' ? '截图' : '录屏') + ' ' + captureHotkeys[which] + ' 注册不上（可能被别的程序占用）');
      captureHotkeys[which] = prev[which];
    }
  }
  // 有失败的项就按回滚后的值再注册一次
  if (failed.length) active = registerCaptureHotkeys();

  saveCaptureHotkeys();
  return { ok: failed.length === 0, active, configured: { ...captureHotkeys }, failed };
});

// 打开设置面板时先停掉全局热键：否则"按下想设置的键"会先触发截图/录屏
ipcMain.handle('pause-capture-hotkeys', (event, paused) => {
  if (!paused) return { ok: true, active: registerCaptureHotkeys() };
  for (const which of ['screenshot', 'record']) {
    const key = registeredCaptureKeys[which];
    if (!key) continue;
    try { globalShortcut.unregister(key); } catch (_) { /* ignore */ }
    registeredCaptureKeys[which] = '';
  }
  return { ok: true, active: { ...registeredCaptureKeys } };
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
