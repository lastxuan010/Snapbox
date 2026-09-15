const { contextBridge, ipcRenderer } = require('electron');

// 贴图窗口的桥接层
contextBridge.exposeInMainWorld('pinAPI', {
  // 取要贴的图（data URL + 原始像素尺寸）
  getImage: () => ipcRenderer.invoke('pin-get-image'),
  // 拖动：增量按屏幕坐标算好交给主进程挪窗口
  move: (dx, dy) => ipcRenderer.send('pin-move', { dx, dy }),
  // 滚轮缩放（主进程会以光标为锚点）
  scale: (factor) => ipcRenderer.send('pin-scale', { factor }),
  // Ctrl+滚轮调透明度
  setOpacity: (value) => ipcRenderer.send('pin-opacity', value),
  // 关闭这张贴图
  close: () => ipcRenderer.send('pin-close'),
  // 复制到剪贴板
  copy: () => ipcRenderer.invoke('pin-copy'),
  // 保存到「截图/录屏」分组
  save: () => ipcRenderer.invoke('pin-save')
});
