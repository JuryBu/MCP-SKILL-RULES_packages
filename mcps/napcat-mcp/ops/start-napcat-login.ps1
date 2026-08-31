[CmdletBinding()]
param(
  [string]$NapCatRoot = "",
  [string]$QqExePath = "",
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$CodexHome = "",
  [string]$QuickLoginCredentialPath = "",
  [string]$QqUserDataDir = "",
  [ValidateRange(30, 900)][int]$TimeoutSeconds = 300,
  [switch]$NoQr,
  [switch]$NoPasswordFallback
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
. (Join-Path $PSScriptRoot "napcat-quick-login-credential.ps1")
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
if ([string]::IsNullOrWhiteSpace($QqUserDataDir) -and $null -ne $RuntimeConfiguration) {
  $QqUserDataDir = [string]$RuntimeConfiguration.qqUserDataDir
}
$NapCatRoot = [System.IO.Path]::GetFullPath($NapCatRoot)
if (-not [string]::IsNullOrWhiteSpace($QqExePath)) {
  if (-not [System.IO.Path]::IsPathRooted($QqExePath)) { throw "qqExePath 必须是绝对路径：$QqExePath" }
  $QqExePath = [System.IO.Path]::GetFullPath($QqExePath)
}
if (-not [string]::IsNullOrWhiteSpace($QqUserDataDir)) {
  if (-not [System.IO.Path]::IsPathRooted($QqUserDataDir)) { throw "qqUserDataDir 必须是绝对路径：$QqUserDataDir" }
  $QqUserDataDir = [System.IO.Path]::GetFullPath($QqUserDataDir).TrimEnd('\')
}
$Launcher = Join-Path $NapCatRoot "launcher-user.bat"
$ManualLauncher = Join-Path $NapCatRoot "napcat.bat"
$DefaultCoreModule = Join-Path $NapCatRoot "napcat.mjs"
$NodeCoreModule = Join-Path $NapCatRoot "napcat\napcat.mjs"
$CoreModule = if ([string]::IsNullOrWhiteSpace($QqExePath) -and (Test-Path -LiteralPath $NodeCoreModule -PathType Leaf)) {
  $NodeCoreModule
} else {
  $DefaultCoreModule
}
$BootMain = Join-Path $NapCatRoot "NapCatWinBootMain.exe"
$HookModule = Join-Path $NapCatRoot "NapCatWinBootHook.dll"
$LoaderModule = Join-Path $NapCatRoot "loadNapCat.js"
$QrCodePaths = @(
  (Join-Path $NapCatRoot "napcat\cache\qrcode.png"),
  (Join-Path $NapCatRoot "cache\qrcode.png")
) | Select-Object -Unique
$PrivateEnvPath = Join-Path $BrokerRoot "broker-private.env.json"
$BindingPath = Join-Path $DataRoot "binding.json"
$DefaultCredentialPath = Join-Path $DataRoot "private\napcat-login\credential.json"
$LogDirectory = Join-Path $NapCatRoot "logs"
if (-not (Test-Path -LiteralPath $CoreModule -PathType Leaf)) {
  throw "[NAPCAT_RUNTIME_INCOMPLETE] NapCat 核心模块缺失：$CoreModule。可能被安全软件隔离或安装损坏，这不表示快速登录授权已过期。"
}
if ([string]::IsNullOrWhiteSpace($QqExePath)) {
  if (-not (Test-Path -LiteralPath $Launcher -PathType Leaf)) { throw "找不到 NapCat launcher：$Launcher" }
  if (-not $NoQr -and -not (Test-Path -LiteralPath $ManualLauncher -PathType Leaf)) { throw "找不到 NapCat 人工登录 launcher：$ManualLauncher" }
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
if ([string]::IsNullOrWhiteSpace($QuickLoginCredentialPath)) {
  $QuickLoginCredentialPath = if (-not [string]::IsNullOrWhiteSpace([string]$PrivateEnv.NAPCAT_QUICK_LOGIN_CREDENTIAL_PATH)) {
    [string]$PrivateEnv.NAPCAT_QUICK_LOGIN_CREDENTIAL_PATH
  } else {
    $DefaultCredentialPath
  }
}
$QuickLoginCredentialPath = [System.IO.Path]::GetFullPath($QuickLoginCredentialPath)
$QuickPasswordMd5 = $null
$HasPasswordFallback = $false
if ($BaseUrl -notmatch '^https?://(127\.0\.0\.1|localhost)(:\d+)?$') {
  throw "NAPCAT_HTTP_URL 不是本机回环地址，拒绝连接"
}
if ([string]::IsNullOrWhiteSpace($Token)) { throw "NAPCAT_ACCESS_TOKEN 为空" }

function Invoke-OneBot {
  param([string]$Action)
  $Headers = @{ Authorization = "Bearer $Token" }
  return Invoke-RestMethod -Method Post -Uri "$BaseUrl/$Action" -Headers $Headers -ContentType "application/json" -Body "{}" -TimeoutSec 3
}

function Get-FreshQrCode {
  param([DateTime]$NotBeforeUtc)
  return @($QrCodePaths | ForEach-Object {
    if (Test-Path -LiteralPath $_) {
      $Candidate = Get-Item -LiteralPath $_
      if ($Candidate.LastWriteTimeUtc -ge $NotBeforeUtc) { $Candidate }
    }
  } | Sort-Object LastWriteTimeUtc -Descending)[0]
}

function Assert-ExpectedLogin {
  param($LoginData)
  $ActualSelfId = [string]$LoginData.user_id
  $ActualNickname = [string]$LoginData.nickname
  if (-not [string]::IsNullOrWhiteSpace($ExpectedSelfId) -and $ActualSelfId -ne $ExpectedSelfId) {
    throw "NapCat 登录了错误 QQ：expected=$ExpectedSelfId actual=$ActualSelfId"
  }
  if (-not [string]::IsNullOrWhiteSpace($ExpectedNickname) -and -not [string]::IsNullOrWhiteSpace($ActualNickname) -and $ActualNickname -ne $ExpectedNickname) {
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
  try {
    if ($null -ne $Window.Picture -and $null -ne $Window.Picture.Image) { $Window.Picture.Image.Dispose() }
  } catch {
  }
  if ($null -ne $Window.Form) {
    try { $Window.Form.Close() } catch {}
    try { $Window.Form.Dispose() } catch {}
  }
}

function Get-LoginVerificationUrl {
  param([string]$RecentLoginLog)
  if ([string]::IsNullOrWhiteSpace($RecentLoginLog)) { return $null }
  $Match = [regex]::Match($RecentLoginLog, 'https://ti\.qq\.com/[^\s]+')
  if ($Match.Success) { return $Match.Value.TrimEnd('"', "'", ",", ".", ";", "}", ")", "]") }
  return $null
}

function Copy-TextToClipboard {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return }
  try {
    Set-Clipboard -Value $Value
  } catch {
  }
}

function New-VerificationWindow {
  param([string]$VerificationUrl)
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Copy-TextToClipboard -Value $VerificationUrl
  $Form = New-Object System.Windows.Forms.Form
  $Form.Text = "NapCat 登录 - 需要 QQ 安全验证"
  $Form.StartPosition = "CenterScreen"
  $Form.ClientSize = New-Object System.Drawing.Size(520, 180)
  $Form.TopMost = $true
  $Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $Form.MaximizeBox = $false
  $Label = New-Object System.Windows.Forms.Label
  $Label.Text = "QQ 要求人机/短信/设备安全验证。验证链接已复制到剪贴板，请在浏览器地址栏粘贴打开并完成验证。"
  $Label.SetBounds(24, 24, 470, 52)
  $Label.Font = New-Object System.Drawing.Font("Microsoft YaHei UI", 10)
  $Button = New-Object System.Windows.Forms.Button
  $Button.Text = "重新复制验证链接"
  $Button.SetBounds(170, 98, 180, 34)
  $Button.Add_Click({ Copy-TextToClipboard -Value $VerificationUrl })
  $Form.Controls.Add($Label)
  $Form.Controls.Add($Button)
  $Form.Show()
  return [pscustomobject]@{ Form = $Form; Picture = $null }
}

function Test-ProcessCommandLineMatchesHint {
  param(
    [string]$CommandLine,
    [string[]]$NormalizedHints = @()
  )
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
  foreach ($Hint in $NormalizedHints) {
    if ([string]::IsNullOrWhiteSpace($Hint)) { continue }
    if ($CommandLine.IndexOf($Hint, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}

function Stop-LaunchedProcessTree {
  param(
    [int]$RootProcessId,
    [string[]]$CommandLineHints = @()
  )
  if ($RootProcessId -le 0) { return }
  $AllowedNames = @("cmd.exe", "node.exe", "QQ.exe", "NapCatWinBootMain.exe")
  $NormalizedHints = @()
  foreach ($Hint in $CommandLineHints) {
    if ([string]::IsNullOrWhiteSpace($Hint)) { continue }
    try {
      $NormalizedHints += [System.IO.Path]::GetFullPath($Hint).TrimEnd("\")
    } catch {
      $NormalizedHints += $Hint.TrimEnd("\")
    }
  }
  if ($NormalizedHints.Count -eq 0) { return }
  try {
    $RootProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId" -ErrorAction SilentlyContinue
    if (
      $null -ne $RootProcess -and
      $AllowedNames -contains $RootProcess.Name -and
      (Test-ProcessCommandLineMatchesHint -CommandLine $RootProcess.CommandLine -NormalizedHints $NormalizedHints)
    ) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $RootProcessId /T /F 2>$null | Out-Null
    }
  } catch {
  }
  try {
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.ProcessId -ne $PID -and
        $AllowedNames -contains $_.Name -and
        (Test-ProcessCommandLineMatchesHint -CommandLine $_.CommandLine -NormalizedHints $NormalizedHints)
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch {
  }
}

function Read-RecentLoginLog {
  param([string[]]$Path)
  $Parts = @()
  foreach ($CandidatePath in $Path) {
    if ([string]::IsNullOrWhiteSpace($CandidatePath) -or -not (Test-Path -LiteralPath $CandidatePath)) { continue }
    try {
      $Parts += (Get-Content -LiteralPath $CandidatePath -Encoding UTF8 -Tail 120 -ErrorAction SilentlyContinue) -join "`n"
    } catch {
    }
  }
  return ($Parts | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join "`n"
}

function Test-PasswordFallbackNeedsHuman {
  param([string]$RecentLoginLog)
  if ([string]::IsNullOrWhiteSpace($RecentLoginLog)) { return $false }
  return $RecentLoginLog -match '(?i)(proofWaterUrl|sms-verify-login|captcha|ti\.qq\.com|需要验证码|短信验证|手机验证|需要新设备验证|需要异常设备验证|设备验证|安全验证)'
}

function Test-PasswordFallbackRejected {
  param([string]$RecentLoginLog)
  if ([string]::IsNullOrWhiteSpace($RecentLoginLog)) { return $false }
  if (Test-PasswordFallbackNeedsHuman -RecentLoginLog $RecentLoginLog) { return $false }
  return $RecentLoginLog -match '(?i)(密码错误|密码不正确|账号或密码错误|密码无效|wrong password|incorrect password|invalid password|login password.*incorrect|password.*incorrect)'
}

function Disable-QuickLoginCredential {
  param(
    [string]$CredentialPath,
    [string]$Reason
  )
  if ([string]::IsNullOrWhiteSpace($CredentialPath) -or -not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { return $null }
  try {
    $CredentialDirectory = Split-Path -Parent $CredentialPath
    $Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $DisabledPath = Join-Path $CredentialDirectory "credential.disabled-$Stamp.json"
    Move-Item -LiteralPath $CredentialPath -Destination $DisabledPath -Force
    Protect-NapCatCredentialPath -Path $DisabledPath
    $MarkerPath = Join-Path $CredentialDirectory "credential.disabled.json"
    $Payload = [ordered]@{
      schemaVersion = 1
      disabledAt = [DateTime]::UtcNow.ToString("o")
      reason = $Reason
      disabledCredentialPath = $DisabledPath
    }
    [System.IO.File]::WriteAllText($MarkerPath, ($Payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    Protect-NapCatCredentialPath -Path $MarkerPath
    return $DisabledPath
  } catch {
    return $null
  }
}

function Test-QuickLoginCredentialInvalid {
  param([string]$RecentLoginLog)
  if ([string]::IsNullOrWhiteSpace($RecentLoginLog)) { return $false }
  return $RecentLoginLog -match '(?i)(快速登录错误|quick login|KickedOffLine)' -and $RecentLoginLog -match '(用户身份已失效|身份已失效|登录态已失效|登录态失效|登录状态失效|授权失效|重新登录)'
}

function Stop-AndThrowManualLoginRequired {
  param(
    [int]$RootProcessId,
    $QrWindow,
    [string]$Reason,
    [string]$LogPath
  )
  Close-QrWindow -Window $QrWindow
  Stop-LaunchedProcessTree -RootProcessId $RootProcessId -CommandLineHints @($NapCatRoot, $QqExePath)
  throw "[NAPCAT_MANUAL_LOGIN_REQUIRED] $Reason，NapCat 要求人工验证。日志：$LogPath"
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

$QuickPasswordMd5 = if ($NoPasswordFallback) {
  $null
} else {
  Read-NapCatQuickLoginCredential -CredentialPath $QuickLoginCredentialPath -ExpectedAccount $ExpectedSelfId
}
$HasPasswordFallback = -not [string]::IsNullOrWhiteSpace($QuickPasswordMd5)
$StartedAtUtc = [DateTime]::UtcNow
$PasswordFallbackDeadlineUtc = $StartedAtUtc.AddSeconds([Math]::Min(60, [Math]::Max(25, $TimeoutSeconds - 5)))
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory "codex-login-$Stamp.log"
$ErrorLogPath = Join-Path $LogDirectory "codex-login-$Stamp.error.log"
$EmptyInputPath = Join-Path $LogDirectory ".codex-empty-input"
if (-not (Test-Path -LiteralPath $EmptyInputPath)) {
  [System.IO.File]::WriteAllText($EmptyInputPath, "", (New-Object System.Text.UTF8Encoding($false)))
}
$LauncherArguments = ""
if ($NoQr -or $HasPasswordFallback) {
  if ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
    throw "NapCat 快速登录要求 binding.json 提供 expectedSelfId"
  }
  $LauncherArguments = " `"$ExpectedSelfId`""
}
$QqAppDataRoot = ""
if (-not [string]::IsNullOrWhiteSpace($QqUserDataDir)) {
  New-Item -ItemType Directory -Force -Path $QqUserDataDir | Out-Null
  $QqAppDataRoot = Split-Path -Parent $QqUserDataDir
  if ([string]::IsNullOrWhiteSpace($QqAppDataRoot)) { throw "qqUserDataDir 必须位于一个有效父目录下：$QqUserDataDir" }
  New-Item -ItemType Directory -Force -Path $QqAppDataRoot | Out-Null
}
if ([string]::IsNullOrWhiteSpace($QqExePath)) {
  $SelectedLauncher = if ($NoQr -or $HasPasswordFallback) { $Launcher } else { $ManualLauncher }
  $CommandArguments = "/d /c `"`"$SelectedLauncher`"$LauncherArguments < `"$EmptyInputPath`" >> `"$LogPath`" 2>> `"$ErrorLogPath`"`""
} else {
  $CoreUri = ([Uri]$CoreModule).AbsoluteUri
  $LoaderSource = "(async () => {await import(`"$CoreUri`")})()"
  [System.IO.File]::WriteAllText($LoaderModule, $LoaderSource, (New-Object System.Text.UTF8Encoding($false)))
  $CommandArguments = "/d /c `"`"$BootMain`" `"$QqExePath`" `"$HookModule`"$LauncherArguments < `"$EmptyInputPath`" >> `"$LogPath`" 2>> `"$ErrorLogPath`"`""
}
$StartInfo = New-Object System.Diagnostics.ProcessStartInfo
$StartInfo.FileName = $env:ComSpec
$StartInfo.Arguments = $CommandArguments
$StartInfo.WorkingDirectory = $NapCatRoot
$StartInfo.UseShellExecute = $false
$StartInfo.CreateNoWindow = $true
$StartInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
try {
  if (-not [string]::IsNullOrWhiteSpace($QqAppDataRoot)) {
    $StartInfo.EnvironmentVariables["APPDATA"] = $QqAppDataRoot
    $StartInfo.EnvironmentVariables["NAPCAT_QQ_USER_DATA_DIR"] = $QqUserDataDir
  }
  if ($HasPasswordFallback) {
    $StartInfo.EnvironmentVariables["NAPCAT_QUICK_ACCOUNT"] = $ExpectedSelfId
    $StartInfo.EnvironmentVariables["NAPCAT_QUICK_PASSWORD_MD5"] = $QuickPasswordMd5
  }
  $StartedProcess = [System.Diagnostics.Process]::Start($StartInfo)
} finally {
  $StartInfo.EnvironmentVariables.Remove("APPDATA")
  $StartInfo.EnvironmentVariables.Remove("NAPCAT_QQ_USER_DATA_DIR")
  $StartInfo.EnvironmentVariables.Remove("NAPCAT_QUICK_ACCOUNT")
  $StartInfo.EnvironmentVariables.Remove("NAPCAT_QUICK_PASSWORD_MD5")
  $QuickPasswordMd5 = $null
}
if ($null -eq $StartedProcess -or [int]$StartedProcess.Id -le 0) {
  throw "NapCat hidden process failed to start"
}
$ProcessId = [int]$StartedProcess.Id
$Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$QrWindow = $null
$VerificationWindow = $null
$LastVerificationUrl = $null
while ([DateTime]::UtcNow -lt $Deadline) {
  if ($null -ne $QrWindow) { [System.Windows.Forms.Application]::DoEvents() }
  if ($null -ne $VerificationWindow) { [System.Windows.Forms.Application]::DoEvents() }
  $CurrentProcess = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $CurrentProcess) {
    $RecentLoginLog = Read-RecentLoginLog -Path @($LogPath, $ErrorLogPath)
    $PasswordFallbackNeedsHuman = Test-PasswordFallbackNeedsHuman -RecentLoginLog $RecentLoginLog
    $PasswordFallbackRejected = Test-PasswordFallbackRejected -RecentLoginLog $RecentLoginLog
    if ($NoQr -and $PasswordFallbackNeedsHuman) {
      Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "加密密码回退已触发短信验证或验证码，保留本地凭据并等待人工验证" -LogPath $LogPath
    }
    if ($NoQr -and $PasswordFallbackRejected) {
      Disable-QuickLoginCredential -CredentialPath $QuickLoginCredentialPath -Reason "password_fallback_login_failed" | Out-Null
      $HasPasswordFallback = $false
    }
    if ($NoQr -and (Test-QuickLoginCredentialInvalid -RecentLoginLog $RecentLoginLog)) {
      Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "NapCat 登录进程提前退出前已报告登录态失效" -LogPath $LogPath
    }
    Close-QrWindow -Window $QrWindow
    Close-QrWindow -Window $VerificationWindow
    throw "NapCat 登录进程提前退出，日志：$LogPath，错误日志：$ErrorLogPath"
  }
  try {
    $Status = Invoke-OneBot -Action "get_status"
    if ($Status.status -eq "ok" -and $Status.data.online -eq $true) {
      $Login = Invoke-OneBot -Action "get_login_info"
      $VerifiedLogin = Assert-ExpectedLogin -LoginData $Login.data
      Close-QrWindow -Window $QrWindow
      Close-QrWindow -Window $VerificationWindow
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
      Close-QrWindow -Window $VerificationWindow
      Stop-LaunchedProcessTree -RootProcessId $ProcessId -CommandLineHints @($NapCatRoot, $QqExePath)
      throw
    }
  }
  $QrCode = Get-FreshQrCode -NotBeforeUtc $StartedAtUtc.AddSeconds(-2)
  $PasswordFallbackNeedsHuman = $false
  $PasswordFallbackRejected = $false
  $QuickLoginCredentialInvalid = $false
  if ($NoQr -and $HasPasswordFallback -and ((Test-Path -LiteralPath $LogPath) -or (Test-Path -LiteralPath $ErrorLogPath))) {
    $RecentLoginLog = Read-RecentLoginLog -Path @($LogPath, $ErrorLogPath)
    $PasswordFallbackNeedsHuman = Test-PasswordFallbackNeedsHuman -RecentLoginLog $RecentLoginLog
    $PasswordFallbackRejected = Test-PasswordFallbackRejected -RecentLoginLog $RecentLoginLog
    $QuickLoginCredentialInvalid = Test-QuickLoginCredentialInvalid -RecentLoginLog $RecentLoginLog
  } elseif ($NoQr -and ((Test-Path -LiteralPath $LogPath) -or (Test-Path -LiteralPath $ErrorLogPath))) {
    $RecentLoginLog = Read-RecentLoginLog -Path @($LogPath, $ErrorLogPath)
    $QuickLoginCredentialInvalid = Test-QuickLoginCredentialInvalid -RecentLoginLog $RecentLoginLog
  }
  if ($NoQr -and $PasswordFallbackNeedsHuman) {
    Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "加密密码回退已触发短信验证或验证码，保留本地凭据并等待人工验证" -LogPath $LogPath
  }
  if ($NoQr -and $PasswordFallbackRejected) {
    Disable-QuickLoginCredential -CredentialPath $QuickLoginCredentialPath -Reason "password_fallback_login_failed" | Out-Null
    $HasPasswordFallback = $false
    Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "加密密码回退登录明确返回密码错误，已禁用本地凭据" -LogPath $LogPath
  }
  if ($NoQr -and (-not $HasPasswordFallback) -and ($QuickLoginCredentialInvalid -or $null -ne $QrCode)) {
    Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "快速登录记录已不可用且尚未配置加密密码回退" -LogPath $LogPath
  }
  if ($NoQr -and $null -ne $QrCode -and ($HasPasswordFallback -and [DateTime]::UtcNow -ge $PasswordFallbackDeadlineUtc)) {
    Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "快速登录和加密密码回退均未恢复账号" -LogPath $LogPath
  }
  if (-not $NoQr -and $null -eq $QrWindow -and $null -ne $QrCode) {
    $QrWindow = New-QrWindow -ImagePath $QrCode.FullName
  }
  if (-not $NoQr -and ((Test-Path -LiteralPath $LogPath) -or (Test-Path -LiteralPath $ErrorLogPath))) {
    $RecentLoginLog = Read-RecentLoginLog -Path @($LogPath, $ErrorLogPath)
    $VerificationUrl = Get-LoginVerificationUrl -RecentLoginLog $RecentLoginLog
    if (-not [string]::IsNullOrWhiteSpace($VerificationUrl) -and $VerificationUrl -ne $LastVerificationUrl) {
      Close-QrWindow -Window $VerificationWindow
      $VerificationWindow = New-VerificationWindow -VerificationUrl $VerificationUrl
      $LastVerificationUrl = $VerificationUrl
    }
  }
  Start-Sleep -Milliseconds 500
}

Close-QrWindow -Window $QrWindow
Close-QrWindow -Window $VerificationWindow
Stop-LaunchedProcessTree -RootProcessId $ProcessId -CommandLineHints @($NapCatRoot, $QqExePath)
$DisplayIdentity = if ([string]::IsNullOrWhiteSpace($ExpectedNickname)) {
  $ExpectedSelfId
} elseif ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
  $ExpectedNickname
} else {
  "$ExpectedNickname / $ExpectedSelfId"
}
if ($NoQr) {
  $RecentLoginLog = Read-RecentLoginLog -Path @($LogPath, $ErrorLogPath)
  if ((Test-PasswordFallbackNeedsHuman -RecentLoginLog $RecentLoginLog) -or (Test-QuickLoginCredentialInvalid -RecentLoginLog $RecentLoginLog)) {
    throw "[NAPCAT_MANUAL_LOGIN_REQUIRED] NapCat 快速登录在 $TimeoutSeconds 秒内没有恢复 $DisplayIdentity；日志显示登录态失效或需要人工验证，本次未弹二维码。日志：$LogPath"
  }
  throw "[NAPCAT_MANUAL_LOGIN_REQUIRED] NapCat 快速登录在 $TimeoutSeconds 秒内没有恢复 $DisplayIdentity；按安全策略停止自动重试，本次未弹二维码。日志：$LogPath"
}
throw "NapCat 在 $TimeoutSeconds 秒内没有以 $DisplayIdentity 登录成功，日志：$LogPath"
