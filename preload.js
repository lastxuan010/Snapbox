const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  // 拿到拖入/选择文件的磁盘绝对路径
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch (err) {
      return '';
    }
  },
  // 按路径读取文件为 data URL（渲染进程无权直接读磁盘，由主进程代读）
  readFileDataUrl: (filePath) => ipcRenderer.invoke('read-file-data-url', filePath),
  // 检查原路径文件是否存在
  checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
  // 复制图片（data URL）到系统剪贴板
  copyImage: (dataUrl) => ipcRenderer.invoke('copy-image', dataUrl),
  // 在资源管理器中显示文件
  showInExplorer: (filePath) => ipcRenderer.invoke('show-in-explorer', filePath),
  // 把文件移入回收站
  trashFile: (filePath) => ipcRenderer.invoke('trash-file', filePath),
  // 把库内备份（data URL）落盘为真实文件，返回其路径（group 决定放进哪个分组文件夹）
  ensureBackup: (id, dataUrl, group) => ipcRenderer.invoke('ensure-backup', { id, dataUrl, group }),
  // 确保分组文件夹存在
  ensureGroupFolder: (group) => ipcRenderer.invoke('ensure-group-folder', { group }),
  // 把文件放进"该分组对应的资源子文件夹"（group 为空 → library 根目录），返回库内新路径
  // mode: 'move' | 'copy'
  placeMediaFile: (id, sourcePath, group, mode) => ipcRenderer.invoke('place-media-file', { id, sourcePath, group, mode }),
  // 撤销导入：把库内文件挪回原位
  undoImportFiles: (items) => ipcRenderer.invoke('undo-import-files', { items }),
  // 在资源管理器中打开某个分组的文件夹
  openLibraryFolder: (group) => ipcRenderer.invoke('open-library-folder', { group }),
  // 清理 library 下的空文件夹
  pruneLibraryFolders: () => ipcRenderer.invoke('prune-library-folders'),
  // 弹出系统保存对话框写文本文件（导出 HTML 等）
  saveTextFile: (payload) => ipcRenderer.invoke('save-text-file', payload),
  // 复制富文本（HTML + 纯文本）到剪贴板
  copyRichText: (html, text) => ipcRenderer.invoke('copy-rich-text', { html, text }),
  // 连按两下 J：收起窗口（恢复由主进程的全局快捷键接管）
  hideWindowWithHotkey: () => ipcRenderer.send('window-hide-hotkey'),
  // 把一批条目打包成 zip（存到 library/zip/），返回压缩包路径
  archiveItems: (payload) => ipcRenderer.invoke('archive-items', payload),
  // 打开压缩包文件夹（library/zip）
  openZipFolder: () => ipcRenderer.invoke('open-zip-folder'),
  // 打包进度回调（覆盖式注册，始终只保留最后一个）
  onArchiveProgress: (cb) => {
    ipcRenderer.removeAllListeners('archive-progress');
    ipcRenderer.on('archive-progress', (event, payload) => cb(payload));
  }
});
