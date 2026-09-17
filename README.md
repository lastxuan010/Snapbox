# Snapbox 打造自己的微信传输助手

> 一个深色玻璃质感的 Windows 媒体归档工具 —— 图片、视频、音频、笔记、其他文件，一个窗口全管。


下载链接：[https://github.com/lastxuan010/Snapbox/releases/tag/v1.0.0](https://github.com/lastxuan010/Snapbox/releases/download/v1.0.1/Snapbox-Setup-1.0.1.exe)
![界面截图](docs/screenshot.png)

## 功能
ai vibe的这个项目，有些地方还不是很成熟
起因是朋友有个习惯，每看一部动漫都会保存里面的某个场景或者人物，再加上本人平时存一些文件都是放到微信传输助手里，一翻就翻半天，于是就做了这个项目

**媒体归档**
图片，视频，音频，pdf等文件都可保存入库备份，每个文件可备注信息，内置搜索可快速找到需要的文件。
内置歌曲和视频播放器。
文件可自定义分组存储，可打包压缩备份

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



## 性能与体积（本机实测）

| 指标 | 数值 |
|---|---|
| 安装包 | 69 MB |
| 安装后占用 | 223 MB（21 个文件） |
| 常驻内存（任务管理器口径） | ~96 MB / 4 个进程 |
| 列表渲染 11 个条目 | 0.8 ms |
| 打开条目时列表重建次数 | 0（只更新选中态 class，不重建 DOM） |

## 数据位置

默认在 `%APPDATA%\media-archive`（完整路径：`C:\Users\<用户名>\AppData\Roaming\media-archive`）：

```
%APPDATA%\media-archive\
├─ library\                       你的文件，按分组分文件夹：library\<分组名>\<id>.<扩展名>
│  └─ zip\                        压缩备份 <分组名>.zip
├─ IndexedDB\                     条目索引 / 分组 / 缩略图
├─ Local Storage\                 界面偏好（导入方式、面板折叠、播放速度…）
├─ capture-settings.json          截图 / 录屏快捷键（改过才有）
└─ Cache\ GPUCache\ Preferences …  Chromium 自己的缓存，不用管也不用备份
```

**和软件装在哪个盘无关** —— 程序装到 D 盘、改过安装目录，数据都仍然在这里。**卸载也不会删**，重装 / 升级 / 换版本后资源库照旧。

### 数据放哪里

**首次启动时会问你一次**（默认就是上面这个位置，也可以当场换成别的文件夹，比如 `D:\SnapboxData`），选完就固定下来，以后不再打扰。



