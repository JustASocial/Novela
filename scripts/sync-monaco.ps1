# Copy Monaco editor runtime into vendor/ for offline use (dev + packaging).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/sync-monaco.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$src = Join-Path $root "node_modules/monaco-editor/min/vs"
$dst = Join-Path $root "vendor/monaco/vs"

if (-not (Test-Path $src)) { throw "monaco-editor not installed. Run: npm install" }
if (Test-Path $dst) { Remove-Item -Recurse -Force -LiteralPath $dst }
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force -LiteralPath $src -Destination (Split-Path -Parent $dst)
Write-Host "Monaco synced to vendor/monaco/vs"
