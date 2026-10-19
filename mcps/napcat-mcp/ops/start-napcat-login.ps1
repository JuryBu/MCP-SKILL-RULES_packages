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
. (Join-Path $PSScriptRoot "napcat-process-identity.ps1")
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
if ($NoQr -and [string]::IsNullOrWhiteSpace($ExpectedSelfId)) { throw '[NAPCAT_MANUAL_LOGIN_REQUIRED] 快速登录要求绑定明确的账号 ID' }
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

function Set-OneBotSafeStartupConfig {
  param([string]$NapCatRoot, [string]$ExpectedSelfId, [string]$LogPath)
  if ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) { return }
  $CandidateConfigPaths = @(
    (Join-Path $NapCatRoot ("napcat\config\onebot11_{0}.json" -f $ExpectedSelfId)),
    (Join-Path $NapCatRoot ("config\onebot11_{0}.json" -f $ExpectedSelfId))
  ) | Select-Object -Unique
  foreach ($ConfigPath in $CandidateConfigPaths) {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { continue }
    try {
      $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($Config.parseMultMsg -eq $false) { continue }
      $Config | Add-Member -NotePropertyName 'parseMultMsg' -NotePropertyValue $false -Force
      [IO.File]::WriteAllText($ConfigPath, (($Config | ConvertTo-Json -Depth 30) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
      if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[{0}] [codex] forced_onebot_safe_startup_config parseMultMsg=false config={1}" -f (Get-Date).ToString('o'), $ConfigPath)
      }
    } catch {
      if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[{0}] [codex] warn_onebot_safe_startup_config_failed config={1} error={2}" -f (Get-Date).ToString('o'), $ConfigPath, $_.Exception.Message)
      }
    }
  }
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

