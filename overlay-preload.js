const { contextBridge, ipcRenderer } = require('electron');

// 框选遮罩窗口 与 录屏指示灯窗口 共用的桥接层
contextBridge.exposeInMainWorld('captureOverlay', {
  // 框选完成：坐标为遮罩窗口内的 CSS 像素 + 遮罩窗口自身的尺寸（主进程据此换算物理像素）
  finish: (payload) => ipcRenderer.send('region-result', payload),
  // 取消框选
  cancel: () => ipcRenderer.send('region-result', null),
  // 指示灯上的「停止」按钮
  stop: () => ipcRenderer.send('indicator-stop')
});
