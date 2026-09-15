// 贴图窗口：拖动移动、滚轮缩放、Ctrl+滚轮调透明度、双击关闭（对齐 Snipaste 的操作习惯）
const shotEl = document.getElementById('shot');
const barEl = document.getElementById('bar');
const hintEl = document.getElementById('hint');

const HINT_TEXT = hintEl.textContent;
let dragging = false;
let lastX = 0;
let lastY = 0;
let opacity = 1;
let hintTimer = null;

// 一格标准滚轮（deltaY≈100）大约缩放 10%，于是：
// 连续的小 delta 会得到连续的小缩放，触控板也不会一跳一跳的
const ZOOM_K = Math.log(1.1) / 100;
let pendingZoom = 0;
let zoomFrame = null;

// 主进程把图给过来；窗口太小时不显示悬浮控件，免得把图盖住
window.pinAPI.getImage().then((res) => {
  if (res && res.ok) shotEl.src = res.dataUrl;
}).catch(() => { /* 拿不到就是空白贴图 */ });

function fitChrome() {
  const small = window.innerWidth < 150 || window.innerHeight < 96;
  barEl.hidden = small;
  hintEl.hidden = small;
}
fitChrome();
window.addEventListener('resize', fitChrome);

function flash(text) {
  hintEl.hidden = false;
  hintEl.textContent = text;
  hintEl.classList.add('is-on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    hintEl.classList.remove('is-on');
    hintEl.textContent = HINT_TEXT;
    fitChrome();
  }, 1700);
}

// 拖动：按屏幕坐标算增量交给主进程挪窗口（窗口跟着鼠标走，光标始终在窗口内）
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest('#bar')) return;
  dragging = true;
  lastX = e.screenX;
  lastY = e.screenY;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const dx = e.screenX - lastX;
  const dy = e.screenY - lastY;
  if (!dx && !dy) return;
  lastX = e.screenX;
  lastY = e.screenY;
  window.pinAPI.move(dx, dy);
});

window.addEventListener('mouseup', () => { dragging = false; });

// 滚轮：缩放；按住 Ctrl = 调透明度
window.addEventListener('wheel', (e) => {
  e.preventDefault();

  if (e.ctrlKey) {
    const next = opacity + (e.deltaY < 0 ? 0.08 : -0.08);
    opacity = Math.max(0.15, Math.min(1, Math.round(next * 100) / 100));
    window.pinAPI.setOpacity(opacity);
    flash('不透明度 ' + Math.round(opacity * 100) + '%');
    return;
  }

  // 把不同 deltaMode 统一成像素，先累加、每帧只发一次，
  // 免得高频滚轮事件把 IPC 和窗口 setBounds 刷爆
  const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? window.innerHeight : 1);
  pendingZoom += e.deltaY * unit;
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = null;
    const delta = pendingZoom;
    pendingZoom = 0;
    if (!delta) return;
    window.pinAPI.scale(Math.exp(-delta * ZOOM_K));
  });
}, { passive: false });

window.addEventListener('dblclick', (e) => {
  if (e.target.closest && e.target.closest('#bar')) return;
  window.pinAPI.close();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pinAPI.close();
});

document.getElementById('closeBtn').addEventListener('click', () => window.pinAPI.close());

document.getElementById('copyBtn').addEventListener('click', async () => {
  const res = await window.pinAPI.copy();
  flash(res && res.ok ? '已复制到剪贴板' : ('复制失败：' + ((res && res.error) || '未知错误')));
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const res = await window.pinAPI.save();
  flash(res && res.ok ? '已存入「截图/录屏」' : ('保存失败：' + ((res && res.error) || '未知错误')));
});
