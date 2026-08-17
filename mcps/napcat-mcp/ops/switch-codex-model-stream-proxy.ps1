[CmdletBinding()]
param(
  [ValidateSet("Preview", "Apply", "Rollback")][string]$Action = "Preview",
  [string]$ConfigPath = "",
  [string]$BackupRoot = "",
  [string]$RollbackBackupPath = "",
  [ValidateRange(1, 65535)][int]$Port = 18435
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ConfigPath)) { $ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml" }
if ([string]::IsNullOrWhiteSpace($BackupRoot)) { $BackupRoot = Join-Path $env:USERPROFILE ".codex\backups\model-stream-proxy" }
$ConfigPath = [System.IO.Path]::GetFullPath($ConfigPath)
$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw "Codex config does not exist: $ConfigPath" }

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Replacement([string]$TargetPath, [byte[]]$Bytes, [string]$BackupPath) {
  $Directory = Split-Path -Parent $TargetPath
  $TemporaryPath = Join-Path $Directory (".{0}.{1}.tmp" -f [System.IO.Path]::GetFileName($TargetPath), [guid]::NewGuid().ToString("N"))
  [System.IO.File]::WriteAllBytes($TemporaryPath, $Bytes)
  try {
    [System.IO.File]::Replace($TemporaryPath, $TargetPath, $BackupPath, $true)
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath) { Remove-Item -LiteralPath $TemporaryPath -Force }
  }
}

if ($Action -eq "Rollback") {
  if ([string]::IsNullOrWhiteSpace($RollbackBackupPath)) { throw "RollbackBackupPath is required for Rollback." }
  $RollbackBackupPath = [System.IO.Path]::GetFullPath($RollbackBackupPath)
  if (-not (Test-Path -LiteralPath $RollbackBackupPath -PathType Leaf)) { throw "Rollback backup does not exist: $RollbackBackupPath" }
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  $CurrentBackup = Join-Path $BackupRoot ("config-before-rollback-{0}.toml" -f [datetime]::UtcNow.ToString("yyyyMMddTHHmmss.fffZ"))
  $ExpectedHash = Get-FileSha256 $RollbackBackupPath
  Write-Replacement -TargetPath $ConfigPath -Bytes ([System.IO.File]::ReadAllBytes($RollbackBackupPath)) -BackupPath $CurrentBackup
  $ActualHash = Get-FileSha256 $ConfigPath
  if ($ActualHash -ne $ExpectedHash) { throw "Rollback hash verification failed." }
  [pscustomobject]@{ action = "Rollback"; changed = $true; configPath = $ConfigPath; restoredFrom = $RollbackBackupPath; currentBackup = $CurrentBackup; sha256 = $ActualHash; restartCodexRequired = $true } | ConvertTo-Json -Depth 5
  return
}

$OriginalBytes = [System.IO.File]::ReadAllBytes($ConfigPath)
$HasBom = $OriginalBytes.Length -ge 3 -and $OriginalBytes[0] -eq 0xEF -and $OriginalBytes[1] -eq 0xBB -and $OriginalBytes[2] -eq 0xBF
$Encoding = [System.Text.UTF8Encoding]::new($HasBom)
$OriginalText = $Encoding.GetString($OriginalBytes, $(if ($HasBom) { 3 } else { 0 }), $OriginalBytes.Length - $(if ($HasBom) { 3 } else { 0 }))
$NewLine = if ($OriginalText.Contains("`r`n")) { "`r`n" } else { "`n" }
$ProviderName = "local_model_stream_proxy"
$ProviderPattern = "(?ms)^[ \t]*\[model_providers\." + [regex]::Escape($ProviderName) + "\][ \t]*\r?\n.*?(?=^[ \t]*\[|\z)"
$UpdatedText = [regex]::Replace($OriginalText, $ProviderPattern, "")
$FirstTable = [regex]::Match($UpdatedText, "(?m)^[ \t]*\[")
$TopLength = if ($FirstTable.Success) { $FirstTable.Index } else { $UpdatedText.Length }
$Top = $UpdatedText.Substring(0, $TopLength)
$Rest = $UpdatedText.Substring($TopLength)
$ModelProviderPattern = "(?m)^[ \t]*model_provider[ \t]*=.*$"
if ([regex]::IsMatch($Top, $ModelProviderPattern)) {
  $Top = [regex]::Replace($Top, $ModelProviderPattern, ('model_provider = "{0}"' -f $ProviderName), 1)
} else {
  $Top = ('model_provider = "{0}"{1}' -f $ProviderName, $NewLine) + $Top
}
$ProviderBlock = @(
  "[model_providers.$ProviderName]",
  'name = "OpenAI"',
  ('base_url = "http://127.0.0.1:{0}/backend-api/codex"' -f $Port),
  'wire_api = "responses"',
  'requires_openai_auth = true',
  'supports_websockets = false',
  'stream_max_retries = 5',
  'stream_idle_timeout_ms = 150000'
) -join $NewLine
$UpdatedText = ($Top.TrimEnd("`r", "`n") + $NewLine + $Rest.TrimStart("`r", "`n")).TrimEnd("`r", "`n") + $NewLine + $NewLine + $ProviderBlock + $NewLine
$UpdatedBytesWithoutBom = [System.Text.UTF8Encoding]::new($false).GetBytes($UpdatedText)
$UpdatedBytes = if ($HasBom) { [byte[]](0xEF, 0xBB, 0xBF) + $UpdatedBytesWithoutBom } else { $UpdatedBytesWithoutBom }
$Changed = -not [System.Linq.Enumerable]::SequenceEqual([byte[]]$OriginalBytes, [byte[]]$UpdatedBytes)

if ($Action -eq "Preview") {
  [pscustomobject]@{
    action = "Preview"
    changed = $Changed
    configPath = $ConfigPath
    currentSha256 = Get-FileSha256 $ConfigPath
    provider = $ProviderName
    baseUrl = "http://127.0.0.1:$Port/backend-api/codex"
    restartCodexRequired = $Changed
  } | ConvertTo-Json -Depth 5
  return
}

$Health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 2
if ($Health.ok -ne $true) { throw "Local model stream proxy health check failed." }
if (-not $Changed) {
  [pscustomobject]@{ action = "Apply"; changed = $false; configPath = $ConfigPath; sha256 = Get-FileSha256 $ConfigPath; restartCodexRequired = $false } | ConvertTo-Json -Depth 5
  return
}
New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
$BackupPath = Join-Path $BackupRoot ("config-before-model-stream-proxy-{0}.toml" -f [datetime]::UtcNow.ToString("yyyyMMddTHHmmss.fffZ"))
$OriginalHash = Get-FileSha256 $ConfigPath
Write-Replacement -TargetPath $ConfigPath -Bytes $UpdatedBytes -BackupPath $BackupPath
if ((Get-FileSha256 $BackupPath) -ne $OriginalHash) { throw "Exact config backup verification failed." }
[pscustomobject]@{
  action = "Apply"
  changed = $true
  configPath = $ConfigPath
  backupPath = $BackupPath
  previousSha256 = $OriginalHash
  sha256 = Get-FileSha256 $ConfigPath
  provider = $ProviderName
  baseUrl = "http://127.0.0.1:$Port/backend-api/codex"
  restartCodexRequired = $true
} | ConvertTo-Json -Depth 5
