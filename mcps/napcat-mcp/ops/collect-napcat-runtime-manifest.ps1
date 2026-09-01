[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$CodexHome = "",
  [ValidateRange(1, 30)][int]$Days = 5,
  [ValidateRange(1, 200)][int]$MaxRecentEvents = 60
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")

if ([string]::IsNullOrWhiteSpace($CodexHome)) { $CodexHome = Join-Path $env:USERPROFILE ".codex" }
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_TOOLKIT_BROKER_ROOT)) {
    $BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT
  } else {
    $BrokerRoot = Join-Path $CodexHome "mcp-http-broker"
  }
}

$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $BrokerRoot
$RuntimeStateFile = Join-Path $DataRoot "napcat-runtime.json"
$RuntimeConfiguration = $null
if (Test-Path -LiteralPath $RuntimeStateFile -PathType Leaf) {
  try { $RuntimeConfiguration = Get-Content -LiteralPath $RuntimeStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $RuntimeConfiguration = $null }
}

if ([string]::IsNullOrWhiteSpace($NapCatRoot) -and $null -ne $RuntimeConfiguration) {
  $NapCatRoot = [string]$RuntimeConfiguration.napCatRoot
}
if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  throw "NapCatRoot 未配置，且 $RuntimeStateFile 不存在或不可读"
}
$NapCatRoot = [System.IO.Path]::GetFullPath($NapCatRoot)

