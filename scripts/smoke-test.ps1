# Novela backend smoke test: ping, presets, and a sample obfuscation.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1 [-CoreExe <path>]

param(
  [string]$CoreExe = ""
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

if ([string]::IsNullOrEmpty($CoreExe)) {
  foreach ($cand in @(
    (Join-Path $root "core-dist/Novela.Core.exe"),
    (Join-Path $root "core/Novela.Core/bin/Debug/net8.0/Novela.Core.dll")
  )) {
    if (Test-Path $cand) { $CoreExe = $cand; break }
  }
}
if ([string]::IsNullOrEmpty($CoreExe)) { throw "Backend not found. Build with: dotnet build core/Novela.Core" }

function Invoke-Core([string[]]$argv, [string]$stdinText) {
  if ($CoreExe.EndsWith(".dll")) { $cmd = "dotnet"; $argv = @($CoreExe) + $argv }
  else { $cmd = $CoreExe }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $cmd
  $psi.Arguments = ($argv | ForEach-Object { '"{0}"' -f $_ }) -join " "
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  if ($stdinText) { $p.StandardInput.Write($stdinText) }
  $p.StandardInput.Close()
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return @{ Code = $p.ExitCode; Out = $out; Err = $err }
}

Write-Host "Backend: $CoreExe"
$r = Invoke-Core @("ping") ""
Write-Host "ping -> $($r.Out.Trim())"
if ($r.Code -ne 0) { throw "ping failed: $($r.Err)" }

$sample = 'local greeting = "hello"`nfor i = 1, 3 do print(greeting, i) end`nreturn 3'
$job = @{ source = $sample; options = @{
  controlFlowFlattening = $true; customVm = $true; garbageInjection = $true
  stringEncryption = $true; antiTamper = $true; environmentChecks = $true
  garbageIntensity = 1; renameIdentifiers = $true; stripComments = $true
}; seed = 42 } | ConvertTo-Json -Depth 5 -Compress

$r = Invoke-Core @("obfuscate", "--stdin") $job
$res = $r.Out | ConvertFrom-Json
Write-Host "obfuscate -> success=$($res.success) mode=$($res.stats.mode) in=$($res.stats.inputBytes) out=$($res.stats.outputBytes)"
if (-not $res.success) { throw "obfuscation failed: $($res.error)" }
Write-Host "smoke test passed" -ForegroundColor Green
