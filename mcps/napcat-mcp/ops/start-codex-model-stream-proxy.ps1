[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [ValidateRange(1, 65535)][int]$Port = 18435,
  [ValidateRange(1, 300)][int]$FirstProgressTimeoutSeconds = 30,
  [ValidateRange(1, 300)][int]$ProgressIdleTimeoutSeconds = 20,
  [ValidateRange(10, 600)][int]$CompactionAttemptTimeoutSeconds = 150,
  [ValidateRange(1, 20)][int]$MaxConsecutiveAttempts = 6,
  [ValidateRange(1, 256)][int]$MaxBufferedRequestMiB = 64,
  [string]$UpstreamOrigin = "https://chatgpt.com",
  [ValidateRange(1, 30)][int]$StartupTimeoutSeconds = 10
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  $DataRoot = Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp"
}
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
$RunnerPath = Join-Path $NapCatMcpRoot "src\codex-model-stream-proxy-runner.mjs"
$StateRoot = Join-Path $DataRoot "state"
$RuntimePath = Join-Path $StateRoot "codex-model-stream-proxy-runtime.json"
$LockPath = Join-Path $StateRoot "codex-model-stream-proxy.lock.json"
$StopPath = Join-Path $StateRoot "codex-model-stream-proxy.stop"

function Resolve-NodeExecutable {
  $Candidates = @()
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_TOOLKIT_NODE_EXE)) { $Candidates += $env:CODEX_TOOLKIT_NODE_EXE }
  $BundledRoot = Join-Path $env:USERPROFILE ".codex-toolkit\runtime"
  if (Test-Path -LiteralPath $BundledRoot) {
    $Candidates += Get-ChildItem -LiteralPath $BundledRoot -Directory -Filter "node-*-win-x64" -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "node.exe" }
  }
  $Command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -ne $Command) { $Candidates += $Command.Source }
  foreach ($Candidate in $Candidates) {
    if (-not [string]::IsNullOrWhiteSpace([string]$Candidate) -and (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
      return (Resolve-Path -LiteralPath $Candidate).Path
    }
  }
  throw "No trusted Node.js executable was found. Set CODEX_TOOLKIT_NODE_EXE to an absolute node.exe path."
}

if (-not (Test-Path -LiteralPath $RunnerPath -PathType Leaf)) { throw "Missing model stream proxy runner: $RunnerPath" }
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null

if (Test-Path -LiteralPath $RuntimePath) {
  try {
    $Current = Get-Content -LiteralPath $RuntimePath -Encoding UTF8 -Raw | ConvertFrom-Json
    $Existing = Get-Process -Id ([int]$Current.pid) -ErrorAction SilentlyContinue
    if ($null -ne $Existing) {
      $Health = Invoke-RestMethod -Uri ("{0}/health" -f [string]$Current.endpoint) -TimeoutSec 2
      if ($Health.ok -eq $true) {
        [pscustomobject]@{ changed = $false; running = $true; pid = [int]$Current.pid; endpoint = [string]$Current.endpoint; node = $Existing.Path } | ConvertTo-Json -Depth 5
        return
      }
      throw "A model stream proxy process exists but its health endpoint is not ready."
    }
  } catch {
    if ($_.Exception.Message -like "A model stream proxy process exists*") { throw }
  }
}

if (Test-Path -LiteralPath $LockPath) {
  $Lock = $null
  try { $Lock = Get-Content -LiteralPath $LockPath -Encoding UTF8 -Raw | ConvertFrom-Json } catch {}
  if ($null -ne $Lock -and $null -ne (Get-Process -Id ([int]$Lock.pid) -ErrorAction SilentlyContinue)) {
    throw "Model stream proxy lock belongs to a live process: $($Lock.pid)"
  }
  Remove-Item -LiteralPath $LockPath -Force
}
if (Test-Path -LiteralPath $StopPath) { Remove-Item -LiteralPath $StopPath -Force }

$NodePath = Resolve-NodeExecutable
$Info = [System.Diagnostics.ProcessStartInfo]::new()
$Info.FileName = $NodePath
$Info.Arguments = '"' + $RunnerPath.Replace('"', '\"') + '"'
$Info.UseShellExecute = $false
$Info.CreateNoWindow = $true
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_STATE_ROOT"] = $StateRoot
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_PORT"] = [string]$Port
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_UPSTREAM_ORIGIN"] = $UpstreamOrigin
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_FIRST_PROGRESS_TIMEOUT_MS"] = [string]($FirstProgressTimeoutSeconds * 1000)
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_PROGRESS_IDLE_TIMEOUT_MS"] = [string]($ProgressIdleTimeoutSeconds * 1000)
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_COMPACTION_ATTEMPT_TIMEOUT_MS"] = [string]($CompactionAttemptTimeoutSeconds * 1000)
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_MAX_CONSECUTIVE_ATTEMPTS"] = [string]$MaxConsecutiveAttempts
$Info.EnvironmentVariables["CODEX_MODEL_STREAM_PROXY_MAX_BUFFERED_REQUEST_BYTES"] = [string]($MaxBufferedRequestMiB * 1024 * 1024)
$Process = [System.Diagnostics.Process]::new()
$Process.StartInfo = $Info
if (-not $Process.Start()) { throw "Failed to start model stream proxy." }

$Deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
$Health = $null
while ((Get-Date) -lt $Deadline) {
  if ($Process.HasExited) { throw "Model stream proxy exited during startup with code $($Process.ExitCode)." }
  try {
    $Health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 1
    if ($Health.ok -eq $true) { break }
  } catch {}
  Start-Sleep -Milliseconds 200
}
if ($null -eq $Health -or $Health.ok -ne $true) { throw "Model stream proxy did not become healthy within $StartupTimeoutSeconds seconds." }

[pscustomobject]@{
  changed = $true
  running = $true
  pid = $Process.Id
  endpoint = "http://127.0.0.1:$Port"
  node = $NodePath
  firstProgressTimeoutSeconds = $FirstProgressTimeoutSeconds
  progressIdleTimeoutSeconds = $ProgressIdleTimeoutSeconds
  compactionAttemptTimeoutSeconds = $CompactionAttemptTimeoutSeconds
  maxConsecutiveAttempts = $MaxConsecutiveAttempts
} | ConvertTo-Json -Depth 5
