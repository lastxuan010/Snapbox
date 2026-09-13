@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"

echo ============================================
echo    Memorie 媒体档案管理器 - 启动脚本
echo ============================================
echo.

REM 1. 检查 Node.js 是否安装
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo         请先安装 Node.js 18 或更高版本: https://nodejs.org/
  pause
  exit /b 1
)

REM 2. 首次运行自动安装依赖（含 Electron）
if not exist "node_modules\.bin\electron.cmd" (
  echo [提示] 首次运行，正在安装依赖，请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败。
    echo         如果是 Electron 下载超时，可设置国内镜像后重新运行：
    echo         set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    pause
    exit /b 1
  )
)

REM 3. 启动应用
echo [启动] 正在启动 Memorie ...
call npm start

echo.
echo [退出] 应用已关闭。
pause