function Initialize-QqPathIdentityApi {
  if ('NapCatLoginPathIdentity' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class NapCatLoginPathIdentity {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(SafeProcessHandle handle, uint flags, StringBuilder path, ref uint size);
    public static string ProcessImage(SafeProcessHandle handle) {
        StringBuilder buffer = new StringBuilder(32768);
        uint length = (uint)buffer.Capacity;
        if (!QueryFullProcessImageNameW(handle, 0, buffer, ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return buffer.ToString();
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    public static string Resolve(string path) {
        using (SafeFileHandle handle = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            StringBuilder buffer = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (length >= buffer.Capacity) {
                buffer = new StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            string result = buffer.ToString();
            if (result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\" + result.Substring(8);
            if (result.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) return result.Substring(4);
            return result;
        }
    }
}
'@
}

function Get-NormalizedQqPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not [IO.Path]::IsPathRooted($Path)) { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Absolute path required' }
  $FullPath = [IO.Path]::GetFullPath($Path)
  if ($Path -notmatch '^(?:[A-Za-z]:[\\/]|[\\/]{2})') { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Fully qualified path required' }
  Initialize-QqPathIdentityApi
  $ExistingPath = $FullPath
  $MissingParts = [Collections.Generic.List[string]]::new()
  while ($true) {
    try { $ResolvedPath = [NapCatLoginPathIdentity]::Resolve($ExistingPath); break }
    catch {
      $NativeFailure = $_.Exception
      while ($null -ne $NativeFailure.InnerException) { $NativeFailure = $NativeFailure.InnerException }
      if ($NativeFailure -isnot [ComponentModel.Win32Exception] -or $NativeFailure.NativeErrorCode -notin @(2, 3)) { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Cannot resolve actual path identity' }
      try { $Attributes = [IO.File]::GetAttributes($ExistingPath) }
      catch { $Attributes = [IO.FileAttributes]0 }
      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Unresolved reparse point' }
      $ParentPath = [IO.Path]::GetDirectoryName($ExistingPath.TrimEnd([char[]]'\/'))
      if ([string]::IsNullOrWhiteSpace($ParentPath) -or $ParentPath -eq $ExistingPath) { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] No resolvable path ancestor' }
      $MissingParts.Insert(0, [IO.Path]::GetFileName($ExistingPath.TrimEnd([char[]]'\/')))
      $ExistingPath = $ParentPath
    }
  }
  foreach ($Part in $MissingParts) { $ResolvedPath = [IO.Path]::Combine($ResolvedPath, $Part) }
  return [IO.Path]::GetFullPath($ResolvedPath).TrimEnd([char[]]'\/').Replace('/', '\').ToUpperInvariant()
}

function Get-QqLoginLockName {
  param([Parameter(Mandatory = $true)][string]$UserDataDir)
  $NormalizedRoot = Get-NormalizedQqPath -Path $UserDataDir
  $HashProvider = [Security.Cryptography.SHA256]::Create()
  try { $Hash = [BitConverter]::ToString($HashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($NormalizedRoot))).Replace('-', '') }
  finally { $HashProvider.Dispose() }
  return "Global\CodexNapCatQqLogin-$Hash"
}

function Get-VerifiedOnlineLogin {
  try {
    $Status = Invoke-OneBot -Action 'get_status'
    if ($Status.status -ne 'ok' -or $Status.data.online -ne $true) { return $null }
    if ($Status.data.good -ne $true) { throw '[NAPCAT_PROCESS_PRESENT] Existing account is online but good is not true; launch refused' }
    $Login = Invoke-OneBot -Action 'get_login_info'
    if ($Login.status -ne 'ok' -or [string]::IsNullOrWhiteSpace([string]$Login.data.user_id)) { return $null }
    return Assert-ExpectedLogin -LoginData $Login.data
  } catch {
    if ($_.Exception.Message -like 'NapCat 登录了错误*' -or $_.Exception.Message.StartsWith('[NAPCAT_PROCESS_PRESENT]')) { throw }
    return $null
  }
}

function Assert-NoExistingNapCatRuntime {
  $Existing = @(Get-ExistingNapCatRuntimeProcesses -NapCatRoot $NapCatRoot -QqExePath $QqExePath -QqUserDataDir $QqUserDataDir)
  if ($Existing.Count -gt 0) { throw '[NAPCAT_PROCESS_PRESENT] NapCat ownership was verified; duplicate launch refused' }
}

function Get-LockedQqLoginState {
  param([string]$UserDataDir)
  $VerifiedLogin = Get-VerifiedOnlineLogin
  if ($null -ne $VerifiedLogin) { return $VerifiedLogin }
  Assert-NoExistingNapCatRuntime
  return $null
}

function Clear-InheritedQuickLoginEnvironment {
  param([Parameter(Mandatory = $true)]$StartInfo)
  foreach ($Name in @('NAPCAT_QUICK_ACCOUNT', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_PASSWORD_MD5')) {
    $StartInfo.EnvironmentVariables.Remove($Name)
  }
}

function Get-StartedProcessIdentity {
  param([int]$RootProcessId, [string]$ExpectedExecutable, [DateTime]$NotBeforeUtc, $CreatedProcess)
  try {
    $ProcessInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId" -ErrorAction Stop
    if ($null -eq $ProcessInfo -or [int]$ProcessInfo.ProcessId -ne $RootProcessId -or $null -eq $ProcessInfo.CreationDate) { throw 'missing process identity' }
    $CreatedUtc = ([DateTime]$ProcessInfo.CreationDate).ToUniversalTime()
    if ($CreatedUtc -lt $NotBeforeUtc -or [int]$ProcessInfo.ParentProcessId -ne $PID -or
      (Get-NormalizedQqPath $ProcessInfo.ExecutablePath) -cne (Get-NormalizedQqPath $ExpectedExecutable)) { throw 'process identity mismatch' }
    $Identity = [pscustomobject]@{ processId = $RootProcessId; createdUtc = $CreatedUtc; executablePath = (Get-NormalizedQqPath $ProcessInfo.ExecutablePath); parentProcessId = [int]$ProcessInfo.ParentProcessId; processObject = $CreatedProcess; processHandle = $null; processStartUtc = $null }
    if ($null -ne $CreatedProcess) {
      if ($CreatedProcess -isnot [Diagnostics.Process] -or $CreatedProcess.Id -ne $RootProcessId -or $CreatedProcess.HasExited) { throw 'created process object unavailable' }
      $Identity.processHandle = $CreatedProcess.SafeHandle
      $Identity.processStartUtc = $CreatedProcess.StartTime.ToUniversalTime()
      if ($Identity.processHandle.IsInvalid -or $Identity.processHandle.IsClosed -or $Identity.processStartUtc -lt $NotBeforeUtc) { throw 'created process handle unavailable' }
    }
    return $Identity
  } catch { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Started root identity unavailable; preserve processes and do not retry' }
}

function Assert-StartedProcessIdentity {
  param($AttemptIdentity)
  if ($null -eq $AttemptIdentity) { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Missing attempt identity' }
  try { $Current = Get-CimInstance Win32_Process -Filter "ProcessId = $($AttemptIdentity.processId)" -ErrorAction Stop }
  catch { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Cannot inspect started root; do not retry' }
  if ($null -eq $Current -or [int]$Current.ProcessId -ne $AttemptIdentity.processId -or $null -eq $Current.CreationDate -or
    ([DateTime]$Current.CreationDate).ToUniversalTime() -ne $AttemptIdentity.createdUtc -or
    [int]$Current.ParentProcessId -ne $AttemptIdentity.parentProcessId -or
    [string]::IsNullOrWhiteSpace([string]$Current.ExecutablePath) -or
    (Get-NormalizedQqPath $Current.ExecutablePath) -cne $AttemptIdentity.executablePath) {
    throw '[NAPCAT_PROCESS_STATE_UNKNOWN] Started root disappeared or changed identity; preserve descendants and do not retry'
  }
}

function Get-NapCatProcessSnapshot {
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { [int]$_.ProcessId -gt 0 } | Select-Object ProcessId, ParentProcessId, CreationDate, ExecutablePath, CommandLine)
}

function Get-NapCatCreationStamp {
  param([DateTime]$CreatedAt)
  $Ticks = $CreatedAt.ToUniversalTime().Ticks
  return $Ticks - ($Ticks % 10)
}

function New-NapCatOwnedRecord {
  param($ProcessObject, $Snapshot, [scriptblock]$Verifier, [switch]$AllowExitedRoot)
  $Handle = $null
  $Handle = $ProcessObject.SafeHandle
  if ($Handle.IsClosed -or $Handle.IsInvalid) { throw 'owned_handle_unavailable' }
  $CreatedUtc = $ProcessObject.StartTime.ToUniversalTime()
  if ($ProcessObject.Id -ne [int]$Snapshot.ProcessId -or
    (Get-NapCatCreationStamp $CreatedUtc) -ne (Get-NapCatCreationStamp ([DateTime]$Snapshot.CreationDate))) { throw 'owned_creation_mismatch' }
  Initialize-QqPathIdentityApi
  $ExpectedImage = Get-NormalizedQqPath ([string]$Snapshot.ExecutablePath)
  $ExitedUtc = $null
  try { $Image = Get-NormalizedQqPath ([NapCatLoginPathIdentity]::ProcessImage($Handle)) }
  catch {
    if (-not $AllowExitedRoot -or -not $ProcessObject.HasExited -or
      $Handle.IsClosed -or $Handle.IsInvalid -or -not [object]::ReferenceEquals($ProcessObject.SafeHandle, $Handle) -or
      [string]::IsNullOrWhiteSpace([string]$ProcessObject.StartInfo.FileName) -or
      (Get-NormalizedQqPath $ProcessObject.StartInfo.FileName) -cne $ExpectedImage) { throw }
    $ExitedUtc = $ProcessObject.ExitTime.ToUniversalTime()
    if ($ExitedUtc -lt $CreatedUtc) { throw 'owned_exit_time_mismatch' }
    $Image = $ExpectedImage
  }
  if ($Image -cne $ExpectedImage) { throw 'owned_image_mismatch' }
  if ($null -ne $Verifier -and -not (& $Verifier $Snapshot)) { throw 'owned_scope_mismatch' }
  return [pscustomobject]@{ processId = [int]$Snapshot.ProcessId; parentId = [int]$Snapshot.ParentProcessId; createdUtc = $CreatedUtc; exitedUtc = $ExitedUtc; image = $Image; process = $ProcessObject; handle = $Handle; commandLine = [string]$Snapshot.CommandLine; killRequested = $false; disposed = $false }
}

function New-NapCatOwnedTree {
  param($RootProcess, $RootSnapshot, [scriptblock]$SnapshotProvider, [scriptblock]$Verifier)
  $RootRecord = New-NapCatOwnedRecord $RootProcess $RootSnapshot $Verifier -AllowExitedRoot
  $Context = [pscustomobject]@{ rootId = $RootRecord.processId; startedUtc = $RootRecord.createdUtc; records = @{}; problems = [Collections.Generic.HashSet[string]]::new(); snapshots = 0; snapshotProvider = $SnapshotProvider; verifier = $Verifier; cleanupAttempted = $false; disposed = $false; result = $null }
  $Context.records[$RootRecord.processId] = $RootRecord
  return $Context
}

function Update-NapCatOwnedTree {
  param($Context)
  if ($Context.disposed) { throw 'owned_context_disposed' }
  foreach ($Record in @($Context.records.Values)) {
    try {
      if ($Record.process.HasExited -and $null -eq $Record.exitedUtc) { $Record.exitedUtc = $Record.process.ExitTime.ToUniversalTime() }
    } catch { $null = $Context.problems.Add('owned_exit_time_unavailable:' + $Record.processId) }
  }
  try {
    $Snapshot = if ($null -ne $Context.snapshotProvider) { @(& $Context.snapshotProvider) } else { @(Get-NapCatProcessSnapshot) }
    $Context.snapshots++
  } catch { $null = $Context.problems.Add('process_snapshot_failed'); return }
  $OtherIds = [Collections.Generic.HashSet[int]]::new()
  $OtherBirth = @{}
  $Pending = [Collections.Generic.List[object]]::new()
  foreach ($Entry in $Snapshot) {
    $EntryId = [int]$Entry.ProcessId
    if ($Context.records.ContainsKey($EntryId)) {
      if ($null -eq $Entry.CreationDate -or (Get-NapCatCreationStamp ([DateTime]$Entry.CreationDate)) -ne (Get-NapCatCreationStamp $Context.records[$EntryId].createdUtc)) { $null = $Context.problems.Add('owned_pid_reused:' + $EntryId) }
      continue
    }
    if ($null -eq $Entry.CreationDate) { $null = $Context.problems.Add('snapshot_creation_unknown:' + $EntryId); continue }
    if (([DateTime]$Entry.CreationDate).ToUniversalTime() -lt $Context.startedUtc) { $null = $OtherIds.Add($EntryId); $OtherBirth[$EntryId] = ([DateTime]$Entry.CreationDate).ToUniversalTime() }
    else { $Pending.Add($Entry) }
  }
  do {
    $Progress = $false
    foreach ($Entry in @($Pending.ToArray())) {
      $ParentId = [int]$Entry.ParentProcessId
      $EntryId = [int]$Entry.ProcessId
      if ($OtherIds.Contains($ParentId)) {
        if ((Get-NapCatCreationStamp $OtherBirth[$ParentId]) -gt (Get-NapCatCreationStamp ([DateTime]$Entry.CreationDate))) { $null = $Context.problems.Add('unrelated_parent_pid_reused:' + $EntryId) }
        else { $null = $OtherIds.Add($EntryId); $OtherBirth[$EntryId] = ([DateTime]$Entry.CreationDate).ToUniversalTime() }
        $null = $Pending.Remove($Entry); $Progress = $true; continue
      }
      if (-not $Context.records.ContainsKey($ParentId)) { continue }
      $Parent = $Context.records[$ParentId]
      $BornUtc = ([DateTime]$Entry.CreationDate).ToUniversalTime()
      try {
        if ($Parent.process.HasExited -and $null -eq $Parent.exitedUtc) { $Parent.exitedUtc = $Parent.process.ExitTime.ToUniversalTime() }
        if ((Get-NapCatCreationStamp $BornUtc) -lt (Get-NapCatCreationStamp $Parent.createdUtc) -or
          ($null -ne $Parent.exitedUtc -and (Get-NapCatCreationStamp $BornUtc) -gt (Get-NapCatCreationStamp $Parent.exitedUtc))) { throw 'parent_lifetime_mismatch' }
        if ($null -ne $Context.verifier -and -not (& $Context.verifier $Entry)) { throw 'descendant_scope_mismatch' }
        $ChildProcess = [Diagnostics.Process]::GetProcessById($EntryId)
        try { $ChildRecord = New-NapCatOwnedRecord $ChildProcess $Entry $Context.verifier }
        catch { $ChildProcess.Dispose(); throw }
        $Context.records[$EntryId] = $ChildRecord
      } catch { $null = $Context.problems.Add('descendant_capture_unknown:' + $EntryId + ':' + $_.Exception.Message) }
      $null = $Pending.Remove($Entry); $Progress = $true
    }
  } while ($Progress -and $Pending.Count -gt 0)
  foreach ($Entry in $Pending) { $null = $Context.problems.Add('unresolved_parent_chain:' + [int]$Entry.ProcessId) }
}

function Stop-NapCatOwnedTree {
  param($Context, [ValidateRange(500, 10000)][int]$TimeoutMilliseconds = 5000, [scriptblock]$BeforeTerminate)
  if ($Context.disposed) { throw 'owned_context_disposed' }
  $Context.cleanupAttempted = $true
  $Clock = [Diagnostics.Stopwatch]::StartNew()
  $QuietPasses = 0
  do {
    Update-NapCatOwnedTree $Context
    $CountBefore = $Context.records.Count
    foreach ($Record in @($Context.records.Values | Sort-Object createdUtc)) {
      try {
        if ($Record.process.HasExited) { continue }
        if ($Record.handle.IsClosed -or $Record.handle.IsInvalid -or
          -not [object]::ReferenceEquals($Record.process.SafeHandle, $Record.handle) -or
          $Record.process.Id -ne $Record.processId -or $Record.process.StartTime.ToUniversalTime() -ne $Record.createdUtc -or
          (Get-NormalizedQqPath ([NapCatLoginPathIdentity]::ProcessImage($Record.handle))) -cne $Record.image) { throw 'retained_handle_identity_mismatch' }
        if ($null -ne $BeforeTerminate) { & $BeforeTerminate $Record }
        $Record.process.Kill()
        $Record.killRequested = $true
        $null = $Record.process.WaitForExit(100)
      } catch { $null = $Context.problems.Add('termination_unknown:' + $Record.processId + ':' + $_.Exception.Message) }
    }
    Update-NapCatOwnedTree $Context
    $Live = @($Context.records.Values | Where-Object { -not $_.process.HasExited })
    if ($Live.Count -eq 0 -and $CountBefore -eq $Context.records.Count) { $QuietPasses++ } else { $QuietPasses = 0 }
    if ($QuietPasses -ge 2) { break }
    Start-Sleep -Milliseconds 30
  } while ($Clock.ElapsedMilliseconds -lt $TimeoutMilliseconds)
  if ($Live.Count -gt 0) { $null = $Context.problems.Add('owned_processes_still_alive') }
  if ($QuietPasses -lt 2) { $null = $Context.problems.Add('post_termination_collection_incomplete') }
  $Context.result = [pscustomobject]@{ state = $(if ($Context.problems.Count -eq 0) { 'terminated' } else { 'unknown' }); captured = $Context.records.Count; snapshots = $Context.snapshots; remaining = @($Live | ForEach-Object processId); problems = @($Context.problems); records = @($Context.records.Values | ForEach-Object { [pscustomobject]@{ processId=$_.processId; parentId=$_.parentId; createdUtc=$_.createdUtc; exitedUtc=$_.exitedUtc; image=$_.image; killRequested=$_.killRequested } }) }
  return $Context.result
}

function Close-NapCatOwnedTree {
  param($Context)
  if ($null -eq $Context -or $Context.disposed) { return }
  foreach ($Record in $Context.records.Values) {
    try { $Record.process.Dispose(); $Record.disposed = $Record.handle.IsClosed }
    catch { $null = $Context.problems.Add('owned_handle_disposal_failed:' + $Record.processId) }
  }
  $Context.disposed = @($Context.records.Values | Where-Object { -not $_.disposed }).Count -eq 0
  if (-not $Context.disposed) { throw '[NAPCAT_PROCESS_CLEANUP_UNVERIFIED] Owned process handle disposal failed' }
}

function Stop-LaunchedProcessTree {
  param([int]$RootProcessId, $AttemptIdentity)
  if ($null -eq $AttemptIdentity -or $RootProcessId -ne $AttemptIdentity.processId) { throw '[NAPCAT_PROCESS_CLEANUP_REQUIRED] Cleanup identity unavailable; no process was stopped' }
  if ($null -eq $AttemptIdentity.ownedTree) { throw '[NAPCAT_PROCESS_CLEANUP_REQUIRED] Owned-tree context unavailable' }
  $Cleanup = Stop-NapCatOwnedTree $AttemptIdentity.ownedTree
  if ($Cleanup.state -ne 'terminated') {
    $Failure = [InvalidOperationException]::new('[NAPCAT_PROCESS_CLEANUP_UNVERIFIED] ' + ($Cleanup.problems -join '; '))
    $Failure.Data['RootProcessId'] = $RootProcessId
    $Failure.Data['OwnedProcessCleanup'] = $Cleanup
    throw $Failure
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

function Write-DisabledQuickLoginMarker {
  param([string]$MarkerPath, $Payload)
  [System.IO.File]::WriteAllText($MarkerPath, ($Payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
}

function Disable-QuickLoginCredential {
  param(
    [string]$CredentialPath,
    [string]$Reason,
    [bool]$FallbackUsed = $false
  )
  if (-not $FallbackUsed) { return [pscustomobject]@{ disabled = $false; reason = 'fallback_not_used'; path = $null } }
  if ([string]::IsNullOrWhiteSpace($CredentialPath) -or -not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { return [pscustomobject]@{ disabled = $false; reason = 'credential_absent'; path = $null } }
  $Moved = $false
  $DisabledPath = $null
  try {
    $CredentialDirectory = Split-Path -Parent $CredentialPath
    $Stamp = [Guid]::NewGuid().ToString('N')
    $DisabledPath = Join-Path $CredentialDirectory "credential.disabled-$Stamp.json"
    Move-Item -LiteralPath $CredentialPath -Destination $DisabledPath -ErrorAction Stop
    $Moved = $true
    Protect-NapCatCredentialPath -Path $DisabledPath
    $MarkerPath = Join-Path $CredentialDirectory "credential.disabled.json"
    $Payload = [ordered]@{
      schemaVersion = 1
      disabledAt = [DateTime]::UtcNow.ToString("o")
      reason = $Reason
      disabledCredentialPath = $DisabledPath
    }
    Write-DisabledQuickLoginMarker -MarkerPath $MarkerPath -Payload $Payload
    Protect-NapCatCredentialPath -Path $MarkerPath
    return [pscustomobject]@{ disabled = $true; reason = 'disabled'; path = $DisabledPath }
  } catch {
    $Failure = [InvalidOperationException]::new('[NAPCAT_CREDENTIAL_DISABLE_FAILED] Credential disable failed; moved=' + $Moved, $_.Exception)
    $Failure.Data['CredentialMoved'] = $Moved
    $Failure.Data['DisabledCredentialPath'] = $DisabledPath
    throw $Failure
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
  try { Stop-LaunchedProcessTree -RootProcessId $RootProcessId -AttemptIdentity $StartedProcessIdentity }
  catch { throw [InvalidOperationException]::new("[NAPCAT_PROCESS_CLEANUP_REQUIRED] $Reason；$($_.Exception.Message)。日志：$LogPath", $_.Exception) }
  throw "[NAPCAT_MANUAL_LOGIN_REQUIRED] $Reason，NapCat 要求人工验证。日志：$LogPath"
}

function New-NapCatLoginAttemptLock {
  param(
    [string]$DataRoot,
    [string]$NapCatRoot,
    [string]$ExpectedSelfId,
    [string]$QqProfileRoot,
    [switch]$NoQr
  )
  $ProfileMutex = [Threading.Mutex]::new($false, (Get-QqLoginLockName -UserDataDir $QqProfileRoot))
  $OwnsProfileMutex = $false
  $LockStream = $null
  try {
    try { $OwnsProfileMutex = $ProfileMutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $OwnsProfileMutex = $true }
    if (-not $OwnsProfileMutex) { throw '[NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS] Shared QQ profile login is already in progress' }
  $StateDirectory = Join-Path $DataRoot "state"
  New-Item -ItemType Directory -Force -Path $StateDirectory | Out-Null
  $SafeAccount = if ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
    "unknown"
  } else {
    $ExpectedSelfId -replace '[^0-9A-Za-z_.-]', '_'
  }
  $LockPath = Join-Path $StateDirectory "napcat-login-attempt-$SafeAccount.lock"
  try {
    $LockStream = [System.IO.File]::Open(
      $LockPath,
      [System.IO.FileMode]::OpenOrCreate,
      [System.IO.FileAccess]::ReadWrite,
      [System.IO.FileShare]::None
    )
  } catch [System.IO.IOException] {
    throw "[NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS] 已有 NapCat 登录尝试正在进行，拒绝并发启动同一账号：$ExpectedSelfId。lock=$LockPath"
  }
  $Payload = [ordered]@{
    schemaVersion = 1
    pid = $PID
    account = $ExpectedSelfId
    napCatRoot = $NapCatRoot
    mode = if ($NoQr) { "no_qr" } else { "manual" }
    acquiredAt = [DateTime]::UtcNow.ToString("o")
  }
  $Bytes = [System.Text.Encoding]::UTF8.GetBytes(($Payload | ConvertTo-Json -Depth 4))
  $LockStream.SetLength(0)
  $LockStream.Write($Bytes, 0, $Bytes.Length)
  $LockStream.Flush()
  return [pscustomobject]@{ Path = $LockPath; Stream = $LockStream; Mutex = $ProfileMutex; OwnsMutex = $OwnsProfileMutex }
  } catch {
    if ($null -ne $LockStream) { $LockStream.Dispose() }
    if ($OwnsProfileMutex) { $ProfileMutex.ReleaseMutex() }
    $ProfileMutex.Dispose()
    throw
  }
}

function Release-NapCatLoginAttemptLock {
  param($Lock)
  if ($null -eq $Lock) { return }
  try {
    if ($null -ne $Lock.Stream) { $Lock.Stream.Dispose() }
  } catch {
  }
  try {
    if (-not [string]::IsNullOrWhiteSpace([string]$Lock.Path) -and (Test-Path -LiteralPath $Lock.Path -PathType Leaf)) {
      Remove-Item -LiteralPath $Lock.Path -Force
    }
  } catch {
  }
  if ($Lock.OwnsMutex) { $Lock.Mutex.ReleaseMutex() }
  if ($null -ne $Lock.Mutex) { $Lock.Mutex.Dispose() }
}

function ConvertTo-NapCatCommandLineText {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return $Value.Trim('"').TrimEnd('\').ToLowerInvariant().Replace('\', '/')
}

function Test-CommandLineContainsPath {
  param([string]$CommandLine, [string]$Path)
  if ([string]::IsNullOrWhiteSpace($CommandLine) -or [string]::IsNullOrWhiteSpace($Path)) { return $false }
  $Haystack = ConvertTo-NapCatCommandLineText $CommandLine
  $Needle = ConvertTo-NapCatCommandLineText $Path
  if ([string]::IsNullOrWhiteSpace($Needle)) { return $false }
  $StartAt = 0
  while ($StartAt -lt $Haystack.Length) {
    $FoundAt = $Haystack.IndexOf($Needle, $StartAt, [StringComparison]::Ordinal)
    if ($FoundAt -lt 0) { return $false }
    $AfterAt = $FoundAt + $Needle.Length
    $Before = if ($FoundAt -eq 0) { '' } else { $Haystack.Substring($FoundAt - 1, 1) }
    $After = if ($AfterAt -ge $Haystack.Length) { '' } else { $Haystack.Substring($AfterAt, 1) }
    $BeforeOk = $FoundAt -eq 0 -or $Before -match '[`"''\s=]'
    $AfterOk = $AfterAt -ge $Haystack.Length -or $After -match '[`"''\s<>/]'
    if ($BeforeOk -and $AfterOk) { return $true }
    $StartAt = $FoundAt + 1
  }
  return $false
}

function Get-ExistingNapCatRuntimeProcesses {
  param(
    [string]$NapCatRoot,
    [string]$QqExePath,
    [string]$QqUserDataDir
  )
  try { $Snapshot = @(Get-NapCatOwnershipSnapshot) } catch { throw "[NAPCAT_PROCESS_SCAN_UNKNOWN] $($_.Exception.Message)" }
  $Classification = Get-NapCatProcessClassification -Processes $Snapshot -NapCatRoot $NapCatRoot
  if ($Classification.unknown.Count -gt 0) {
    throw "[NAPCAT_PROCESS_SCAN_UNKNOWN] QQ ownership is unverified: $($Classification.unknown.ProcessId -join ',')"
  }
  return @($Classification.owned | Where-Object { $_.ProcessId -ne $PID } | Sort-Object ProcessId | ForEach-Object {
    [pscustomobject]@{
      processId = [int]$_.ProcessId
      name = [string]$_.Name
      commandLine = [string]$_.CommandLine
      creationDate = [string]$_.CreationDate
    }
  })
}

function Get-AliveNapCatRuntimeProcessIds {
  param([object[]]$Processes)
  return @($Processes | ForEach-Object {
    $ProcessId = [int]$_.processId
    $Current = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $Current -and (Test-NapCatCreationTime $Current.StartTime ([string]$_.creationDate))) { $ProcessId }
  } | Sort-Object -Unique)
}

function Wait-ExistingNapCatRuntimeOnline {
  param([object[]]$Processes, [int]$WaitSeconds, [string]$LogPath)
  $Deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(1, $WaitSeconds))
  $ObservedProcessIds = @($Processes | ForEach-Object { [int]$_.processId } | Sort-Object -Unique)
  $LastProbe = '尚未完成 OneBot 探测'
  Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[{0}] [codex] existing_napcat_runtime_detected pid={1}; waitSeconds={2}; refuse_second_launch=true" -f (Get-Date).ToString('o'), ($ObservedProcessIds -join ','), $WaitSeconds)
  while ([DateTime]::UtcNow -lt $Deadline) {
    $AliveProcessIds = @(Get-AliveNapCatRuntimeProcessIds -Processes $Processes)
    if ($AliveProcessIds.Count -eq 0) {
      Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[{0}] [codex] existing_napcat_runtime_gone; continue_launch=true" -f (Get-Date).ToString('o'))
      return $null
    }
    try {
      $Status = Invoke-OneBot -Action 'get_status'
      if ($Status.status -eq 'ok' -and $Status.data.online -eq $true -and $Status.data.good -eq $true) {
        $Login = Invoke-OneBot -Action 'get_login_info'
        if ($Login.status -ne 'ok') { throw 'get_login_info unavailable' }
        $VerifiedLogin = Assert-ExpectedLogin -LoginData $Login.data
        return [pscustomobject]@{ state='online_existing'; launched=$false; processId=$null; existingProcessIds=$AliveProcessIds; userId=$VerifiedLogin.userId; nickname=$VerifiedLogin.nickname; qrCodePath=$null; logPath=$LogPath }
      }
      $LastProbe = "get_status 返回 online=$($Status.data.online) good=$($Status.data.good)"
    } catch {
      if ($_.Exception.Message -like 'NapCat 登录了错误*') { throw }
      $LastProbe = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }
  $AliveAtDeadline = @(Get-AliveNapCatRuntimeProcessIds -Processes $Processes)
  throw "[NAPCAT_PROCESS_PRESENT] 检测到已有 NapCat 运行态或登录窗口（pid=$($AliveAtDeadline -join ',')），但 OneBot 在 $WaitSeconds 秒内没有上线；为避免同一账号被第二个 NapCat 顶下线，本次拒绝再启动。日志：$LogPath；最后探测：$LastProbe"
}

$VerifiedLogin = Get-VerifiedOnlineLogin
  if ($null -ne $VerifiedLogin) {
    [pscustomobject]@{
      state = "already_online"
      launched = $false
      processId = $null
      userId = $VerifiedLogin.userId
      nickname = $VerifiedLogin.nickname
      qrCodePath = $null
      logPath = $null
    } | ConvertTo-Json -Depth 5
    return
  }

$EffectiveQqProfileRoot = $QqUserDataDir
if ([string]::IsNullOrWhiteSpace($EffectiveQqProfileRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:APPDATA)) { throw '[NAPCAT_PROCESS_STATE_UNKNOWN] QQ profile root unavailable' }
  $EffectiveQqProfileRoot = Join-Path $env:APPDATA 'QQ'
}
$EffectiveQqProfileRoot = Get-NormalizedQqPath -Path $EffectiveQqProfileRoot
$QqUserDataDir = $EffectiveQqProfileRoot
$LoginAttemptLock = New-NapCatLoginAttemptLock -DataRoot $DataRoot -NapCatRoot $NapCatRoot -ExpectedSelfId $ExpectedSelfId -QqProfileRoot $EffectiveQqProfileRoot -NoQr:$NoQr
$OwnedTree = $null
$StartedProcess = $null
$LoginSucceeded = $false
try {
$StartedAtUtc = [DateTime]::UtcNow
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory "codex-login-$Stamp.log"
$ErrorLogPath = Join-Path $LogDirectory "codex-login-$Stamp.error.log"
Set-OneBotSafeStartupConfig -NapCatRoot $NapCatRoot -ExpectedSelfId $ExpectedSelfId -LogPath $LogPath
$ExistingNapCatProcesses = @(Get-ExistingNapCatRuntimeProcesses -NapCatRoot $NapCatRoot -QqExePath $QqExePath -QqUserDataDir $QqUserDataDir)
if ($ExistingNapCatProcesses.Count -gt 0) {
  $ExistingProcessWaitSeconds = if ($NoQr) { [Math]::Min(3, $TimeoutSeconds) } else { [Math]::Min(30, $TimeoutSeconds) }
  $ExistingRuntimeResult = Wait-ExistingNapCatRuntimeOnline -Processes $ExistingNapCatProcesses -WaitSeconds $ExistingProcessWaitSeconds -LogPath $LogPath
  if ($null -ne $ExistingRuntimeResult) { $ExistingRuntimeResult | ConvertTo-Json -Depth 5; return }
}
$VerifiedLogin = Get-LockedQqLoginState -UserDataDir $EffectiveQqProfileRoot
if ($null -ne $VerifiedLogin) {
  [pscustomobject]@{ state='already_online'; launched=$false; processId=$null; userId=$VerifiedLogin.userId; nickname=$VerifiedLogin.nickname; qrCodePath=$null; logPath=$LogPath } | ConvertTo-Json -Depth 5
  return
}
$QuickPasswordMd5 = if ($NoQr -and (-not $NoPasswordFallback)) {
  try {
    Read-NapCatQuickLoginCredential -CredentialPath $QuickLoginCredentialPath -ExpectedAccount $ExpectedSelfId
  } catch {
    throw "[NAPCAT_MANUAL_LOGIN_REQUIRED] 加密密码回退凭据不可用：$($_.Exception.Message)"
  }
} else {
  $null
}
$HasPasswordFallback = -not [string]::IsNullOrWhiteSpace($QuickPasswordMd5)
$PasswordFallbackDeadlineUtc = $StartedAtUtc.AddSeconds([Math]::Min(60, [Math]::Max(25, $TimeoutSeconds - 5)))
$EmptyInputPath = Join-Path $LogDirectory ".codex-empty-input"
if (-not (Test-Path -LiteralPath $EmptyInputPath)) {
  [System.IO.File]::WriteAllText($EmptyInputPath, "", (New-Object System.Text.UTF8Encoding($false)))
}
$LauncherArguments = if ([string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
  ""
} else {
  " `"$ExpectedSelfId`""
}
$QqAppDataRoot = ""
if (-not [string]::IsNullOrWhiteSpace($QqUserDataDir)) {
  New-Item -ItemType Directory -Force -Path $QqUserDataDir | Out-Null
  $QqAppDataRoot = Split-Path -Parent $QqUserDataDir
  if ([string]::IsNullOrWhiteSpace($QqAppDataRoot)) { throw "qqUserDataDir 必须位于一个有效父目录下：$QqUserDataDir" }
  New-Item -ItemType Directory -Force -Path $QqAppDataRoot | Out-Null
}
if ([string]::IsNullOrWhiteSpace($QqExePath)) {
  if (($NoQr -or $HasPasswordFallback) -and [string]::IsNullOrWhiteSpace($ExpectedSelfId)) {
    throw "NapCat 快速登录要求 binding.json 提供 expectedSelfId"
  }
  $SelectedLauncher = if (-not [string]::IsNullOrWhiteSpace($ExpectedSelfId)) { $Launcher } else { $ManualLauncher }
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
Clear-InheritedQuickLoginEnvironment -StartInfo $StartInfo
if (-not [string]::IsNullOrWhiteSpace($QqExePath)) {
  $PatchPackage = Join-Path $NapCatRoot 'qqnt.json'
  if (-not (Test-Path -LiteralPath $PatchPackage -PathType Leaf)) { throw '[NAPCAT_RUNTIME_INCOMPLETE] NapCat package template is missing' }
  $StartInfo.EnvironmentVariables['NAPCAT_PATCH_PACKAGE'] = $PatchPackage
  $StartInfo.EnvironmentVariables['NAPCAT_LOAD_PATH'] = $LoaderModule
  $StartInfo.EnvironmentVariables['NAPCAT_INJECT_PATH'] = $HookModule
  $StartInfo.EnvironmentVariables['NAPCAT_LAUNCHER_PATH'] = $BootMain
  $StartInfo.EnvironmentVariables['NAPCAT_MAIN_PATH'] = $CoreModule.Replace('\', '/')
}
$StartedProcessIdentity = $null
try {
  if (-not [string]::IsNullOrWhiteSpace($QqAppDataRoot)) {
    $StartInfo.EnvironmentVariables["APPDATA"] = $QqAppDataRoot
    $StartInfo.EnvironmentVariables["NAPCAT_QQ_USER_DATA_DIR"] = $QqUserDataDir
  }
  if ($HasPasswordFallback) {
    $StartInfo.EnvironmentVariables["NAPCAT_QUICK_ACCOUNT"] = $ExpectedSelfId
    $StartInfo.EnvironmentVariables["NAPCAT_QUICK_PASSWORD_MD5"] = $QuickPasswordMd5
  }
  $ProcessLaunchUtc = [DateTime]::UtcNow
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
$RootSnapshot = [pscustomobject]@{ ProcessId=$ProcessId; ParentProcessId=$PID; CreationDate=$StartedProcess.StartTime.ToUniversalTime(); ExecutablePath=$StartInfo.FileName; CommandLine=($StartInfo.FileName + ' ' + $StartInfo.Arguments) }
$OwnedTree = New-NapCatOwnedTree -RootProcess $StartedProcess -RootSnapshot $RootSnapshot
$StartedProcessIdentity = [pscustomobject]@{ processId=$ProcessId; ownedTree=$OwnedTree }
$Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$QrWindow = $null
$VerificationWindow = $null
$LastVerificationUrl = $null
$ManualVerificationExtensionSeconds = 900
while ([DateTime]::UtcNow -lt $Deadline) {
  if ($null -ne $QrWindow) { [System.Windows.Forms.Application]::DoEvents() }
  if ($null -ne $VerificationWindow) { [System.Windows.Forms.Application]::DoEvents() }
  Update-NapCatOwnedTree $OwnedTree
  if ($StartedProcess.HasExited) {
    $RecentLoginLog = Read-RecentLoginLog -Path @($LogPath, $ErrorLogPath)
    $PasswordFallbackNeedsHuman = Test-PasswordFallbackNeedsHuman -RecentLoginLog $RecentLoginLog
    $PasswordFallbackRejected = Test-PasswordFallbackRejected -RecentLoginLog $RecentLoginLog
    if ($NoQr -and $PasswordFallbackNeedsHuman) {
      Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "加密密码回退已触发短信验证或验证码，保留本地凭据并等待人工验证" -LogPath $LogPath
    }
    if ($NoQr -and $HasPasswordFallback -and $PasswordFallbackRejected) {
      $DisableResult = Disable-QuickLoginCredential -CredentialPath $QuickLoginCredentialPath -Reason "password_fallback_login_failed" -FallbackUsed $HasPasswordFallback
      $HasPasswordFallback = $false
      Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "密码回退被拒绝；凭据处理结果：$($DisableResult.reason)" -LogPath $LogPath
    }
    if ($NoQr -and (Test-QuickLoginCredentialInvalid -RecentLoginLog $RecentLoginLog)) {
      Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "NapCat 登录进程提前退出前已报告登录态失效" -LogPath $LogPath
    }
    Close-QrWindow -Window $QrWindow
    Close-QrWindow -Window $VerificationWindow
    throw "[NAPCAT_PROCESS_STATE_UNKNOWN] 登录根进程已退出，子进程归属未确认，禁止自动重试。日志：$LogPath"
  }
  try {
    $Status = Invoke-OneBot -Action "get_status"
    if ($Status.status -eq "ok" -and $Status.data.online -eq $true -and $Status.data.good -eq $true) {
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
      $LoginSucceeded = $true
      return
    }
  } catch {
    if ($_.Exception.Message -like "NapCat 登录了错误*") {
      Close-QrWindow -Window $QrWindow
      Close-QrWindow -Window $VerificationWindow
      Stop-LaunchedProcessTree -RootProcessId $ProcessId -AttemptIdentity $StartedProcessIdentity
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
  if ($NoQr -and $HasPasswordFallback -and $PasswordFallbackRejected) {
    $DisableResult = Disable-QuickLoginCredential -CredentialPath $QuickLoginCredentialPath -Reason "password_fallback_login_failed" -FallbackUsed $HasPasswordFallback
    $HasPasswordFallback = $false
    Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason "密码回退被拒绝；凭据处理结果：$($DisableResult.reason)" -LogPath $LogPath
  }
  if ($NoQr -and (-not $HasPasswordFallback) -and ($QuickLoginCredentialInvalid -or $null -ne $QrCode)) {
    $Reason = if ($NoPasswordFallback) {
      "快速登录记录已不可用，自动路径已禁用密码回退"
    } else {
      "快速登录记录已不可用且尚未配置加密密码回退"
    }
    Stop-AndThrowManualLoginRequired -RootProcessId $ProcessId -QrWindow $QrWindow -Reason $Reason -LogPath $LogPath
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
      $ExtendedDeadline = [DateTime]::UtcNow.AddSeconds($ManualVerificationExtensionSeconds)
      if ($ExtendedDeadline -gt $Deadline) { $Deadline = $ExtendedDeadline }
    }
  }
  Start-Sleep -Milliseconds 500
}

Close-QrWindow -Window $QrWindow
Close-QrWindow -Window $VerificationWindow
Stop-LaunchedProcessTree -RootProcessId $ProcessId -AttemptIdentity $StartedProcessIdentity
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
} catch {
  if ($null -ne $OwnedTree -and -not $LoginSucceeded -and -not $OwnedTree.cleanupAttempted) {
    $Cleanup = Stop-NapCatOwnedTree $OwnedTree
    if ($Cleanup.state -ne 'terminated') {
      $Failure = [InvalidOperationException]::new('[NAPCAT_PROCESS_CLEANUP_UNVERIFIED] ' + ($Cleanup.problems -join '; '), $_.Exception)
      $Failure.Data['RootProcessId'] = $OwnedTree.rootId
      $Failure.Data['OwnedProcessCleanup'] = $Cleanup
      throw $Failure
    }
  }
  throw
} finally {
  try {
    Close-NapCatOwnedTree $OwnedTree
    if ($null -eq $OwnedTree -and $null -ne $StartedProcess) { $StartedProcess.Dispose() }
  } finally {
    Release-NapCatLoginAttemptLock -Lock $LoginAttemptLock
  }
}
