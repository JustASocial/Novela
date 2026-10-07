# Downloads (once, cached) the Obfuscar console runner used to protect
# the shipped Novela.Core assembly. Cache lives in tools/obfuscar (gitignored).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/get-obfuscar.ps1

param(
  [string]$Version = "2.2.50"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$toolsDir = Join-Path $root "tools/obfuscar"
$console = Join-Path $toolsDir "Obfuscar.Console.exe"

if (Test-Path $console) {
  Write-Host "Obfuscar already cached at $toolsDir"
  exit 0
}

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("obfuscar-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $url = "https://api.nuget.org/v3-flatcontainer/obfuscar/$Version/obfuscar.$Version.nupkg"
  $zip = Join-Path $tmp "obfuscar.zip"
  Write-Host "Downloading Obfuscar $Version ..."
  (New-Object Net.WebClient).DownloadFile($url, $zip)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($zip, (Join-Path $tmp "pkg"))
  Copy-Item -Recurse -Force (Join-Path $tmp "pkg/tools/*") $toolsDir
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

if (-not (Test-Path $console)) { throw "Obfuscar.Console.exe not found after download" }
Write-Host "Obfuscar cached at $toolsDir"
