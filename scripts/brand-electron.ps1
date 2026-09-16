# 打包前把 Electron 本体换成 Snapbox 的图标 / 版本信息（npm run dist 会自动先跑这一步）。
#
# 为什么要绕这一下：electron-builder 默认会用 winCodeSign 里的 rcedit 改写 exe，而那个包
# 含有 macOS 的符号链接，普通权限解压会失败：
#   ERROR: Cannot create symbolic link : 客户端没有所需的特权。
# 所以改成"先把 Electron 的一份副本改好，再让 electron-builder 原样复制过去"，
# 配合 package.json 里的 win.signAndEditExecutable=false + electronDist=_electron-dist。
#
# 找不到 ico / rcedit 时只警告不中断：包照样能打出来，只是 exe 图标是 Electron 默认的。

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$src = Join-Path $root 'node_modules\electron\dist'
$dst = Join-Path $root '_electron-dist'

if (-not (Test-Path (Join-Path $src 'electron.exe'))) {
  Write-Warning "找不到 $src\electron.exe（先 npm install），跳过 exe 图标处理"
  exit 0
}

# 图标来源：优先 electron-builder 生成过的 .ico，其次上次存下的副本
$ico = @(
  (Join-Path $root 'dist\.icon-ico\icon.ico'),
  (Join-Path $root '_app-icon.ico')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($ico -and -not (Test-Path (Join-Path $root '_app-icon.ico'))) {
  Copy-Item $ico (Join-Path $root '_app-icon.ico') -Force -ErrorAction SilentlyContinue
}

Write-Host '== 复制一份 Electron（不动 node_modules，避免被运行中的 App 占用）=='
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item $src $dst -Recurse -Force

$rcedit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $rcedit) {
  Write-Warning '找不到 rcedit-x64.exe（electron-builder 的 winCodeSign 缓存里没有），跳过图标处理'
  exit 0
}
if (-not $ico) {
  Write-Warning '找不到 icon.ico，跳过图标处理（先跑一次 npm run dist 让它生成）'
  exit 0
}

$exe = Join-Path $dst 'electron.exe'
Write-Host "== 写入图标与版本信息：$ico =="
& $rcedit $exe `
  --set-icon $ico `
  --set-version-string ProductName 'Snapbox' `
  --set-version-string FileDescription 'Snapbox' `
  --set-version-string CompanyName 'TraeDesign' `
  --set-version-string LegalCopyright 'MIT License' `
  --set-file-version '1.0.0.0' `
  --set-product-version '1.0.0.0' 2>&1 | Out-Null

$info = (Get-Item $exe).VersionInfo
Write-Host ("== 完成：ProductName=" + $info.ProductName + "  FileVersion=" + $info.FileVersion + " ==")
