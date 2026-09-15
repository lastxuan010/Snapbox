// 录屏指示灯：红点 + 计时 + 停止按钮（窗口本身会被排除在录制画面之外）
const startedAt = Date.now();
const timeEl = document.getElementById('time');
const stopBtn = document.getElementById('stopBtn');

function tick() {
  const total = Math.floor((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  timeEl.textContent = mm + ':' + ss;
}

tick();
setInterval(tick, 500);

stopBtn.addEventListener('click', () => {
  if (stopBtn.disabled) return;
  stopBtn.disabled = true;
  stopBtn.textContent = '保存中…';
  window.captureOverlay.stop();
});
