/**
 * Memorie 笔记编辑器内核（CodeMirror 6）
 * 打包为 IIFE，暴露全局对象 NoteEditorBundle 供 app.js 调用。
 *
 * 构建命令（项目根目录）：
 *   npx esbuild src-editor/editor-entry.js --bundle --format=iife \
 *     --global-name=NoteEditorBundle --outfile=note-editor.bundle.js
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars, ViewPlugin, Decoration } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab, copyLineDown, copyLineUp, deleteLine, moveLineUp, moveLineDown, undo, redo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

let view = null;           // EditorView 单例
let typewriterMode = false;
let scrollCallback = null; // 滚动同步回调
let richMode = false;      // 所见即所得（隐藏 Markdown 语法符号）

// ---------- 所见即所得模式：装饰插件 ----------
// 非光标行隐藏 **、# 等语法符号并套用视觉样式；光标所在行显示原始 Markdown 便于编辑

const markDeco = {
  bold: Decoration.mark({ class: 'md-bold' }),
  italic: Decoration.mark({ class: 'md-italic' }),
  strike: Decoration.mark({ class: 'md-strike' }),
  underline: Decoration.mark({ class: 'md-underline' }),
  code: Decoration.mark({ class: 'md-code' })
};

const INLINE_RE = /(\*\*|__)([^*_]+?)\1|(\*)([^*]+?)\3|~~([^~]+?)~~|\+\+([^+]+?)\+\+|`([^`]+)`/g;

function buildRichDecorations(view) {
  if (!richMode) return Decoration.none;
  const state = view.state;
  const sel = state.selection.main;
  const vpFrom = view.viewport.from;
  const vpTo = view.viewport.to;
  const decorations = [];

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (line.to < vpFrom || line.from > vpTo) continue;

    // 光标/选区与该行相交 → 显示源码，便于编辑
    if (sel.from <= line.to && sel.to >= line.from) continue;

    // 标题：隐藏 "# " 前缀，整行套标题样式
    const h = line.text.match(/^(#{1,6}) (.*)$/);
    if (h) {
      decorations.push(Decoration.line({ class: 'md-line md-h' + h[1].length }).range(line.from));
      decorations.push(Decoration.replace({}).range(line.from, line.from + h[1].length + 1));
      continue;
    }

    // 行内标记：粗/斜/删/下划线/行内代码
    const re = new RegExp(INLINE_RE.source, 'g');
    let m;
    while ((m = re.exec(line.text))) {
      const base = line.from + m.index;
      if (m[1]) { // **bold** 或 __bold__
        const inner = m[2];
        const markLen = m[1].length;
        decorations.push(Decoration.replace({}).range(base, base + markLen));
        decorations.push(markDeco.bold.range(base + markLen, base + markLen + inner.length));
        decorations.push(Decoration.replace({}).range(base + markLen + inner.length, base + markLen * 2 + inner.length));
      } else if (m[3]) { // *italic*
        decorations.push(Decoration.replace({}).range(base, base + 1));
        decorations.push(markDeco.italic.range(base + 1, base + 1 + m[4].length));
        decorations.push(Decoration.replace({}).range(base + 1 + m[4].length, base + 2 + m[4].length));
      } else if (m[5]) { // ~~strike~~
        decorations.push(Decoration.replace({}).range(base, base + 2));
        decorations.push(markDeco.strike.range(base + 2, base + 2 + m[5].length));
        decorations.push(Decoration.replace({}).range(base + 2 + m[5].length, base + 4 + m[5].length));
      } else if (m[6]) { // ++underline++
        decorations.push(Decoration.replace({}).range(base, base + 2));
        decorations.push(markDeco.underline.range(base + 2, base + 2 + m[6].length));
        decorations.push(Decoration.replace({}).range(base + 2 + m[6].length, base + 4 + m[6].length));
      } else if (m[7]) { // `code`
        decorations.push(Decoration.replace({}).range(base, base + 1));
        decorations.push(markDeco.code.range(base + 1, base + 1 + m[7].length));
        decorations.push(Decoration.replace({}).range(base + 1 + m[7].length, base + 2 + m[7].length));
      }
    }
  }
  return Decoration.set(decorations, true);
}

const richModePlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildRichDecorations(view); }
    update(update) {
      if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.length) {
        this.decorations = buildRichDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// ---------- 内部工具 ----------

function insertAtCursor(text) {
  if (!view) return;
  const sel = view.state.selection.main;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    selection: { anchor: sel.from + text.length }
  });
  view.focus();
}

// 包裹选区：before + 选区(或占位) + after，选区落回内部文本
function wrapSelection(before, after, placeholder = '') {
  if (!view) return;
  const sel = view.state.selection.main;
  const inner = view.state.sliceDoc(sel.from, sel.to) || placeholder;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: before + inner + after },
    selection: { anchor: sel.from + before.length, head: sel.from + before.length + inner.length }
  });
  view.focus();
}

// 行级前缀 toggle（对选中涉及的所有行生效）
function toggleLinePrefix(prefix) {
  if (!view) return;
  const state = view.state;
  const range = state.selection.main;
  const fromLine = state.doc.lineAt(range.from);
  const toLine = state.doc.lineAt(range.to);
  const lines = [];
  for (let n = fromLine.number; n <= toLine.number; n++) lines.push(state.doc.line(n));

  const all = lines.every((l) => l.text.startsWith(prefix));
  const changes = [];
  for (const l of lines) {
    const insert = all ? '' : prefix;
    changes.push({ from: l.from, to: l.from + (all ? Math.min(prefix.length, l.text.length) : 0), insert });
  }
  view.dispatch({ changes });
  view.focus();
}

// 有序列表（自动编号，已编号则去除）
function orderedList() {
  if (!view) return;
  const state = view.state;
  const range = state.selection.main;
  const fromLine = state.doc.lineAt(range.from);
  const toLine = state.doc.lineAt(range.to);
  const lines = [];
  for (let n = fromLine.number; n <= toLine.number; n++) lines.push(state.doc.line(n));

  const all = lines.every((l) => /^\d+\. /.test(l.text));
  const changes = [];
  let n = 1;
  for (const l of lines) {
    if (all) {
      const m = l.text.match(/^\d+\. /);
      changes.push({ from: l.from, to: l.from + (m ? m[0].length : 0), insert: '' });
    } else {
      changes.push({ from: l.from, to: l.from, insert: `${n++}. ` });
    }
  }
  view.dispatch({ changes });
  view.focus();
}

// 清除选区（或行）中的 Markdown 格式符号
function clearFormat() {
  if (!view) return;
  const state = view.state;
  const range = state.selection.main;
  const hasSelection = range.from !== range.to;
  const from = hasSelection ? range.from : state.doc.lineAt(range.from).from;
  const to = hasSelection ? range.to : state.doc.lineAt(range.from).to;
  const text = state.sliceDoc(from, to);
  const cleaned = text
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\+\+([^+]*)\+\+/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6} /gm, '')
    .replace(/^> /gm, '')
    .replace(/^[-*] /gm, '')
    .replace(/^\d+\. /gm, '');
  view.dispatch({ changes: { from, to, insert: cleaned } });
  view.focus();
}

// 打字机模式：把光标行滚到视口中央
function typewriterScroll() {
  if (!view || !typewriterMode) return;
  const pos = view.state.selection.main.head;
  const coords = view.coordsAtPos(pos);
  if (!coords) return;
  const box = view.scrollDOM.getBoundingClientRect();
  const target = (coords.top + coords.bottom) / 2 - box.top - box.clientHeight / 2;
  view.scrollDOM.scrollBy({ top: target, behavior: 'smooth' });
}

// ---------- 快捷键命令 ----------

const customCommands = {
  'Mod-b': () => { wrapSelection('**', '**', '加粗文本'); return true; },
  'Mod-i': () => { wrapSelection('*', '*', '斜体文本'); return true; },
  'Mod-u': () => { wrapSelection('++', '++', '下划线文本'); return true; },
  'Mod-Shift-x': () => { wrapSelection('~~', '~~', '删除文本'); return true; },
  'Shift-Alt-ArrowDown': () => copyLineDown(view),
  'Shift-Alt-ArrowUp': () => copyLineUp(view),
  'Alt-ArrowUp': () => moveLineUp(view),
  'Alt-ArrowDown': () => moveLineDown(view),
  'Mod-Shift-k': () => deleteLine(view),
  'Mod-h': () => openSearchPanel(view)
};

// ---------- 公开 API ----------

export function create({ parent, doc = '', onChange = null, onScroll = null } = {}) {
  if (view) {
    view.destroy();
    view = null;
  }
  scrollCallback = onScroll;

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      if (onChange) onChange(view.state.doc.toString());
      typewriterScroll();
    }
  });

  const scrollListener = (event) => {
    if (scrollCallback) scrollCallback(event.target.scrollTop);
  };

  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        foldGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        rectangularSelection(),
        crosshairCursor(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        search({ top: true }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        richModePlugin,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        Prec.high(keymap.of(customCommands)),
        keymap.of([
          indentWithTab, // Tab 缩进 / Shift+Tab 反缩进
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap
        ]),
        EditorView.lineWrapping,
        updateListener,
        // 图片拖入 → 转 base64 插入
        EditorView.domEventHandlers({
          drop(event) {
            const files = [...(event.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
            if (!files.length) return false;
            event.preventDefault();
            for (const file of files) {
              const reader = new FileReader();
              reader.onload = () => {
                if (typeof reader.result === 'string') {
                  insertAtCursor(`![${file.name}](${reader.result})\n`);
                }
              };
              reader.readAsDataURL(file);
            }
            return true;
          }
        })
      ]
    }),
    parent
  });

  view.scrollDOM.addEventListener('scroll', scrollListener);
  return view;
}

export function getDoc() {
  return view ? view.state.doc.toString() : '';
}

// 全量替换文档（打开另一条笔记时），并重置撤销历史
export function openDoc(doc) {
  if (!view) return;
  view.setState(EditorState.create({
    doc: doc || '',
    extensions: view.state.extensions
  }));
  typewriterScroll();
}

export function focusEditor() {
  if (view) view.focus();
}

export function undoCmd() { if (view) { undo(view); view.focus(); } }
export function redoCmd() { if (view) { redo(view); view.focus(); } }
export function searchPanel() { if (view) { openSearchPanel(view); view.focus(); } }
export function wrap(b, a, p) { wrapSelection(b, a, p); }
export function prefix(p) { toggleLinePrefix(p); }
export function ordered() { orderedList(); }
export function clearFmt() { clearFormat(); }
export function insert(text) { insertAtCursor(text); }

export function toggleTypewriter(force) {
  typewriterMode = typeof force === 'boolean' ? force : !typewriterMode;
  if (typewriterMode) typewriterScroll();
  return typewriterMode;
}

export function isTypewriter() { return typewriterMode; }

// 所见即所得模式切换：空事务触发装饰插件重建
export function setRichMode(v) {
  richMode = !!v;
  if (view) view.dispatch({});
  return richMode;
}

export function isRichMode() { return richMode; }

// 滚动同步：根据编辑器滚动比例，回调预览区应处的滚动比例
export function onEditorScroll(cb) { scrollCallback = cb; }
