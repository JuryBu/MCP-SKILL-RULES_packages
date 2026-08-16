[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$QqExePath = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$CodexHome = "",
  [ValidateRange(30, 900)][int]$TimeoutSeconds = 300,
  [switch]$NoQr
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
$NapCatMcpRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($CodexHome)) { $CodexHome = Join-Path $env:USERPROFILE ".codex" }
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_TOOLKIT_BROKER_ROOT)) {
    $BrokerRoot = $env:CODEX_TOOLKIT_BROKER_ROOT
  } else {
    $LegacyBrokerRoot = Join-Path $CodexHome "mcp-http-broker"
    $BrokerRoot = if (Test-Path -LiteralPath (Join-Path $LegacyBrokerRoot "broker-private.env.json")) {
      $LegacyBrokerRoot
    } else {
      Join-Path (Split-Path -Parent $NapCatMcpRoot) "broker"
    }
  }
}
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $BrokerRoot
$RuntimeStateFile = Join-Path $DataRoot "napcat-runtime.json"
$RuntimeConfiguration = $null
if (Test-Path -LiteralPath $RuntimeStateFile) {
  try { $RuntimeConfiguration = Get-Content -LiteralPath $RuntimeStateFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $RuntimeConfiguration = $null }
}
if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  if ($null -ne $RuntimeConfiguration) { $NapCatRoot = [string]$RuntimeConfiguration.napCatRoot }
  if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
    $NapCatRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)) "NapCat"
  }
}
if ([string]::IsNullOrWhiteSpace($QqExePath) -and $null -ne $RuntimeConfiguration) {
  $QqExePath = [string]$RuntimeConfiguration.qqExePath
}
$NapCatRoot = [System.IO.Path]::GetFullPath($NapCatRoot)
if (-not [string]::IsNullOrWhiteSpace($QqExePath)) {
  if (-not [System.IO.Path]::IsPathRooted($QqExePath)) { throw "qqExePath 必须是绝对路径：$QqExePath" }
  $QqExePath = [System.IO.Path]::GetFullPath($QqExePath)
}
$Launcher = Join-Path $NapCatRoot "launcher-user.bat"
$CoreModule = Join-Path $NapCatRoot "napcat.mjs"
$BootMain = Join-Path $NapCatRoot "NapCatWinBootMain.exe"
$HookModule = Join-Path $NapCatRoot "NapCatWinBootHook.dll"
$LoaderModule = Join-Path $NapCatRoot "loadNapCat.js"
$QrCodePath = Join-Path $NapCatRoot "cache\qrcode.png"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$LogDirectory = Join-Path $NapCatRoot "logs"
if (-not (Test-Path -LiteralPath $CoreModule -PathType Leaf)) {
  throw "[NAPCAT_RUNTIME_INCOMPLETE] NapCat 核心模块缺失：$CoreModule。可能被安全软件隔离或安装损坏，这不表示快速登录授权已过期。"
}
if ([string]::IsNullOrWhiteSpace($QqExePath)) {
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { throw "找不到 NapCat launcher：$Launcher" }
} else {
  foreach ($RequiredPath in @($QqExePath, $BootMain, $HookModule)) {
    if (-not (Test-Path -LiteralPath $RequiredPath -PathType Leaf)) {
      throw "[NAPCAT_RUNTIME_INCOMPLETE] 独立 QQ 运行文件缺失：$RequiredPath"
    }
  }
}
if (-not (Test-Path -LiteralPath $PrivateEnvPath)) { throw "找不到 broker 私密环境：$PrivateEnvPath" }
if (-not (Test-Path -LiteralPath $BindingPath)) { throw "找不到 NapCat binding：$BindingPath" }

$PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Binding = Get-Content -LiteralPath $BindingPath -Raw -Encoding UTF8 | ConvertFrom-Json
$BaseUrl = ([string]$PrivateEnv.NAPCAT_HTTP_URL).TrimEnd("/")
$Token = [string]$PrivateEnv.NAPCAT_ACCESS_TOKEN
$ExpectedSelfId = [string]$Binding.expectedSelfId
$ExpectedNickname = [string]$Binding.expectedNickname
if ($BaseUrl -notmatch '^https?://(127\.0\.0\.1|localhost)(:\d+)?$') {
  throw "NAPCAT_HTTP_URL 不是本机回环地址，拒绝连接"
}
if ([string]::IsNullOrWhiteSpace($Token)) { throw "NAPCAT_ACCESS_TOKEN 为空" }

