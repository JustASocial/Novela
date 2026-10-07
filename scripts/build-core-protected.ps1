# Builds the PROTECTED Novela.Core for Release packaging:
#   1. self-contained folder publish (NOT single-file, so the assembly stays obfuscatable),
#   2. Obfuscar renaming pass over Novela.Core.dll (wire-protocol types excluded in code),
#   3. assembles core-dist/ = apphost exe + obfuscated dll + runtime, WITHOUT pdbs.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-core-protected.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

Step "Fetching Obfuscar runner"
& powershell -ExecutionPolicy Bypass -File (Join-Path $root "scripts/get-obfuscar.ps1")
if ($LASTEXITCODE -ne 0) { throw "get-obfuscar failed" }
$console = Join-Path $root "tools/obfuscar/Obfuscar.Console.exe"

Step "Publishing Novela.Core (self-contained folder)"
$pubDir = Join-Path $root "core-dist-tmp"
if (Test-Path $pubDir) { Remove-Item -Recurse -Force $pubDir }
& dotnet publish "core/Novela.Core/Novela.Core.csproj" -c Release -r win-x64 --self-contained true -o $pubDir -v quiet
if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
$dll = Join-Path $pubDir "Novela.Core.dll"
if (-not (Test-Path $dll)) { throw "Novela.Core.dll missing after publish" }

Step "Obfuscating Novela.Core.dll"
$outDir = Join-Path $root "core-dist-obf"
if (Test-Path $outDir) { Remove-Item -Recurse -Force $outDir }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$config = Join-Path $root "scripts/obfuscar.xml"
$xml = (Get-Content -Raw $config) -replace "{{IN}}", $pubDir -replace "{{OUT}}", $outDir
$tmpXml = Join-Path ([System.IO.Path]::GetTempPath()) "novela-obfuscar.xml"
Set-Content -NoNewline -Path $tmpXml -Value $xml -Encoding UTF8
& $console $tmpXml
if ($LASTEXITCODE -ne 0) { throw "Obfuscar failed" }
$obfDll = Join-Path $outDir "Novela.Core.dll"
if (-not (Test-Path $obfDll)) { throw "Obfuscated assembly missing: $obfDll" }

Step "Assembling core-dist/ (no pdbs, no source)"
$distDir = Join-Path $root "core-dist"
if (Test-Path $distDir) { Remove-Item -Recurse -Force $distDir }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Get-ChildItem -Path $pubDir -Exclude "*.pdb" | Copy-Item -Recurse -Force -Destination $distDir
Copy-Item -Force $obfDll (Join-Path $distDir "Novela.Core.dll")
Remove-Item -Force (Join-Path $distDir "*.pdb") -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $pubDir, $outDir -ErrorAction SilentlyContinue
Get-Item (Join-Path $distDir "Novela.Core.exe"), (Join-Path $distDir "Novela.Core.dll") | Select-Object Name, Length
Write-Host "Protected core ready in core-dist/" -ForegroundColor Green