function Read-JsonFile {
  param([string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-FileFingerprint {
  param([string]$Path)
  $ResolvedPath = if ([string]::IsNullOrWhiteSpace($Path)) { "" } else { [System.IO.Path]::GetFullPath($Path) }
  if ([string]::IsNullOrWhiteSpace($ResolvedPath) -or -not (Test-Path -LiteralPath $ResolvedPath -PathType Leaf)) {
    return [pscustomobject]@{
      present = $false
      path = $ResolvedPath
    }
  }
  $Item = Get-Item -LiteralPath $ResolvedPath
  $Version = $null
  if ($ResolvedPath -match '\.(exe|dll)$') {
    try { $Version = $Item.VersionInfo.FileVersion } catch { $Version = $null }
  }
  return [pscustomobject]@{
    present = $true
    path = $ResolvedPath
    bytes = $Item.Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $ResolvedPath).Hash
    fileVersion = $Version
  }
}

function Get-ProcessCreationTimeText {
  param([object]$Process)
  try {
    $CreatedAt = [Management.ManagementDateTimeConverter]::ToDateTime($Process.CreationDate)
    return "{0:yyyy-MM-dd HH:mm:ss}" -f $CreatedAt
  } catch {
    return [string]$Process.CreationDate
  }
}

function Remove-Ansi {
  param([string]$Text)
  if ($null -eq $Text) { return "" }
  $Escape = [char]27
  return ([regex]::Replace($Text, "$Escape\[[0-9;]*[A-Za-z]", ""))
}

function Convert-NapCatLogTime {
  param([string]$Text)
  if ($Text -match '^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$') {
    $Year = (Get-Date).Year
    return "{0:D4}-{1}-{2} {3}:{4}:{5}" -f $Year, $Matches[1], $Matches[2], $Matches[3], $Matches[4], $Matches[5]
  }
  return $Text
}

$Binding = Read-JsonFile -Path (Join-Path $DataRoot "binding.json")
$ExpectedSelfId = if ($null -ne $Binding) { [string]$Binding.expectedSelfId } else { "" }
$QqUserDataDir = if ($null -ne $RuntimeConfiguration) { [string]$RuntimeConfiguration.qqUserDataDir } else { "" }
if (-not [string]::IsNullOrWhiteSpace($QqUserDataDir)) {
  $QqUserDataDir = [System.IO.Path]::GetFullPath($QqUserDataDir)
}
$RuntimeSummary = if ($null -ne $RuntimeConfiguration) {
  [pscustomobject]@{
    schemaVersion = $RuntimeConfiguration.schemaVersion
    napCatRoot = $RuntimeConfiguration.napCatRoot
    qqExePath = $RuntimeConfiguration.qqExePath
    qqUserDataDir = $RuntimeConfiguration.qqUserDataDir
    minimumQqBuild = $RuntimeConfiguration.minimumQqBuild
    qqVersion = $RuntimeConfiguration.qqVersion
    qqBuild = $RuntimeConfiguration.qqBuild
    packageSha256 = $RuntimeConfiguration.packageSha256
    configuredAt = $RuntimeConfiguration.configuredAt
  }
} else {
  $null
}

$PackageJson = Read-JsonFile -Path (Join-Path $NapCatRoot "package.json")
$ConfigJson = Read-JsonFile -Path (Join-Path $NapCatRoot "config.json")
$QqntJson = Read-JsonFile -Path (Join-Path $NapCatRoot "napcat\qqnt.json")

$CandidateQqExePaths = New-Object System.Collections.Generic.List[string]
if ($null -ne $RuntimeConfiguration -and -not [string]::IsNullOrWhiteSpace([string]$RuntimeConfiguration.qqExePath)) {
  $CandidateQqExePaths.Add([string]$RuntimeConfiguration.qqExePath) | Out-Null
}
@(Get-ChildItem -LiteralPath $NapCatRoot -Filter "QQ.exe" -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 8) |
  ForEach-Object { $CandidateQqExePaths.Add($_.FullName) | Out-Null }

$KeyFiles = [ordered]@{
  index = Join-Path $NapCatRoot "index.js"
  napcatMjs = Join-Path $NapCatRoot "napcat\napcat.mjs"
  launcherUser = Join-Path $NapCatRoot "launcher-user.bat"
  legacyLauncher = Join-Path $NapCatRoot "napcat.bat"
  bootMain = Join-Path $NapCatRoot "NapCatWinBootMain.exe"
  bootHook = Join-Path $NapCatRoot "NapCatWinBootHook.dll"
  nestedBootMain = Join-Path $NapCatRoot "napcat\NapCatWinBootMain.exe"
  nestedBootHook = Join-Path $NapCatRoot "napcat\NapCatWinBootHook.dll"
}
$FileFingerprints = [ordered]@{}
foreach ($Entry in $KeyFiles.GetEnumerator()) {
  $FileFingerprints[$Entry.Key] = Get-FileFingerprint -Path $Entry.Value
}
$FileFingerprints["qqExeCandidates"] = @($CandidateQqExePaths.ToArray() | Select-Object -Unique | ForEach-Object { Get-FileFingerprint -Path $_ })

$Cutoff = (Get-Date).AddDays(-1 * $Days)
$LogDirectory = Join-Path $NapCatRoot "logs"
$Events = New-Object System.Collections.Generic.List[object]
if (Test-Path -LiteralPath $LogDirectory) {
  Get-ChildItem -LiteralPath $LogDirectory -Filter "codex-login-*.log" -File |
    Where-Object { $_.LastWriteTime -ge $Cutoff } |
    Sort-Object LastWriteTime |
    ForEach-Object {
      $Leaf = $_.Name
      foreach ($RawLine in (Get-Content -LiteralPath $_.FullName -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        $Line = Remove-Ansi -Text $RawLine
        if ($Line -match '^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(info|warn|error|debug)\]\s+(.*)$') {
          $Message = $Matches[3]
          if ($Message -match '正在快速登录|Worker进程已登录成功|本账号数据/缓存目录|KickedOffLine|账号状态变更为离线|快速登录错误|登录态已失效|用户身份已失效|二维码已保存|proofWaterUrl|sms-verify-login|短信验证|验证码|WebUi User Panel Url') {
            $Events.Add([pscustomobject]@{
              time = Convert-NapCatLogTime -Text $Matches[1]
              level = $Matches[2]
              event = $Message
              file = $Leaf
            }) | Out-Null
          }
        }
      }
    }
}

$LogCounters = [ordered]@{
  workerLoginSuccess = (@($Events | Where-Object { $_.event -match 'Worker进程已登录成功' })).Count
  kickedOffLine = (@($Events | Where-Object { $_.event -match 'KickedOffLine|账号状态变更为离线' })).Count
  quickLoginInvalid = (@($Events | Where-Object { $_.event -match '快速登录错误|登录态已失效|用户身份已失效' })).Count
  qrGenerated = (@($Events | Where-Object { $_.event -match '二维码已保存|WebUi User Panel Url' })).Count
  humanVerification = (@($Events | Where-Object { $_.event -match 'proofWaterUrl|sms-verify-login|短信验证|验证码' })).Count
}

$Processes = @(Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(QQ|node|cmd|NapCatWinBootMain)\.exe$' -and
    ($_.CommandLine -match 'NapCat|QQNT|Tencent|3406694168|1559404764' -or $_.ExecutablePath -match 'NapCat|QQNT|Tencent')
  } |
  ForEach-Object {
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      name = $_.Name
      createdAt = Get-ProcessCreationTimeText -Process $_
      executablePath = $_.ExecutablePath
      commandLine = $_.CommandLine
    }
  })

$PackageSummary = [pscustomobject]@{
  packageJsonName = $null
  packageJsonVersion = $null
  configVersion = $null
  configQqVersion = $null
  qqntJson = $QqntJson
}
if ($null -ne $PackageJson) {
  $PackageSummary.packageJsonName = $PackageJson.name
  $PackageSummary.packageJsonVersion = $PackageJson.version
}
if ($null -ne $ConfigJson) {
  $PackageSummary.configVersion = $ConfigJson.version
  $PackageSummary.configQqVersion = $ConfigJson.qqVersion
}

[pscustomobject]@{
  generatedAt = "{0:yyyy-MM-dd HH:mm:ss zzz}" -f (Get-Date)
  napCatRoot = $NapCatRoot
  dataRoot = $DataRoot
  expectedSelfId = $ExpectedSelfId
  qqUserDataDir = $QqUserDataDir
  runtimeConfiguration = $RuntimeSummary
  package = $PackageSummary
  files = $FileFingerprints
  logWindowDays = $Days
  logCounters = $LogCounters
  recentLoginEvents = @($Events.ToArray() | Select-Object -Last $MaxRecentEvents)
  relevantProcesses = $Processes
} | ConvertTo-Json -Depth 10
