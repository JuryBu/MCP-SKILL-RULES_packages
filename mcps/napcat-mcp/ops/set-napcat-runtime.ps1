[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$QqExePath = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$ExpectedQqSha256 = "",
  [string]$ExpectedNapCatSha256 = "",
  [string]$ExpectedSignerSubject = "Tencent Technology",
  [switch]$ValidateOnly,
  [switch]$Rollback,
  [string]$BackupPath = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $BrokerRoot
$RuntimePath = Join-Path $DataRoot "napcat-runtime.json"
$BackupRoot = Join-Path $DataRoot "backups\napcat-runtime"

function Get-NormalizedHash {
  param([string]$Path)
  return ([string](Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash).ToUpperInvariant()
}

function Test-ExpectedHash {
  param(
    [string]$Path,
    [string]$Expected,
    [string]$Label
  )
  $Actual = Get-NormalizedHash -Path $Path
  if (-not [string]::IsNullOrWhiteSpace($Expected) -and $Actual -ne $Expected.Trim().ToUpperInvariant()) {
    throw "$Label SHA256 不匹配。expected=$Expected actual=$Actual path=$Path"
  }
  return $Actual
}

function Write-AtomicUtf8Json {
  param(
    [string]$Path,
    [object]$Value
  )
  $Directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $TemporaryPath = Join-Path $Directory ((Split-Path -Leaf $Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
  try {
    $Json = $Value | ConvertTo-Json -Depth 100
    [System.IO.File]::WriteAllText($TemporaryPath, $Json + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $TemporaryPath -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath) { Remove-Item -LiteralPath $TemporaryPath -Force }
  }
}

if ($Rollback) {
  if ($ValidateOnly) { throw "-Rollback 与 -ValidateOnly 不能同时使用" }
  if ([string]::IsNullOrWhiteSpace($BackupPath)) { throw "回滚必须提供 -BackupPath" }
  $ResolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRoot).TrimEnd('\') + '\'
  $ResolvedBackupPath = [System.IO.Path]::GetFullPath($BackupPath)
  if (-not $ResolvedBackupPath.StartsWith($ResolvedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "回滚备份必须位于 NapCat runtime 备份目录：$ResolvedBackupRoot"
  }
  if (-not (Test-Path -LiteralPath $ResolvedBackupPath -PathType Leaf)) {
    throw "找不到回滚备份：$ResolvedBackupPath"
  }
  $null = Get-Content -LiteralPath $ResolvedBackupPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $BeforeHash = if (Test-Path -LiteralPath $RuntimePath -PathType Leaf) {
    Get-NormalizedHash -Path $RuntimePath
  } else {
    $null
  }
  $TemporaryPath = $RuntimePath + "." + [Guid]::NewGuid().ToString("N") + ".rollback.tmp"
  try {
    Copy-Item -LiteralPath $ResolvedBackupPath -Destination $TemporaryPath -Force
    Move-Item -LiteralPath $TemporaryPath -Destination $RuntimePath -Force
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath) { Remove-Item -LiteralPath $TemporaryPath -Force }
  }
  $AfterHash = Get-NormalizedHash -Path $RuntimePath
  $ExpectedHash = Get-NormalizedHash -Path $ResolvedBackupPath
  if ($AfterHash -ne $ExpectedHash) { throw "NapCat runtime 回滚后的字节哈希不匹配" }
  [pscustomobject]@{
    action = "rollback"
    changed = $BeforeHash -ne $AfterHash
    runtimePath = $RuntimePath
    backupPath = $ResolvedBackupPath
    beforeSha256 = $BeforeHash
    afterSha256 = $AfterHash
  } | ConvertTo-Json -Depth 10
  exit 0
}

if (-not (Test-Path -LiteralPath $RuntimePath -PathType Leaf)) {
  throw "找不到 NapCat runtime：$RuntimePath"
}

if ([string]::IsNullOrWhiteSpace($NapCatRoot) -or [string]::IsNullOrWhiteSpace($QqExePath)) {
  throw "配置或验证独立 QQ 运行环境时必须同时提供 -NapCatRoot 与 -QqExePath"
}
if (-not [System.IO.Path]::IsPathRooted($NapCatRoot) -or -not [System.IO.Path]::IsPathRooted($QqExePath)) {
  throw "NapCatRoot 与 QqExePath 必须是绝对路径"
}
$NapCatRoot = [System.IO.Path]::GetFullPath($NapCatRoot).TrimEnd('\')
$QqExePath = [System.IO.Path]::GetFullPath($QqExePath)
$RequiredPaths = @(
  $QqExePath,
  (Join-Path $NapCatRoot "napcat.mjs"),
  (Join-Path $NapCatRoot "NapCatWinBootMain.exe"),
  (Join-Path $NapCatRoot "NapCatWinBootHook.dll")
)
foreach ($RequiredPath in $RequiredPaths) {
  if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
    throw "独立 QQ 运行环境缺少文件：$RequiredPath"
  }
}

$QqSignature = Get-AuthenticodeSignature -LiteralPath $QqExePath
if ([string]$QqSignature.Status -ne "Valid") {
  throw "独立 QQ 主程序签名无效：status=$($QqSignature.Status) path=$QqExePath"
}
$SignerSubject = [string]$QqSignature.SignerCertificate.Subject
if ([string]::IsNullOrWhiteSpace($ExpectedSignerSubject) -or $SignerSubject.IndexOf($ExpectedSignerSubject, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  throw "独立 QQ 主程序签名主体不匹配。expectedContains=$ExpectedSignerSubject actual=$SignerSubject"
}
$QqVersion = [string](Get-Item -LiteralPath $QqExePath).VersionInfo.FileVersion
if ($QqVersion -notmatch '^(\d+\.\d+\.\d+)\.(\d+)(?:\s.*)?$') {
  throw "无法从独立 QQ 主程序读取受支持的四段版本号：$QqVersion"
}
$PacketMappingKey = "$($Matches[1])-$($Matches[2])-x64"
$NapCatModulePath = Join-Path $NapCatRoot "napcat.mjs"
$NapCatSource = Get-Content -LiteralPath $NapCatModulePath -Raw -Encoding UTF8
if ($NapCatSource.IndexOf('"' + $PacketMappingKey + '"', [System.StringComparison]::Ordinal) -lt 0) {
  throw "NapCat PacketBackend 不包含独立 QQ 的精确映射：$PacketMappingKey"
}
$QqSha256 = Test-ExpectedHash -Path $QqExePath -Expected $ExpectedQqSha256 -Label "QQ.exe"
$NapCatSha256 = Test-ExpectedHash -Path $NapCatModulePath -Expected $ExpectedNapCatSha256 -Label "napcat.mjs"
$CurrentBytes = [System.IO.File]::ReadAllBytes($RuntimePath)
$CurrentHash = Get-NormalizedHash -Path $RuntimePath
$CurrentRuntime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
$TargetRuntime = [ordered]@{}
foreach ($Property in $CurrentRuntime.PSObject.Properties) { $TargetRuntime[$Property.Name] = $Property.Value }
if (-not $TargetRuntime.Contains("schemaVersion")) { $TargetRuntime["schemaVersion"] = 1 }
$TargetRuntime["napCatRoot"] = $NapCatRoot
$TargetRuntime["qqExePath"] = $QqExePath

if ($ValidateOnly) {
  [pscustomobject]@{
    action = "validate"
    changed = $false
    runtimePath = $RuntimePath
    currentSha256 = $CurrentHash
    napCatRoot = $NapCatRoot
    napCatSha256 = $NapCatSha256
    qqExePath = $QqExePath
    qqSha256 = $QqSha256
    qqVersion = $QqVersion
    packetMappingKey = $PacketMappingKey
    signerSubject = $SignerSubject
  } | ConvertTo-Json -Depth 10
  exit 0
}

$Timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmss.fffZ")
$BackupDirectory = Join-Path $BackupRoot $Timestamp
$BackupFile = Join-Path $BackupDirectory "napcat-runtime.json"
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
[System.IO.File]::WriteAllBytes($BackupFile, $CurrentBytes)
if ((Get-NormalizedHash -Path $BackupFile) -ne $CurrentHash) { throw "NapCat runtime 备份字节哈希不匹配" }

try {
  Write-AtomicUtf8Json -Path $RuntimePath -Value $TargetRuntime
  $AppliedRuntime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$AppliedRuntime.napCatRoot -ne $NapCatRoot -or [string]$AppliedRuntime.qqExePath -ne $QqExePath) {
    throw "NapCat runtime 写入后复核失败"
  }
} catch {
  [System.IO.File]::WriteAllBytes($RuntimePath, [System.IO.File]::ReadAllBytes($BackupFile))
  throw
}

$AppliedHash = Get-NormalizedHash -Path $RuntimePath
[pscustomobject]@{
  action = "apply"
  changed = $CurrentHash -ne $AppliedHash
  runtimePath = $RuntimePath
  backupPath = $BackupFile
  beforeSha256 = $CurrentHash
  afterSha256 = $AppliedHash
  napCatRoot = $NapCatRoot
  napCatSha256 = $NapCatSha256
  qqExePath = $QqExePath
  qqSha256 = $QqSha256
  qqVersion = $QqVersion
  packetMappingKey = $PacketMappingKey
  signerSubject = $SignerSubject
} | ConvertTo-Json -Depth 10
