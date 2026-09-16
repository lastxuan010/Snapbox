// PDF / Office 文档预览：把几个纯前端库打成一份可直接 <script> 引入的包
// 生成文件：office.bundle.js（命令：npm run build:office）
// 说明：PDF 不走这里 —— 用的是 Chromium 自带阅读器（见 main.js 的 plugins: true）
import { renderAsync } from 'docx-preview';
import * as XLSX from 'xlsx';
import { init as pptxInit } from 'pptx-preview';

// docx → HTML。bodyEl 放正文，styleEl 放该文档自带的样式（分开是为了不污染全局）
async function renderDocx(bytes, bodyEl, styleEl) {
  await renderAsync(new Blob([bytes]), bodyEl, styleEl || bodyEl, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreHeight: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true
  });
  return true;
}

// csv / tsv / txt 是纯文本：先按 UTF-8 解，出现替换字符（U+FFFD）说明是别的编码，再试 GBK
// （国内导出的 CSV 大多是 GBK，直接按字节丢给 XLSX 会整列乱码）
function decodeText(bytes) {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (utf8.indexOf('\uFFFD') === -1) return utf8;
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch (_) {
    return utf8;
  }
}

// xlsx / xls / csv → 纯数据，由渲染端自己画表格（样式统一，几万行也不至于卡死）
function parseXlsx(bytes, name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const isPlainText = ext === 'csv' || ext === 'tsv' || ext === 'txt';
  const wb = isPlainText
    ? XLSX.read(decodeText(bytes), { type: 'string' })
    : XLSX.read(bytes, { type: 'array', cellDates: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false
    });
    return { name: name, rows: rows };
  });
}

// pptx → 渲染到容器里（pptx-preview 按"页"出图，尺寸要自己给）
function renderPptx(bytes, container, size) {
  const width = (size && size.width) || container.clientWidth || 960;
  const height = (size && size.height) || Math.round(width * 9 / 16);
  const previewer = pptxInit(container, { width: width, height: height });
  // 传 ArrayBuffer：pptx-preview 内部按 zip 解包
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  previewer.preview(buffer);
  return true;
}

window.MemorieOffice = {
  renderDocx: renderDocx,
  parseXlsx: parseXlsx,
  renderPptx: renderPptx
};
