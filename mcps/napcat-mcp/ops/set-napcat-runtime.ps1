[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$QqExePath = "",
  [string]$QqUserDataDir = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$ExpectedQqSha256 = "",
  [string]$ExpectedNapCatSha256 = "",
  [string]$ExpectedSignerSubject = "Tencent Technology",
  [int]$MinimumQqBuild = 40768,
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

function Write-AtomicUtf8Text {
  param(
    [string]$Path,
    [string]$Value
  )
  $Directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $TemporaryPath = Join-Path $Directory ((Split-Path -Leaf $Path) + "." + [Guid]::NewGuid().ToString("N") + ".tmp")
  try {
    [System.IO.File]::WriteAllText($TemporaryPath, $Value, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $TemporaryPath -Destination $Path -Force
  } finally {
    if (Test-Path -LiteralPath $TemporaryPath) { Remove-Item -LiteralPath $TemporaryPath -Force }
  }
}

function Convert-NapCatNodeUserDataPatch {
  param([string]$Source)

  $PatchedSource = $Source
  $DataPathAlreadyPatched = $PatchedSource -match 'get dataPath\(\)[\s\S]{0,800}NAPCAT_QQ_USER_DATA_DIR'
  $StartupAlreadyPatched = $PatchedSource -match 'function zEe\(t\)[\s\S]{0,1200}NAPCAT_QQ_USER_DATA_DIR'
  $DataPathPatchable = $PatchedSource -match 'let e = this\.context\.wrapper\.NodeQQNTWrapperUtil\.getNTUserDataInfoConfig\(\);\s*return e \|\|'
  $StartupPatchable = $PatchedSource -match 'let e = t\.NodeQQNTWrapperUtil\.getNTUserDataInfoConfig\(\);\s*e \|\|'

  if (-not $DataPathAlreadyPatched) {
    if (-not $DataPathPatchable) {
      throw "NapCat node 包无法定位 core.dataPath 数据目录补丁点"
    }
    $PatchedSource = [regex]::Replace(
      $PatchedSource,
      'let e = this\.context\.wrapper\.NodeQQNTWrapperUtil\.getNTUserDataInfoConfig\(\);\s*return e \|\|',
      "let e = process.env.NAPCAT_QQ_USER_DATA_DIR?.trim();`n    return e || (e = this.context.wrapper.NodeQQNTWrapperUtil.getNTUserDataInfoConfig()), e ||",
      1
    )
  }

  if (-not $StartupAlreadyPatched) {
    if (-not $StartupPatchable) {
      throw "NapCat node 包无法定位 QQNT 启动数据目录补丁点"
    }
    $PatchedSource = [regex]::Replace(
      $PatchedSource,
      'let e = t\.NodeQQNTWrapperUtil\.getNTUserDataInfoConfig\(\);\s*e \|\|',
      "let e = process.env.NAPCAT_QQ_USER_DATA_DIR?.trim();`n  e || (e = t.NodeQQNTWrapperUtil.getNTUserDataInfoConfig());`n  e ||",
      1
    )
  }

  $DataPathPatched = $PatchedSource -match 'get dataPath\(\)[\s\S]{0,800}NAPCAT_QQ_USER_DATA_DIR'
  $StartupPatched = $PatchedSource -match 'function zEe\(t\)[\s\S]{0,1200}NAPCAT_QQ_USER_DATA_DIR'
  if (-not $DataPathPatched -or -not $StartupPatched) {
    throw "NapCat node 包数据目录补丁复核失败"
  }

  return [pscustomobject]@{
    source = $PatchedSource
    changed = $Source -ne $PatchedSource
    dataPathPatched = $DataPathPatched
    startupPatched = $StartupPatched
  }
}

function Get-NapCatNodePatchModulePaths {
  param(
    [string]$NapCatRoot,
    [string]$PrimaryModulePath,
    [string]$PacketMappingKey
  )
  $Paths = New-Object System.Collections.Generic.List[string]
  $Candidates = @(
    $PrimaryModulePath,
    (Join-Path $NapCatRoot "napcat.mjs"),
    (Join-Path $NapCatRoot "napcat\napcat.mjs")
  )
  foreach ($Candidate in $Candidates) {
    if ([string]::IsNullOrWhiteSpace($Candidate)) { continue }
    $ResolvedCandidate = [System.IO.Path]::GetFullPath($Candidate)
    if ($Paths.Contains($ResolvedCandidate)) { continue }
    if (-not (Test-Path -LiteralPath $ResolvedCandidate -PathType Leaf)) { continue }
    if ($ResolvedCandidate -ne [System.IO.Path]::GetFullPath($PrimaryModulePath)) {
      $CandidateSource = Get-Content -LiteralPath $ResolvedCandidate -Raw -Encoding UTF8
      if ($CandidateSource.IndexOf('"' + $PacketMappingKey + '"', [System.StringComparison]::Ordinal) -lt 0) { continue }
      if ($CandidateSource.IndexOf("function zEe(t)", [System.StringComparison]::Ordinal) -lt 0 -and
          $CandidateSource.IndexOf("get dataPath()", [System.StringComparison]::Ordinal) -lt 0) { continue }
    }
    $Paths.Add($ResolvedCandidate) | Out-Null
  }
  return @($Paths)
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
  $BackupRuntime = Get-Content -LiteralPath $ResolvedBackupPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $BackupDirectory = Split-Path -Parent $ResolvedBackupPath
  $PatchManifestPath = Join-Path $BackupDirectory "napcat-runtime-patch-manifest.json"
  $ModuleRollbacks = @()
  if (Test-Path -LiteralPath $PatchManifestPath -PathType Leaf) {
    $PatchManifest = Get-Content -LiteralPath $PatchManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ManifestRoot = [string]$PatchManifest.napCatRoot
    if ([string]::IsNullOrWhiteSpace($ManifestRoot)) { $ManifestRoot = [string]$BackupRuntime.napCatRoot }
    if ([string]::IsNullOrWhiteSpace($ManifestRoot)) { throw "NapCat module 回滚清单缺少 napCatRoot" }
    $ResolvedManifestRoot = [System.IO.Path]::GetFullPath($ManifestRoot).TrimEnd('\') + '\'
    foreach ($Module in @($PatchManifest.modules)) {
      $ModulePath = [System.IO.Path]::GetFullPath([string]$Module.modulePath)
      $ModuleBackupPath = [System.IO.Path]::GetFullPath([string]$Module.backupPath)
      $ResolvedBackupDirectory = [System.IO.Path]::GetFullPath($BackupDirectory).TrimEnd('\') + '\'
      if (-not $ModulePath.StartsWith($ResolvedManifestRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "NapCat module 回滚目标不在 NapCatRoot 下：$ModulePath"
      }
      if (-not $ModuleBackupPath.StartsWith($ResolvedBackupDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "NapCat module 回滚备份不在同一备份目录下：$ModuleBackupPath"
      }
      if (-not (Test-Path -LiteralPath $ModuleBackupPath -PathType Leaf)) {
        throw "找不到 NapCat module 回滚备份：$ModuleBackupPath"
      }
      $BackupModuleHash = Get-NormalizedHash -Path $ModuleBackupPath
      if (-not [string]::IsNullOrWhiteSpace([string]$Module.beforeSha256) -and $BackupModuleHash -ne ([string]$Module.beforeSha256).ToUpperInvariant()) {
        throw "NapCat module 回滚备份哈希不匹配：$ModuleBackupPath"
      }
      $ModuleRollbacks += [ordered]@{
        modulePath = $ModulePath
        backupPath = $ModuleBackupPath
        beforeSha256 = if (Test-Path -LiteralPath $ModulePath -PathType Leaf) { Get-NormalizedHash -Path $ModulePath } else { $null }
        expectedSha256 = $BackupModuleHash
        afterSha256 = $null
        changed = $false
      }
    }
  }
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
  foreach ($ModuleRollback in $ModuleRollbacks) {
    [System.IO.File]::WriteAllBytes([string]$ModuleRollback.modulePath, [System.IO.File]::ReadAllBytes([string]$ModuleRollback.backupPath))
    $ModuleAfterHash = Get-NormalizedHash -Path ([string]$ModuleRollback.modulePath)
    if ($ModuleAfterHash -ne [string]$ModuleRollback.expectedSha256) {
      throw "NapCat module 回滚后的字节哈希不匹配：$($ModuleRollback.modulePath)"
    }
    $ModuleRollback["afterSha256"] = $ModuleAfterHash
    $ModuleRollback["changed"] = [string]$ModuleRollback.beforeSha256 -ne $ModuleAfterHash
  }
  [pscustomobject]@{
    action = "rollback"
    changed = ($BeforeHash -ne $AfterHash) -or [bool]($ModuleRollbacks | Where-Object { $_.changed } | Select-Object -First 1)
    runtimePath = $RuntimePath
    backupPath = $ResolvedBackupPath
    beforeSha256 = $BeforeHash
    afterSha256 = $AfterHash
    moduleRollbackManifestPath = if (Test-Path -LiteralPath $PatchManifestPath -PathType Leaf) { $PatchManifestPath } else { $null }
    moduleRollbacks = $ModuleRollbacks
  } | ConvertTo-Json -Depth 10
  exit 0
}

if (-not (Test-Path -LiteralPath $RuntimePath -PathType Leaf)) {
  throw "找不到 NapCat runtime：$RuntimePath"
}

if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  throw "配置或验证 NapCat 运行环境时必须提供 -NapCatRoot"
}
if (-not [System.IO.Path]::IsPathRooted($NapCatRoot)) {
  throw "NapCatRoot 必须是绝对路径"
}
$NapCatRoot = [System.IO.Path]::GetFullPath($NapCatRoot).TrimEnd('\')
$UsesIndependentQq = -not [string]::IsNullOrWhiteSpace($QqExePath)
if ($UsesIndependentQq) {
  if (-not [System.IO.Path]::IsPathRooted($QqExePath)) {
    throw "QqExePath 必须是绝对路径"
  }
  $QqExePath = [System.IO.Path]::GetFullPath($QqExePath)
}
$ResolvedQqUserDataDir = $null
if (-not [string]::IsNullOrWhiteSpace($QqUserDataDir)) {
  if (-not [System.IO.Path]::IsPathRooted($QqUserDataDir)) {
    throw "QqUserDataDir 必须是绝对路径"
  }
  $ResolvedQqUserDataDir = [System.IO.Path]::GetFullPath($QqUserDataDir).TrimEnd('\')
}
$DefaultNapCatModulePath = Join-Path $NapCatRoot "napcat.mjs"
$NodeNapCatModulePath = Join-Path $NapCatRoot "napcat\napcat.mjs"
$NapCatModulePath = if ($UsesIndependentQq -or -not (Test-Path -LiteralPath $NodeNapCatModulePath -PathType Leaf)) {
  $DefaultNapCatModulePath
} else {
  $NodeNapCatModulePath
}
$RequiredPaths = @($NapCatModulePath)
if ($UsesIndependentQq) {
  $RequiredPaths += @(
    $QqExePath,
    (Join-Path $NapCatRoot "NapCatWinBootMain.exe"),
    (Join-Path $NapCatRoot "NapCatWinBootHook.dll")
  )
} else {
  $RequiredPaths += @(
    (Join-Path $NapCatRoot "launcher-user.bat"),
    (Join-Path $NapCatRoot "napcat.bat"),
    (Join-Path $NapCatRoot "node.exe"),
    (Join-Path $NapCatRoot "index.js"),
    (Join-Path $NapCatRoot "package.json"),
    (Join-Path $NapCatRoot "config.json")
  )
}
foreach ($RequiredPath in $RequiredPaths) {
  if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
    throw "NapCat 运行环境缺少文件：$RequiredPath"
  }
}

$QqSha256 = $null
$QqVersion = $null
$SignerSubject = $null
$PacketMappingKey = $null
if ($UsesIndependentQq) {
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
  $QqBuild = [int]$Matches[2]
  if ($MinimumQqBuild -gt 0 -and $QqBuild -lt $MinimumQqBuild) {
    throw "独立 QQ 版本低于 NapCat 官方最低支持 build：version=$QqVersion build=$QqBuild minimum=$MinimumQqBuild"
  }
  $PacketMappingKey = "$($Matches[1])-$QqBuild-x64"
  $QqSha256 = Test-ExpectedHash -Path $QqExePath -Expected $ExpectedQqSha256 -Label "QQ.exe"
} else {
  $PackageJson = Get-Content -LiteralPath (Join-Path $NapCatRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  $QqVersion = [string]$PackageJson.version
  if ($QqVersion -notmatch '^(\d+\.\d+\.\d+)-(\d+)(?:\s.*)?$') {
    throw "无法从 NapCat node 包 package.json 读取受支持的 QQ 版本号：$QqVersion"
  }
  $QqBuild = [int]$Matches[2]
  if ($MinimumQqBuild -gt 0 -and $QqBuild -lt $MinimumQqBuild) {
    throw "NapCat node 包 QQ 版本低于 NapCat 官方最低支持 build：version=$QqVersion build=$QqBuild minimum=$MinimumQqBuild"
  }
  $PacketMappingKey = "$($Matches[1])-$QqBuild-x64"
}
$NapCatSource = Get-Content -LiteralPath $NapCatModulePath -Raw -Encoding UTF8
if ($NapCatSource.IndexOf('"' + $PacketMappingKey + '"', [System.StringComparison]::Ordinal) -lt 0) {
  throw "NapCat PacketBackend 不包含独立 QQ 的精确映射：$PacketMappingKey"
}
$NapCatSha256 = Test-ExpectedHash -Path $NapCatModulePath -Expected $ExpectedNapCatSha256 -Label "napcat.mjs"
$NodeUserDataPatch = $null
if (-not $UsesIndependentQq -and -not [string]::IsNullOrWhiteSpace($ResolvedQqUserDataDir)) {
  $PatchModules = @()
  foreach ($PatchModulePath in (Get-NapCatNodePatchModulePaths -NapCatRoot $NapCatRoot -PrimaryModulePath $NapCatModulePath -PacketMappingKey $PacketMappingKey)) {
    $PatchModuleSource = Get-Content -LiteralPath $PatchModulePath -Raw -Encoding UTF8
    $PatchPreview = Convert-NapCatNodeUserDataPatch -Source $PatchModuleSource
    $PatchModules += [ordered]@{
      modulePath = $PatchModulePath
      changed = $false
      wouldChange = [bool]$PatchPreview.changed
      dataPathPatched = [bool]$PatchPreview.dataPathPatched
      startupPatched = [bool]$PatchPreview.startupPatched
      backupPath = $null
      beforeSha256 = Get-NormalizedHash -Path $PatchModulePath
      afterSha256 = Get-NormalizedHash -Path $PatchModulePath
    }
  }
  if ($PatchModules.Count -le 0) { throw "NapCat node 包没有可验证的数据目录补丁入口" }
  $NodeUserDataPatch = [ordered]@{
    enabled = $true
    modulePath = $NapCatModulePath
    changed = $false
    wouldChange = [bool]($PatchModules | Where-Object { $_.wouldChange } | Select-Object -First 1)
    dataPathPatched = [bool](-not ($PatchModules | Where-Object { -not $_.dataPathPatched } | Select-Object -First 1))
    startupPatched = [bool](-not ($PatchModules | Where-Object { -not $_.startupPatched } | Select-Object -First 1))
    backupPath = $null
    beforeSha256 = $NapCatSha256
    afterSha256 = $NapCatSha256
    modules = $PatchModules
    rollbackManifestPath = $null
  }
} else {
  $NodeUserDataPatch = [ordered]@{
    enabled = $false
    modulePath = $NapCatModulePath
    changed = $false
    wouldChange = $false
    dataPathPatched = $null
    startupPatched = $null
    backupPath = $null
    beforeSha256 = $NapCatSha256
    afterSha256 = $NapCatSha256
    modules = @()
    rollbackManifestPath = $null
  }
}
$CurrentBytes = [System.IO.File]::ReadAllBytes($RuntimePath)
$CurrentHash = Get-NormalizedHash -Path $RuntimePath
$CurrentRuntime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
$TargetRuntime = [ordered]@{}
foreach ($Property in $CurrentRuntime.PSObject.Properties) { $TargetRuntime[$Property.Name] = $Property.Value }
if (-not $TargetRuntime.Contains("schemaVersion")) { $TargetRuntime["schemaVersion"] = 1 }
$TargetRuntime["napCatRoot"] = $NapCatRoot
if ($UsesIndependentQq) {
  $TargetRuntime["qqExePath"] = $QqExePath
} elseif ($TargetRuntime.Contains("qqExePath")) {
  $TargetRuntime.Remove("qqExePath")
}
if (-not [string]::IsNullOrWhiteSpace($ResolvedQqUserDataDir)) {
  $TargetRuntime["qqUserDataDir"] = $ResolvedQqUserDataDir
} elseif ($TargetRuntime.Contains("qqUserDataDir")) {
  $TargetRuntime.Remove("qqUserDataDir")
}

if ($ValidateOnly) {
  [pscustomobject]@{
    action = "validate"
    changed = $false
    runtimePath = $RuntimePath
    currentSha256 = $CurrentHash
    napCatRoot = $NapCatRoot
    napCatSha256 = $NapCatSha256
    qqExePath = if ($UsesIndependentQq) { $QqExePath } else { $null }
    qqUserDataDir = $ResolvedQqUserDataDir
    qqSha256 = $QqSha256
    qqVersion = $QqVersion
    qqBuild = $QqBuild
    minimumQqBuild = $MinimumQqBuild
    packetMappingKey = $PacketMappingKey
    signerSubject = $SignerSubject
    nodeUserDataPatch = $NodeUserDataPatch
  } | ConvertTo-Json -Depth 10
  exit 0
}

$Timestamp = [DateTime]::UtcNow.ToString("yyyyMMddTHHmmss.fffZ")
$BackupDirectory = Join-Path $BackupRoot $Timestamp
$BackupFile = Join-Path $BackupDirectory "napcat-runtime.json"
New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
[System.IO.File]::WriteAllBytes($BackupFile, $CurrentBytes)
if ((Get-NormalizedHash -Path $BackupFile) -ne $CurrentHash) { throw "NapCat runtime 备份字节哈希不匹配" }
$NapCatModuleBackupFile = $null

try {
  if ($NodeUserDataPatch.enabled) {
    $UpdatedModules = @()
    $ModuleIndex = 0
    foreach ($ModulePatch in $NodeUserDataPatch.modules) {
      $PatchModulePath = [string]$ModulePatch.modulePath
      $PatchModuleSource = Get-Content -LiteralPath $PatchModulePath -Raw -Encoding UTF8
      $PatchModuleHash = Get-NormalizedHash -Path $PatchModulePath
      $PatchResult = Convert-NapCatNodeUserDataPatch -Source $PatchModuleSource
      if ($PatchResult.changed) {
        $ModuleIndex += 1
        $Leaf = (Split-Path -Leaf (Split-Path -Parent $PatchModulePath)) + "-" + (Split-Path -Leaf $PatchModulePath)
        $NapCatModuleBackupFile = Join-Path $BackupDirectory ("module-$ModuleIndex-$Leaf")
        [System.IO.File]::WriteAllBytes($NapCatModuleBackupFile, [System.IO.File]::ReadAllBytes($PatchModulePath))
        if ((Get-NormalizedHash -Path $NapCatModuleBackupFile) -ne $PatchModuleHash) { throw "NapCat module 备份字节哈希不匹配" }
        Write-AtomicUtf8Text -Path $PatchModulePath -Value $PatchResult.source
        $PatchedNapCatSource = Get-Content -LiteralPath $PatchModulePath -Raw -Encoding UTF8
        $PatchedPreview = Convert-NapCatNodeUserDataPatch -Source $PatchedNapCatSource
        if ($PatchedPreview.changed) { throw "NapCat node 包数据目录补丁写入后仍未稳定" }
        $ModulePatch["changed"] = $true
        $ModulePatch["backupPath"] = $NapCatModuleBackupFile
        $ModulePatch["afterSha256"] = Get-NormalizedHash -Path $PatchModulePath
      }
      $ModulePatch["wouldChange"] = $false
      $ModulePatch["dataPathPatched"] = $true
      $ModulePatch["startupPatched"] = $true
      $UpdatedModules += $ModulePatch
      if ($PatchModulePath -eq $NapCatModulePath) {
        $NodeUserDataPatch["backupPath"] = $ModulePatch.backupPath
        $NodeUserDataPatch["afterSha256"] = $ModulePatch.afterSha256
      }
    }
    $NodeUserDataPatch["modules"] = $UpdatedModules
    $NodeUserDataPatch["changed"] = [bool]($UpdatedModules | Where-Object { $_.changed } | Select-Object -First 1)
    $NodeUserDataPatch["wouldChange"] = $false
    $NodeUserDataPatch["dataPathPatched"] = $true
    $NodeUserDataPatch["startupPatched"] = $true
    $PatchedModules = @($UpdatedModules | Where-Object { $_.changed })
    if ($PatchedModules.Count -gt 0) {
      $PatchManifestPath = Join-Path $BackupDirectory "napcat-runtime-patch-manifest.json"
      Write-AtomicUtf8Json -Path $PatchManifestPath -Value ([ordered]@{
        schemaVersion = 1
        createdAt = [DateTime]::UtcNow.ToString("o")
        napCatRoot = $NapCatRoot
        runtimePath = $RuntimePath
        qqUserDataDir = $ResolvedQqUserDataDir
        packetMappingKey = $PacketMappingKey
        modules = $PatchedModules
      })
      $NodeUserDataPatch["rollbackManifestPath"] = $PatchManifestPath
    }
  }
  Write-AtomicUtf8Json -Path $RuntimePath -Value $TargetRuntime
  $AppliedRuntime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$AppliedRuntime.napCatRoot -ne $NapCatRoot -or [string]$AppliedRuntime.qqExePath -ne $QqExePath) {
    throw "NapCat runtime 写入后复核失败"
  }
  if (-not [string]::IsNullOrWhiteSpace($ResolvedQqUserDataDir) -and [string]$AppliedRuntime.qqUserDataDir -ne $ResolvedQqUserDataDir) {
    throw "NapCat runtime 写入后独立 QQ 数据目录复核失败"
  }
} catch {
  if ($NodeUserDataPatch.enabled -and $NodeUserDataPatch.modules) {
    foreach ($ModulePatch in $NodeUserDataPatch.modules) {
      if ($ModulePatch.backupPath -and (Test-Path -LiteralPath $ModulePatch.backupPath -PathType Leaf)) {
        [System.IO.File]::WriteAllBytes([string]$ModulePatch.modulePath, [System.IO.File]::ReadAllBytes([string]$ModulePatch.backupPath))
      }
    }
  } elseif ($null -ne $NapCatModuleBackupFile -and (Test-Path -LiteralPath $NapCatModuleBackupFile -PathType Leaf)) {
    [System.IO.File]::WriteAllBytes($NapCatModulePath, [System.IO.File]::ReadAllBytes($NapCatModuleBackupFile))
  }
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
  qqExePath = if ($UsesIndependentQq) { $QqExePath } else { $null }
  qqUserDataDir = $ResolvedQqUserDataDir
  qqSha256 = $QqSha256
  qqVersion = $QqVersion
  qqBuild = $QqBuild
  minimumQqBuild = $MinimumQqBuild
  packetMappingKey = $PacketMappingKey
  signerSubject = $SignerSubject
  nodeUserDataPatch = $NodeUserDataPatch
} | ConvertTo-Json -Depth 10
