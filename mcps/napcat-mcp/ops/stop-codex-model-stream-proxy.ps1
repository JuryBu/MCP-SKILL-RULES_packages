[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [ValidateRange(1, 30)][int]$TimeoutSeconds = 10,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($DataRoot)) { $DataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp" }
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $NapCatMcpRoot "src\codex-model-stream-proxy-runner.mjs"
$StateRoot = Join-Path $DataRoot "state"
$RuntimePath = Join-Path $StateRoot "codex-model-stream-proxy-runtime.json"
$StopPath = Join-Path $StateRoot "codex-model-stream-proxy.stop"

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    return [string](Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine
  } catch {
    return ""
  }
}

function Test-ExpectedModelStreamProxyProcess {
  param([int]$ProcessId)
  $CommandLine = Get-ProcessCommandLine -ProcessId $ProcessId
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) { return $false }
  $ExpectedRunnerPath = (Resolve-Path -LiteralPath $RunnerPath).Path
  return $CommandLine.IndexOf("codex-model-stream-proxy-runner.mjs", [System.StringComparison]::OrdinalIgnoreCase) -ge 0 `
    -and $CommandLine.IndexOf($ExpectedRunnerPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

if (-not (Test-Path -LiteralPath $RuntimePath)) {
  [pscustomobject]@{ changed = $false; running = $false; stopped = $true; clean = $true; reason = "runtime_state_missing" } | ConvertTo-Json
  return
}
$Runtime = Get-Content -LiteralPath $RuntimePath -Encoding UTF8 -Raw | ConvertFrom-Json
$Process = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
if ($null -eq $Process) {
  [pscustomobject]@{ changed = $false; running = $false; stopped = $true; clean = $true; reason = "process_not_running" } | ConvertTo-Json
  return
}
if (-not (Test-ExpectedModelStreamProxyProcess -ProcessId ([int]$Runtime.pid))) {
  throw "Refusing to stop PID $([int]$Runtime.pid): it is not the expected model stream proxy runner for $RunnerPath."
}
Set-Content -LiteralPath $StopPath -Encoding UTF8 -Value ([datetime]::UtcNow.ToString("o"))
$Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $Deadline -and $null -ne (Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue)) {
  Start-Sleep -Milliseconds 200
}
$Remaining = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
if ($null -ne $Remaining -and $Force) {
  Stop-Process -Id ([int]$Runtime.pid) -Force
  $Remaining = Get-Process -Id ([int]$Runtime.pid) -ErrorAction SilentlyContinue
}
if ($null -ne $Remaining) { throw "Model stream proxy did not stop within $TimeoutSeconds seconds." }
if (Test-Path -LiteralPath $StopPath) { Remove-Item -LiteralPath $StopPath -Force }
[pscustomobject]@{ changed = $true; running = $false; stopped = $true; clean = $true; pid = [int]$Runtime.pid } | ConvertTo-Json
