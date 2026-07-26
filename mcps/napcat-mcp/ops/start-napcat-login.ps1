[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$CodexHome = "",
  [ValidateRange(30, 900)][int]$TimeoutSeconds = 300,
  [switch]$NoQr
)

$ErrorActionPreference = "Stop"
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
if ([string]::IsNullOrWhiteSpace($DataRoot)) {
  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT)) {
    $DataRoot = $env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT
  } else {
    $LegacyDataRoot = Join-Path $BrokerRoot "napcat-mcp"
    $DataRoot = if (Test-Path -LiteralPath (Join-Path $LegacyDataRoot "binding.json")) {
      $LegacyDataRoot
    } else {
      Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp"
    }
  }
}
if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
  $RuntimeStateFile = Join-Path $DataRoot "napcat-runtime.json"
  if (Test-Path -LiteralPath $RuntimeStateFile) {
    try { $NapCatRoot = [string](Get-Content -LiteralPath $RuntimeStateFile -Raw -Encoding UTF8 | ConvertFrom-Json).napCatRoot } catch { $NapCatRoot = "" }
  }
  if ([string]::IsNullOrWhiteSpace($NapCatRoot)) {
    $NapCatRoot = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)) "NapCat"
  }
}
$Launcher = Join-Path $NapCatRoot "launcher-user.bat"
$QrCodePath = Join-Path $NapCatRoot "cache\qrcode.png"
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$LogDirectory = Join-Path $NapCatRoot "logs"
if (-not (Test-Path -LiteralPath $Launcher)) { throw "找不到 NapCat launcher：$Launcher" }
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
$CommandLine = "$env:ComSpec /d /c `"`"$Launcher`"$LauncherArguments < `"$EmptyInputPath`" >> `"$LogPath`" 2>> `"$ErrorLogPath`"`""
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
