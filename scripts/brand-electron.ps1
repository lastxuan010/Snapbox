# Pre-build step: put the app icon and version info onto the Electron binary.
#
# Why this exists: electron-builder normally uses rcedit from winCodeSign, but that archive
# contains macOS symlinks which cannot be extracted without elevation:
#   ERROR: Cannot create symbolic link : ...
# So instead we copy Electron, patch the copy, and let electron-builder just copy it over
# (see win.signAndEditExecutable=false + electronDist=_electron-dist in package.json).
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI, so any
# non-ASCII literal here would turn into mojibake. The branding strings are read from
# package.json instead, with an explicit UTF-8 encoding.
#
# Never fatal: if the icon or rcedit is missing we only warn and continue.

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$src = Join-Path $root 'node_modules\electron\dist'
$dst = Join-Path $root '_electron-dist'

if (-not (Test-Path (Join-Path $src 'electron.exe'))) {
  Write-Warning "electron.exe not found in $src (run npm install first) - skipping branding"
  exit 0
}

# --- branding strings come from package.json (single source of truth) ---
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$company = if ($pkg.author) { [string]$pkg.author } else { 'Snapbox' }
$product = if ($pkg.build.productName) { [string]$pkg.build.productName } else { 'Snapbox' }
$version = if ($pkg.version) { [string]$pkg.version } else { '1.0.0' }
$fileVersion = (($version + '.0').Split('.')[0..3] -join '.')

# --- icon: prefer the .ico electron-builder generated, then our cached copy ---
$ico = @(
  (Join-Path $root 'dist\.icon-ico\icon.ico'),
  (Join-Path $root '_app-icon.ico')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($ico -and -not (Test-Path (Join-Path $root '_app-icon.ico'))) {
  Copy-Item $ico (Join-Path $root '_app-icon.ico') -Force -ErrorAction SilentlyContinue
}

Write-Host '== copying Electron for packaging (node_modules itself is left untouched) =='
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue }
Copy-Item $src $dst -Recurse -Force

$rcedit = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'electron-builder\Cache\winCodeSign') -Recurse -Filter 'rcedit-x64.exe' -ErrorAction SilentlyContinue |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $rcedit) {
  Write-Warning 'rcedit-x64.exe not found in the electron-builder cache - skipping branding'
  exit 0
}
if (-not $ico) {
  Write-Warning 'no icon.ico found - skipping branding (run npm run dist once to generate it)'
  exit 0
}

$exe = Join-Path $dst 'electron.exe'
Write-Host ("== writing icon + version info (company=" + $company + " product=" + $product + ") ==")
& $rcedit $exe `
  --set-icon $ico `
  --set-version-string ProductName $product `
  --set-version-string FileDescription $product `
  --set-version-string CompanyName $company `
  --set-version-string LegalCopyright ("Copyright (c) 2026 " + $company) `
  --set-file-version $fileVersion `
  --set-product-version $fileVersion 2>&1 | Out-Null

$info = (Get-Item $exe).VersionInfo
Write-Host ("== done: ProductName=" + $info.ProductName + " | CompanyName=" + $info.CompanyName + " | FileVersion=" + $info.FileVersion + " ==")
