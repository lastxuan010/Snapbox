# Snapbox

> 一个深色玻璃质感的 Windows 媒体归档工具 —— 图片、视频、音频、笔记、其他文件，一个窗口全管。

![界面截图](docs/screenshot.png)

## 功能

**媒体归档**
- 图片 / 视频 / 音频 / 笔记 / 其他文件（PDF、压缩包、文档…）统一入库，自动按扩展名归类
- 分组管理，卡片可拖拽到左侧分组，支持批量多选（导入到库 / 移动分组 / 删除）
- 搜索 + 类型筛选，两个维度可叠加（比如「截图」分组里只看其他文件）

**预览**
- 图片、视频（可开大播放器，带倍速）
- 音频：内置播放器 + 歌单视图
- 笔记：富文本编辑 + Markdown 预览
- 文档：PDF 用 Chromium 自带阅读器；**docx / xlsx / pptx 内置解析**（按需加载）
- 其他文件：文件卡 + 一键用系统默认程序打开

**截图 / 录屏 / 贴图**
- 截图（默认 `F4`）：框选区域 → 复制到剪贴板，或直接贴到屏幕上
- 录屏（默认 `F6`）：框选区域、含系统声音、带录制指示灯与时长
- 贴图窗口：拖动、滚轮缩放、透明度调节、双击关闭
- 快捷键可在设置里改（如被其他程序占用会提示并保留原键）

**导入的便利**
- 在列表空白处右键粘贴剪贴板里的图片，或直接 `Ctrl + V`
- 复制的文件按「复制」导入，**不会动你的原文件**

**其他**
- 压缩备份：把分组打包成 `.zip`
- 卸载不删数据，重装后资源库照旧

## 从源码运行

需要 Node.js 18+ 与 Windows 10/11 x64。

```bash
npm install
npm start          # 开发模式启动
```

## 打包成安装包

```bash
npm run dist       # → dist/Snapbox-Setup-<version>.exe（NSIS 安装包）
npm run build:office   # 需要时重新打包文档预览 bundle（office.bundle.js）
```

安装包也会发到本仓库的 **Releases** 页面，普通用户直接下载双击安装即可。

## 技术栈

- **Electron 31** + 原生 HTML/CSS/JavaScript（没有前端框架）
- 条目与缩略图存在 **IndexedDB**；资源文件按分组落盘到 `%APPDATA%\media-archive\library`
- 文档预览用 esbuild 把 docx-preview / SheetJS(xlsx) / pptx-preview 打成单个 `office.bundle.js`，**点开文档时才加载**（不拖慢启动）
- 压缩备份内置 ZIP 写入器（Node 自带 `zlib`），不依赖第三方压缩库
- 采集（截图/录屏）走 Electron 的 `desktopCapturer` + 独立浮层窗口

## 性能与体积（本机实测）

| 指标 | 数值 |
|---|---|
| 安装包 | 69 MB |
| 安装后占用 | 223 MB（20 个文件） |
| 常驻内存（任务管理器口径） | ~96 MB / 4 个进程 |
| 列表渲染 11 个条目 | 0.8 ms |
| 打开条目时列表重建次数 | 0（只更新选中态 class，不重建 DOM） |

## 数据位置

```
%APPDATA%\media-archive\
├─ library\            # 你的文件，按分组分文件夹
├─ zip\                # 压缩备份
└─ capture-settings.json   # 截图/录屏快捷键
```

> 数据目录是钉死的（`main.js` 里显式 `app.setPath('userData', ...)`），改名或换版本都不会让资源库"消失"；卸载也不会删除它。

## License

MIT