function Invoke-OneBot {
  param([string]$Action)
  $Headers = @{ Authorization = "Bearer $Token" }
  return Invoke-RestMethod -Method Post -Uri "$BaseUrl/$Action" -Headers $Headers -ContentType "application/json" -Body "{}" -TimeoutSec 3
}

function Assert-ExpectedLogin {
  param($LoginData)
  $ActualSelfId = [string]$LoginData.user_id
  $ActualNickname = [string]$LoginData.nickname
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSelfId) -and $ActualSelfId -ne $ExpectedSelfId) {
    throw "NapCat 登录了错误 QQ：expected=$ExpectedSelfId actual=$ActualSelfId"
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedNickname) -and $ActualNickname -ne $ExpectedNickname) {
    throw "NapCat 登录了错误昵称：expected=$ExpectedNickname actual=$ActualNickname"
  }
  return [pscustomobject]@{ userId = $ActualSelfId; nickname = $ActualNickname }
}

function New-QrWindow {
  param([string]$ImagePath)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $Form = New-Object System.Windows.Forms.Form
  $DisplayIdentity = if ([string]::IsNullOrWhiteSpace($ExpectedNickname)) {
    $ExpectedSelfId
  } elseif ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
    $ExpectedNickname
  } else {
    "$ExpectedNickname / $ExpectedSelfId"
  }
  $Form.Text = "NapCat 登录 - 请使用 $DisplayIdentity 扫码"
  $Form.StartPosition = "CenterScreen"
  $Form.ClientSize = New-Object System.Drawing.Size(420, 470)
  $Form.TopMost = $true
  $Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $Form.MaximizeBox = $false
  $Picture = New-Object System.Windows.Forms.PictureBox
  $Picture.Dock = [System.Windows.Forms.DockStyle]::Fill
  $Picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $Picture.Image = [System.Drawing.Image]::FromFile($ImagePath)
  $Form.Controls.Add($Picture)
  $Form.Show()
  return [pscustomobject]@{ Form = $Form; Picture = $Picture }
}

function Close-QrWindow {
  param($Window)
  if ($null -eq $Window) { return }
  if ($null -ne $Window.Picture.Image) { $Window.Picture.Image.Dispose() }
  $Window.Form.Close()
  $Window.Form.Dispose()
}

function Stop-LaunchedProcessTree {
  param([int]$RootProcessId)
  if ($RootProcessId -le 0) { return }
  try {
    & "$env:SystemRoot\System32\taskkill.exe" /PID $RootProcessId /T /F 2>$null | Out-Null
  } catch {
  }
}

try {
  $Status = Invoke-OneBot -Action "get_status"
  if ($Status.status -eq "ok" -and $Status.data.online -eq $true) {
    $Login = Invoke-OneBot -Action "get_login_info"
    $VerifiedLogin = Assert-ExpectedLogin -LoginData $Login.data
    [pscustomobject]@{
      state = "already_online"
      launched = $false
      processId = $null
      userId = $VerifiedLogin.userId
      nickname = $VerifiedLogin.nickname
      qrCodePath = $null
      logPath = $null
    } | ConvertTo-Json -Depth 5
    exit 0
  }
} catch {
  if ($_.Exception.Message -like "NapCat 登录了错误*") { throw }
}

