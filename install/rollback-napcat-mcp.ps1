# 恢复 install-napcat-mcp.ps1 最近一次安装前的 broker、Codex 配置和 MCP 目录。
# 不自动重启 broker、NapCat 或 QQ。

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
  [string]$CodexHome = (Join-Path $env:USERPROFILE ".codex"),
  [switch]$RestoreNapCatOneBotConfig
)

$ErrorActionPreference = "Stop"
$BrokerRootDefault = Join-Path $CodexHome "mcp-http-broker"
$ConfiguredDataRoot = [Environment]::GetEnvironmentVariable("CODEX_TOOLKIT_NAPCAT_DATA_ROOT", "User")
$PrivateEnvPathDefault = Join-Path $BrokerRootDefault "broker-private.env.json"
if ([string]::IsNullOrWhiteSpace($ConfiguredDataRoot) -and (Test-Path -LiteralPath $PrivateEnvPathDefault)) {
  try { $ConfiguredDataRoot = [string](Get-Content -LiteralPath $PrivateEnvPathDefault -Raw -Encoding UTF8 | ConvertFrom-Json).CODEX_TOOLKIT_NAPCAT_DATA_ROOT } catch {}
}
$NewUpdateStates = @(
  @($ConfiguredDataRoot, (Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp"), (Join-Path $BrokerRootDefault "napcat-mcp")) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
    ForEach-Object { Join-Path ([System.IO.Path]::GetFullPath($_)) "state\napcat-bridge-last-update.json" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -Unique
)
if ($NewUpdateStates.Count -gt 1) { throw "发现多个 NapCat bridge 更新状态，请显式检查 DataRoot 后使用 napcat-mcp\ops\rollback-codex-napcat-bridge.ps1。" }
if ($NewUpdateStates.Count -eq 1) {
  $NewState = Get-Content -LiteralPath $NewUpdateStates[0] -Raw -Encoding UTF8 | ConvertFrom-Json
  $NewRollback = Join-Path $PSScriptRoot "napcat-mcp\ops\rollback-codex-napcat-bridge.ps1"
  if (-not (Test-Path -LiteralPath $NewRollback)) { throw "缺少新版 NapCat bridge 回滚脚本：$NewRollback" }
  $NewBrokerRoot = if (-not [string]::IsNullOrWhiteSpace([string]$NewState.brokerRoot)) { [string]$NewState.brokerRoot } else { $BrokerRootDefault }
  & $NewRollback -DataRoot ([string]$NewState.dataRoot) -BrokerRoot $NewBrokerRoot
  return
}
$InstallStateFile = Join-Path $CodexHome "napcat-mcp-install.json"
if (-not (Test-Path -LiteralPath $InstallStateFile)) {
  throw "找不到安装状态：$InstallStateFile"
}
$State = ([System.IO.File]::ReadAllText($InstallStateFile)) | ConvertFrom-Json
$BrokerRoot = [System.IO.Path]::GetFullPath([string]$State.brokerRoot)
$NapCatMcpRoot = [System.IO.Path]::GetFullPath([string]$State.napcatMcpRoot)
$BackupDir = [System.IO.Path]::GetFullPath([string]$State.backupDir)
$ConfigFile = [string]$State.configFile
$PrivateEnvFile = [string]$State.privateEnvFile
$RollbackStamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$RollbackSafetyDir = Join-Path $CodexHome ("backups\napcat-rollback-preflight-" + $RollbackStamp)

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $Encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $Encoding)
}

function Get-FileSha256 {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $Hasher.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

function Restore-ConfigPreservingLaterChanges {
  param([bool]$ExistedBeforeInstall, [string]$InstalledSha256)
  $CurrentSha256 = Get-FileSha256 -Path $ConfigFile
  if (-not [string]::IsNullOrWhiteSpace($InstalledSha256) -and $CurrentSha256 -eq $InstalledSha256) {
    if ($ExistedBeforeInstall) {
      Copy-Item -LiteralPath (Join-Path $BackupDir "config.toml") -Destination $ConfigFile -Force
    } elseif (Test-Path -LiteralPath $ConfigFile) {
      Remove-Item -LiteralPath $ConfigFile -Force
    }
    return
  }

  $CurrentContent = if (Test-Path -LiteralPath $ConfigFile) { [System.IO.File]::ReadAllText($ConfigFile) } else { "" }
  $WithoutNapCat = [regex]::Replace(
    $CurrentContent,
    '(?ms)^\[mcp_servers\.napcat\]\s*\r?\n.*?(?=^\[|\z)',
    ''
  ).TrimEnd("`r", "`n")
  $OriginalSection = ""
  if ($ExistedBeforeInstall) {
    $OriginalContent = [System.IO.File]::ReadAllText((Join-Path $BackupDir "config.toml"))
    $OriginalMatch = [regex]::Match($OriginalContent, '(?ms)^\[mcp_servers\.napcat\]\s*\r?\n.*?(?=^\[|\z)')
    if ($OriginalMatch.Success) { $OriginalSection = $OriginalMatch.Value.TrimEnd("`r", "`n") }
  }
  $Merged = @($WithoutNapCat, $OriginalSection) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if ($Merged.Count -eq 0 -and -not $ExistedBeforeInstall) {
    if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
  } else {
    Write-Utf8NoBom -Path $ConfigFile -Content (($Merged -join "`r`n`r`n") + "`r`n")
  }
}

function Restore-PrivateEnvPreservingLaterChanges {
  param([bool]$ExistedBeforeInstall, [string]$InstalledSha256)
  $CurrentSha256 = Get-FileSha256 -Path $PrivateEnvFile
  if (-not [string]::IsNullOrWhiteSpace($InstalledSha256) -and $CurrentSha256 -eq $InstalledSha256) {
    if ($ExistedBeforeInstall) {
      Copy-Item -LiteralPath (Join-Path $BackupDir "broker-private.env.json") -Destination $PrivateEnvFile -Force
    } elseif (Test-Path -LiteralPath $PrivateEnvFile) {
      Remove-Item -LiteralPath $PrivateEnvFile -Force
    }
    return
  }

  $Current = [ordered]@{}
  if (Test-Path -LiteralPath $PrivateEnvFile) {
    $ParsedCurrent = ([System.IO.File]::ReadAllText($PrivateEnvFile)) | ConvertFrom-Json
    foreach ($Property in $ParsedCurrent.PSObject.Properties) { $Current[$Property.Name] = $Property.Value }
  }
  foreach ($Key in @("NAPCAT_HTTP_URL", "NAPCAT_ACCESS_TOKEN", "NAPCAT_HTTP_TIMEOUT_MS")) {
    [void]$Current.Remove($Key)
  }
  if ($ExistedBeforeInstall) {
    $ParsedOriginal = ([System.IO.File]::ReadAllText((Join-Path $BackupDir "broker-private.env.json"))) | ConvertFrom-Json
    foreach ($Key in @("NAPCAT_HTTP_URL", "NAPCAT_ACCESS_TOKEN", "NAPCAT_HTTP_TIMEOUT_MS")) {
      if ($null -ne $ParsedOriginal.PSObject.Properties[$Key]) { $Current[$Key] = $ParsedOriginal.$Key }
    }
  }
  if ($Current.Count -eq 0 -and -not $ExistedBeforeInstall) {
    if (Test-Path -LiteralPath $PrivateEnvFile) { Remove-Item -LiteralPath $PrivateEnvFile -Force }
  } else {
    Write-Utf8NoBom -Path $PrivateEnvFile -Content (($Current | ConvertTo-Json -Depth 10) + "`n")
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $BackupDir "broker.mjs"))) {
  throw "备份目录不完整：$BackupDir"
}
if (-not $NapCatMcpRoot.StartsWith($BrokerRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "记录的 NapCat MCP 路径不在 broker 根目录内，拒绝递归处理"
}

if ($PSCmdlet.ShouldProcess($BrokerRoot, "恢复 NapCat MCP 安装前状态")) {
  New-Item -ItemType Directory -Force -Path $RollbackSafetyDir | Out-Null
  Copy-Item -LiteralPath (Join-Path $BrokerRoot "broker.mjs") -Destination (Join-Path $RollbackSafetyDir "broker.mjs") -Force
  if (Test-Path -LiteralPath $ConfigFile) {
    Copy-Item -LiteralPath $ConfigFile -Destination (Join-Path $RollbackSafetyDir "config.toml") -Force
  }
  if (Test-Path -LiteralPath $PrivateEnvFile) {
    Copy-Item -LiteralPath $PrivateEnvFile -Destination (Join-Path $RollbackSafetyDir "broker-private.env.json") -Force
  }
  if (Test-Path -LiteralPath $NapCatMcpRoot) {
    Copy-Item -LiteralPath $NapCatMcpRoot -Destination (Join-Path $RollbackSafetyDir "napcat-mcp") -Recurse -Force
  }
  Copy-Item -LiteralPath $InstallStateFile -Destination (Join-Path $RollbackSafetyDir "napcat-mcp-install.json") -Force

  Copy-Item -LiteralPath (Join-Path $BackupDir "broker.mjs") -Destination (Join-Path $BrokerRoot "broker.mjs") -Force

  Restore-ConfigPreservingLaterChanges -ExistedBeforeInstall ([bool]$State.configExisted) -InstalledSha256 ([string]$State.installedConfigSha256)
  Restore-PrivateEnvPreservingLaterChanges -ExistedBeforeInstall ([bool]$State.privateEnvExisted) -InstalledSha256 ([string]$State.installedPrivateEnvSha256)

  if (Test-Path -LiteralPath $NapCatMcpRoot) {
    Remove-Item -LiteralPath $NapCatMcpRoot -Recurse -Force
  }
  if ([bool]$State.napCatMcpExisted) {
    Copy-Item -LiteralPath (Join-Path $BackupDir "napcat-mcp") -Destination $NapCatMcpRoot -Recurse -Force
  }
  if ([bool]$State.installStateExisted) {
    Copy-Item -LiteralPath (Join-Path $BackupDir "napcat-mcp-install.json") -Destination $InstallStateFile -Force
  } elseif (Test-Path -LiteralPath $InstallStateFile) {
    Remove-Item -LiteralPath $InstallStateFile -Force
  }
}

if ($RestoreNapCatOneBotConfig) {
  $RuntimeStateFile = Join-Path $CodexHome "napcat-runtime.json"
  if (-not (Test-Path -LiteralPath $RuntimeStateFile)) {
    throw "找不到 NapCat runtime 状态：$RuntimeStateFile"
  }
  $RuntimeState = ([System.IO.File]::ReadAllText($RuntimeStateFile)) | ConvertFrom-Json
  $OneBotBackup = [string]$RuntimeState.backupDir
  if (-not (Test-Path -LiteralPath $OneBotBackup)) {
    throw "找不到 OneBot 配置备份：$OneBotBackup"
  }
  foreach ($ConfigPath in @($RuntimeState.configFiles)) {
    $BackupFile = Join-Path $OneBotBackup ([System.IO.Path]::GetFileName([string]$ConfigPath))
    if (Test-Path -LiteralPath $BackupFile) {
      Copy-Item -LiteralPath $BackupFile -Destination ([string]$ConfigPath) -Force
    }
  }
}

Write-Host "NapCat MCP 安装已回滚到：$BackupDir"
Write-Host "回滚前现场已备份到：$RollbackSafetyDir"
Write-Host "broker 未自动重启；确认无当前任务后再手动重启。"
