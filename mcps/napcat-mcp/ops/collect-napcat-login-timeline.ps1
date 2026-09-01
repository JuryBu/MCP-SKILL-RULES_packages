[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$CodexHome = "",
  [string]$QqUserDataDir = "",
  [string]$LegacyTencentFilesDir = "",
  [ValidateRange(1, 30)][int]$Days = 5,
  [ValidateRange(1, 200)][int]$MaxAttempts = 40
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
if ([string]::IsNullOrWhiteSpace($QqUserDataDir) -and $null -ne $RuntimeConfiguration) {
  $QqUserDataDir = [string]$RuntimeConfiguration.qqUserDataDir
}
if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  throw "NapCatRoot 未配置，且 $RuntimeStateFile 不存在或不可读"
}
$NapCatRoot = [System.IO.Path]::GetFullPath($NapCatRoot)
if (-not [string]::IsNullOrWhiteSpace($QqUserDataDir)) {
  $QqUserDataDir = [System.IO.Path]::GetFullPath($QqUserDataDir)
}

$BindingPath = Join-Path $DataRoot "binding.json"
$ExpectedSelfId = ""
if (Test-Path -LiteralPath $BindingPath -PathType Leaf) {
  try {
    $Binding = Get-Content -LiteralPath $BindingPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $ExpectedSelfId = [string]$Binding.expectedSelfId
  } catch {
    $ExpectedSelfId = ""
  }
}
if ([string]::IsNullOrWhiteSpace($LegacyTencentFilesDir) -and -not [string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
  $LegacyTencentFilesDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)) "Tencent Files\$ExpectedSelfId"
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

function Get-RecentFileWrites {
  param(
    [string]$Path,
    [int]$Count = 12
  )
  if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path)) { return @() }
  return @(Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First $Count |
    ForEach-Object {
      [pscustomobject]@{
        lastWriteTime = $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm:ss")
        bytes = $_.Length
        path = $_.FullName
      }
    })
}

$Cutoff = (Get-Date).AddDays(-1 * $Days)
$LogDirectory = Join-Path $NapCatRoot "logs"
$Events = New-Object System.Collections.Generic.List[object]
if (Test-Path -LiteralPath $LogDirectory) {
  Get-ChildItem -LiteralPath $LogDirectory -Filter "codex-login-*.log" |
    Where-Object { $_.LastWriteTime -ge $Cutoff } |
    Sort-Object LastWriteTime |
    ForEach-Object {
      $Leaf = $_.Name
      foreach ($RawLine in (Get-Content -LiteralPath $_.FullName -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        $Line = Remove-Ansi -Text $RawLine
        if ($Line -match '^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+\[(info|warn|error|debug)\]\s+(.*)$') {
          $TimeText = $Matches[1]
          $Level = $Matches[2]
          $Message = $Matches[3]
          if ($Message -match '正在快速登录|Worker进程已登录成功|本账号数据/缓存目录|KickedOffLine|账号状态变更为离线|快速登录错误|登录态已失效|用户身份已失效|二维码已保存|WebUi User Panel Url') {
            $Events.Add([pscustomobject]@{
              time = Convert-NapCatLogTime -Text $TimeText
              level = $Level
              event = $Message
              file = $Leaf
            }) | Out-Null
          }
        } elseif ($Line -match '^HTTP服务:\s*127\.0\.0\.1:3010.*已启动') {
          $Events.Add([pscustomobject]@{
            time = $null
            level = "info"
            event = $Line
            file = $Leaf
          }) | Out-Null
        }
      }
    }
}

$Attempts = @($Events.ToArray() |
  Group-Object file |
  ForEach-Object {
    $Group = @($_.Group | Sort-Object time)
    [pscustomobject]@{
      file = $_.Name
      start = ($Group | Where-Object { $_.event -match '正在快速登录' } | Select-Object -First 1).time
      success = ($Group | Where-Object { $_.event -match 'Worker进程已登录成功' } | Select-Object -First 1).time
      onebot3010 = ($Group | Where-Object { $_.event -match 'HTTP服务.*3010.*已启动' } | Select-Object -First 1).time
      kickOrOffline = ($Group | Where-Object { $_.event -match 'KickedOffLine|账号状态变更为离线' } | Select-Object -First 1).time
      invalidQuickLogin = ($Group | Where-Object { $_.event -match '快速登录错误|登录态已失效|用户身份已失效' } | Select-Object -First 1).time
      qrSaved = ($Group | Where-Object { $_.event -match '二维码已保存' } | Select-Object -First 1).time
      dataPath = (($Group | Where-Object { $_.event -match '本账号数据/缓存目录' } | Select-Object -First 1).event -replace '^.*本账号数据/缓存目录：\s*', '')
    }
  } |
  Where-Object { $_.start -or $_.success -or $_.kickOrOffline -or $_.invalidQuickLogin -or $_.qrSaved } |
  Select-Object -Last $MaxAttempts)

$Processes = @(Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match '^(QQ|node|cmd|NapCatWinBootMain)\.exe$' -and
    ($_.CommandLine -match 'NapCat|3406694168|QQNT|Tencent')
  } |
  ForEach-Object {
    $CreatedAt = $null
    try {
      $CreatedAt = ([Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate)).ToString("yyyy-MM-dd HH:mm:ss")
    } catch {
      $CreatedAt = [string]$_.CreationDate
    }
    [pscustomobject]@{
      pid = [int]$_.ProcessId
      parentPid = [int]$_.ParentProcessId
      name = $_.Name
      createdAt = $CreatedAt
      commandLine = $_.CommandLine
    }
  })

[pscustomobject]@{
  generatedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss zzz")
  napCatRoot = $NapCatRoot
  dataRoot = $DataRoot
  expectedSelfId = $ExpectedSelfId
  qqUserDataDir = $QqUserDataDir
  legacyTencentFilesDir = $LegacyTencentFilesDir
  attempts = $Attempts
  cleanProfileRecentWrites = Get-RecentFileWrites -Path $QqUserDataDir
  legacyProfileRecentWrites = Get-RecentFileWrites -Path $LegacyTencentFilesDir
  relevantProcesses = $Processes
} | ConvertTo-Json -Depth 8