$StartedAtUtc = [DateTime]::UtcNow
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory "codex-login-$Stamp.log"
$ErrorLogPath = Join-Path $LogDirectory "codex-login-$Stamp.error.log"
$EmptyInputPath = Join-Path $LogDirectory ".codex-empty-input"
if (-not (Test-Path -LiteralPath $EmptyInputPath)) {
  [System.IO.File]::WriteAllText($EmptyInputPath, "", (New-Object System.Text.UTF8Encoding($false)))
}
$StartupInfo = ([WmiClass]"Win32_ProcessStartup").CreateInstance()
$StartupInfo.ShowWindow = 0
$ProcessClass = [WmiClass]"Win32_Process"
$LauncherArguments = ""
if (-not [string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
  $LauncherArguments = " `"$ExpectedSelfId`""
} elseif ($NoQr) {
  throw "NapCat 快速登录要求 binding.json 提供 expectedSelfId"
}
if ([string]::IsNullOrWhiteSpace($QqExePath)) {
  $CommandLine = "$env:ComSpec /d /c `"`"$Launcher`"$LauncherArguments < `"$EmptyInputPath`" >> `"$LogPath`" 2>> `"$ErrorLogPath`"`""
} else {
  $CoreUri = ([Uri]$CoreModule).AbsoluteUri
  $LoaderSource = "(async () => {await import(`"$CoreUri`")})()"
  [System.IO.File]::WriteAllText($LoaderModule, $LoaderSource, (New-Object System.Text.UTF8Encoding($false)))
  $CommandLine = "$env:ComSpec /d /c `"`"$BootMain`" `"$QqExePath`" `"$HookModule`"$LauncherArguments < `"$EmptyInputPath`" >> `"$LogPath`" 2>> `"$ErrorLogPath`"`""
}
$CreateResult = $ProcessClass.Create($CommandLine, $NapCatRoot, $StartupInfo)
if ([int]$CreateResult.ReturnValue -ne 0 -or [int]$CreateResult.ProcessId -le 0) {
  throw "NapCat 无窗口进程启动失败，WMI returnValue=$($CreateResult.ReturnValue)"
}
$ProcessId = [int]$CreateResult.ProcessId
$Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$QrWindow = $null
while ([DateTime]::UtcNow -lt $Deadline) {
  if ($null -ne $QrWindow) { [System.Windows.Forms.Application]::DoEvents() }
  $CurrentProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $CurrentProcess) {
    Close-QrWindow -Window $QrWindow
    throw "NapCat 登录进程提前退出，日志：$LogPath，错误日志：$ErrorLogPath"
  }
  try {
    $Status = Invoke-OneBot -Action "get_status"
    if ($Status.status -eq "ok" -and $Status.data.online -eq $true) {
      $Login = Invoke-OneBot -Action "get_login_info"
      $VerifiedLogin = Assert-ExpectedLogin -LoginData $Login.data
      Close-QrWindow -Window $QrWindow
      [pscustomobject]@{
        state = "online"
        launched = $true
        processId = $ProcessId
        userId = $VerifiedLogin.userId
        nickname = $VerifiedLogin.nickname
        qrCodePath = $null
        logPath = $LogPath
        errorLogPath = $ErrorLogPath
      } | ConvertTo-Json -Depth 5
      exit 0
    }
  } catch {
    if ($_.Exception.Message -like "NapCat 登录了错误*") {
      Close-QrWindow -Window $QrWindow
      Stop-LaunchedProcessTree -RootProcessId $ProcessId
      throw
    }
  }
  if (-not $NoQr -and $null -eq $QrWindow -and (Test-Path -LiteralPath $QrCodePath)) {
    $QrCode = Get-Item -LiteralPath $QrCodePath
    if ($QrCode.LastWriteTimeUtc -ge $StartedAtUtc.AddSeconds(-2)) {
      $QrWindow = New-QrWindow -ImagePath $QrCode.FullName
    }
  }
  Start-Sleep -Milliseconds 500
}

Close-QrWindow -Window $QrWindow
Stop-LaunchedProcessTree -RootProcessId $ProcessId
$DisplayIdentity = if ([string]::IsNullOrWhiteSpace($ExpectedNickname)) {
  $ExpectedSelfId
} elseif ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
  $ExpectedNickname
} else {
  "$ExpectedNickname / $ExpectedSelfId"
}
if ($NoQr) {
  throw "NapCat 快速登录在 $TimeoutSeconds 秒内没有恢复 $DisplayIdentity；快速登录记录不可用或启动器未接受该账号，本次未弹二维码。请在有人值守时运行不带 -NoQr 的登录脚本重新扫码。日志：$LogPath"
}
throw "NapCat 在 $TimeoutSeconds 秒内没有以 $DisplayIdentity 登录成功，日志：$LogPath"
