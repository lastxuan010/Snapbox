// 区域框选遮罩：拖动框选 → 可移动/改大小 → Enter 保存、F3 固定到屏幕、Esc 取消
// 坐标一律用"遮罩窗口内的 CSS 像素"，主进程拿到遮罩窗口尺寸后再换算成物理像素
const boxEl = document.getElementById('box');
const veilEl = document.getElementById('veil');
const sizeEl = document.getElementById('size');
const toolsEl = document.getElementById('tools');
const fullBtn = document.getElementById('fullBtn');

// 截图模式带操作条（复制/保存/固定）；录屏模式只用来框范围
const MODE = new URLSearchParams(location.search).get('mode') === 'record' ? 'record' : 'shot';

const DPR = window.devicePixelRatio || 1;
const MIN = 8; // 小于这个尺寸视为"只是点了一下"，不算选中

let rect = null;          // { x, y, w, h }
let mode = null;          // 'new' | 'move' | 'resize'
let activeDir = '';
let startPt = { x: 0, y: 0 };
let baseRect = null;

const clamp = (v, min, max) => Math.max(min, Math.min(v, max));
const W = () => window.innerWidth;
const H = () => window.innerHeight;

function normalize(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1)
  };
}

function paint() {
  if (!rect || rect.w < 1 || rect.h < 1) {
    veilEl.hidden = false;
    boxEl.hidden = true;
    sizeEl.hidden = true;
    toolsEl.hidden = true;
    return;
  }

  veilEl.hidden = true;
  boxEl.hidden = false;
  boxEl.style.left = rect.x + 'px';
  boxEl.style.top = rect.y + 'px';
  boxEl.style.width = rect.w + 'px';
  boxEl.style.height = rect.h + 'px';

  sizeEl.hidden = false;
  sizeEl.textContent = Math.round(rect.w * DPR) + ' × ' + Math.round(rect.h * DPR) + ' px';
  const below = rect.y + rect.h + 34 < H();
  sizeEl.style.left = clamp(rect.x, 4, Math.max(4, W() - 130)) + 'px';
  sizeEl.style.top = (below ? rect.y + rect.h + 8 : Math.max(4, rect.y - 26)) + 'px';

  // 操作条贴在选区右下角；放不下就翻到选区上方
  if (MODE !== 'shot') {
    toolsEl.hidden = true;
    return;
  }
  toolsEl.hidden = false;
  const tw = toolsEl.offsetWidth || 260;
  const th = toolsEl.offsetHeight || 32;
  const canBelow = rect.y + rect.h + th + 10 < H();
  toolsEl.style.left = clamp(rect.x + rect.w - tw, 4, Math.max(4, W() - tw - 4)) + 'px';
  toolsEl.style.top = (canBelow ? rect.y + rect.h + 8 : Math.max(4, rect.y - th - 8)) + 'px';
}

function pointOf(e) {
  return { x: e.clientX, y: e.clientY };
}

window.addEventListener('mousedown', (e) => {
  if (e.button === 2) { cancel('右键'); return; }    // 右键 = 取消
  if (e.button !== 0) return;
  // 顶栏和操作条上的按钮自己处理，别当成"开始框选"
  if (e.target.closest && e.target.closest('#tip, #tools')) return;

  const p = pointOf(e);
  const dir = (e.target.dataset && e.target.dataset.dir) || '';

  if (dir) {
    mode = 'resize';
    activeDir = dir;
  } else if (rect && p.x >= rect.x && p.x <= rect.x + rect.w && p.y >= rect.y && p.y <= rect.y + rect.h) {
    mode = 'move';
  } else {
    mode = 'new';
    rect = { x: p.x, y: p.y, w: 0, h: 0 };
  }

  startPt = p;
  baseRect = rect ? { ...rect } : null;
  paint();
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!mode) return;
  const p = pointOf(e);

  if (mode === 'new') {
    rect = normalize(startPt.x, startPt.y, p.x, p.y);
  } else if (mode === 'move') {
    const dx = p.x - startPt.x;
    const dy = p.y - startPt.y;
    rect = {
      x: clamp(baseRect.x + dx, 0, Math.max(0, W() - baseRect.w)),
      y: clamp(baseRect.y + dy, 0, Math.max(0, H() - baseRect.h)),
      w: baseRect.w,
      h: baseRect.h
    };
  } else {
    const b = baseRect;
    let x1 = b.x;
    let y1 = b.y;
    let x2 = b.x + b.w;
    let y2 = b.y + b.h;
    if (activeDir.indexOf('w') >= 0) x1 = clamp(p.x, 0, x2 - MIN);
    if (activeDir.indexOf('e') >= 0) x2 = clamp(p.x, x1 + MIN, W());
    if (activeDir.indexOf('n') >= 0) y1 = clamp(p.y, 0, y2 - MIN);
    if (activeDir.indexOf('s') >= 0) y2 = clamp(p.y, y1 + MIN, H());
    rect = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  paint();
});

window.addEventListener('mouseup', () => {
  if (!mode) return;
  mode = null;
  activeDir = '';
  // 只是点了一下、没真拖动 → 当作没选中，允许重新框
  if (rect && (rect.w < MIN || rect.h < MIN)) rect = null;
  paint();
});

// 双击选区内部 = 保存
window.addEventListener('dblclick', (e) => {
  if (e.target.closest && e.target.closest('#tip, #tools')) return;
  if (rect) confirm(false, 'save');
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cancel('Esc'); return; }
  if (e.key === 'Enter') { e.preventDefault(); confirm(false, 'save'); return; }
  if (e.key === ' ') { e.preventDefault(); confirm(true, 'save'); return; }  // 空格 = 整屏
  if (e.key === 'F3') { e.preventDefault(); confirm(false, 'pin'); return; }  // F3 = 固定到屏幕
  if (MODE !== 'shot') return;
  const key = String(e.key || '').toLowerCase();
  if (key === 'c') { e.preventDefault(); confirm(false, 'copy'); }            // C = 复制
  else if (key === 'p') { e.preventDefault(); confirm(false, 'pin'); }
});

fullBtn.addEventListener('click', () => confirm(true, 'save'));

// 操作条按钮
toolsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  e.stopPropagation();
  const act = btn.dataset.act;
  if (act === 'cancel') cancel('点了取消按钮');
  else confirm(false, act);
});

// action: 'save' 存进库里 / 'copy' 复制到剪贴板 / 'pin' 固定到屏幕上
function confirm(full, action) {
  const base = { screenWidth: W(), screenHeight: H(), devicePixelRatio: DPR, action: action || 'save' };
  if (full || !rect || rect.w < MIN || rect.h < MIN) {
    // 什么都没框（或按了整屏）→ 整屏
    window.captureOverlay.finish({ ...base, full: true });
    return;
  }
  window.captureOverlay.finish({
    ...base,
    full: false,
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.w),
    height: Math.round(rect.h)
  });
}

// 记录取消来源：这个遮罩是全屏的，万一"莫名其妙没了"，日志里能直接看出是谁干的
function cancel(reason) {
  console.log('[capture] 取消框选：' + (reason || '未知'));
  window.captureOverlay.cancel();
}

paint();
