# Novela release build (Windows, PowerShell 5.1+).
# Produces the layout:
#   Release/
#     Installer/Novela-Setup-<version>.exe
#     Portable/Novela-Portable/  (Novela.exe + resources/ + core/Novela.Core.exe)
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 [-Version 1.0.0]

param(
  [string]$Version = "1.0.0",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

Step "1/4 Publishing PROTECTED Novela.Core (obfuscated assembly, no pdbs)"
& powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts/build-core-protected.ps1")
if ($LASTEXITCODE -ne 0) { throw "protected core build failed" }
if (-not (Test-Path "core-dist/Novela.Core.exe")) { throw "core-dist/Novela.Core.exe missing after publish" }
if (-not (Test-Path "core-dist/Novela.Core.dll")) { throw "core-dist/Novela.Core.dll missing after publish" }

if (-not $SkipInstall) {
  Step "2/4 Installing Node dependencies"
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
} else {
  Step "2/4 Skipping npm install (--SkipInstall)"
}

if (-not (Test-Path (Join-Path $root "vendor/monaco/vs/loader.js"))) {
  Step "2b/4 Syncing Monaco runtime"
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts/sync-monaco.ps1")
  if ($LASTEXITCODE -ne 0) { throw "monaco sync failed" }
}

Step "3/4 Building Electron targets (nsis + dir)"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
& npx electron-builder --win nsis dir
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed" }

Step "4/4 Arranging Release/ layout"
$release = Join-Path $root "Release"
$installerDir = Join-Path $release "Installer"
$portableDir = Join-Path $release "Portable/Novela-Portable"
New-Item -ItemType Directory -Force -Path $installerDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $release "Portable") | Out-Null

$setup = Get-ChildItem -Path $release -Filter "Novela-Setup-*.exe" | Select-Object -First 1
if ($null -eq $setup) { throw "Installer artifact not found in Release/" }
Move-Item -Force -LiteralPath $setup.FullName -Destination (Join-Path $installerDir $setup.Name)

$unpacked = Join-Path $release "win-unpacked"
if (-not (Test-Path $unpacked)) { throw "win-unpacked directory not found in Release/" }
if (Test-Path $portableDir) { Remove-Item -Recurse -Force -LiteralPath $portableDir }
Move-Item -Force -LiteralPath $unpacked -Destination $portableDir

$blockmap = Join-Path $release ($setup.Name + ".blockmap")
if (Test-Path $blockmap) { Move-Item -Force -LiteralPath $blockmap -Destination (Join-Path $installerDir ($setup.Name + ".blockmap")) }
$dbgYml = Join-Path $release "builder-debug.yml"
if (Test-Path $dbgYml) { Remove-Item -Force -LiteralPath $dbgYml }

Write-Host ""
Write-Host "Release layout:" -ForegroundColor Green
Get-ChildItem -Recurse -Path $release | Select-Object FullName | Format-Table -HideTableHeaders
Write-Host "Done. Installer: $installerDir | Portable: $portableDir" -ForegroundColor Green
