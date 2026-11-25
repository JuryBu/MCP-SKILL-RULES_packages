function ConvertTo-NapCatOfflinePath {
  param($Value)
  if ($Value -isnot [string] -or $Value -notmatch '^[a-zA-Z]:[\\/]' -or
      $Value.Substring(2) -match '["<>|?*:\x00-\x1f%!]') { throw 'invalid_paths' }
  $FullPath = [IO.Path]::GetFullPath($Value)
  if ($FullPath.Length -gt 3) { return $FullPath.TrimEnd([char[]]'\/') }
  return $FullPath
}

function Get-NapCatOfflineLegacyLoginPath {
  return [IO.Path]::Combine([IO.Path]::GetDirectoryName($MyInvocation.MyCommand.ScriptBlock.File), 'start-napcat-login.ps1')
}

function Get-NapCatOfflineQqProfile {
  param([string]$QqUserDataDir)
  $ProfilePath = ConvertTo-NapCatOfflinePath $QqUserDataDir
  $Tokens = $null
  $ParseErrors = $null
  $Ast = [Management.Automation.Language.Parser]::ParseFile((Get-NapCatOfflineLegacyLoginPath), [ref]$Tokens, [ref]$ParseErrors)
  if (@($ParseErrors).Count -gt 0 -or $null -eq $Ast.EndBlock) { throw 'profile_unverified' }
  foreach ($Name in @('Initialize-QqPathIdentityApi', 'Get-NormalizedQqPath', 'Get-QqLoginLockName')) {
    $Definition = @($Ast.EndBlock.Statements | Where-Object {
      $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $Name
    })
    if ($Definition.Count -ne 1) { throw 'profile_unverified' }
    . ([scriptblock]::Create($Definition[0].Extent.Text))
  }
  $NormalizedProfile = Get-NormalizedQqPath -Path $ProfilePath
  return [pscustomobject]@{
    normalizedPath = $NormalizedProfile
    mutexName = Get-QqLoginLockName -UserDataDir $NormalizedProfile
  }
}

function Get-NapCatOfflineQqMutexName {
  param([string]$QqUserDataDir)
  return (Get-NapCatOfflineQqProfile -QqUserDataDir $QqUserDataDir).mutexName
}

function Get-NapCatOfflineRecoveryPaths {
  param($Paths)
  $Resolved = @{}
  foreach ($Name in @('dataRoot', 'accountStateDir', 'napcatRoot', 'brokerRoot', 'bindingPath', 'privateEnvPath', 'loginScriptPath', 'maintenancePath')) {
    $Resolved[$Name] = ConvertTo-NapCatOfflinePath $Paths.$Name
  }
  $Resolved.dataStateDir = [IO.Path]::Combine($Resolved.dataRoot, 'state')
  $Resolved.legacyStartupSha256 = $null
  if ($null -ne $Paths.legacyStartupSha256) {
    if ($Paths.legacyStartupSha256 -isnot [string] -or $Paths.legacyStartupSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'invalid_paths' }
    $Resolved.legacyStartupSha256 = $Paths.legacyStartupSha256
  }
  if ($Resolved.bindingPath -ine [IO.Path]::Combine($Resolved.dataRoot, 'binding.json') -or
      $Resolved.privateEnvPath -ine [IO.Path]::Combine($Resolved.brokerRoot, 'broker-private.env.json') -or
      $Resolved.loginScriptPath -ine (Get-NapCatOfflineLegacyLoginPath) -or
      -not [IO.Directory]::Exists($Resolved.dataStateDir) -or -not [IO.Directory]::Exists($Resolved.accountStateDir)) {
    throw 'invalid_paths'
  }
  $Runtime = $null
  if ([string]::IsNullOrWhiteSpace([string]$Paths.qqExePath) -or [string]::IsNullOrWhiteSpace([string]$Paths.qqUserDataDir)) {
    $RuntimePath = [IO.Path]::Combine($Resolved.dataRoot, 'napcat-runtime.json')
    if (Get-NapCatOfflinePathPresence $RuntimePath) {
      $Runtime = ConvertFrom-NapCatOfflineJsonBytes (Get-NapCatOfflineFileBytes $RuntimePath 65536)
    }
  }
  $QqExe = if ([string]::IsNullOrWhiteSpace([string]$Paths.qqExePath)) { $Runtime.qqExePath } else { $Paths.qqExePath }
  $Profile = if ([string]::IsNullOrWhiteSpace([string]$Paths.qqUserDataDir)) { $Runtime.qqUserDataDir } else { $Paths.qqUserDataDir }
  $Resolved.qqExePath = if ([string]::IsNullOrWhiteSpace([string]$QqExe)) { '' } else { ConvertTo-NapCatOfflinePath $QqExe }
  $Resolved.qqUserDataDir = if ([string]::IsNullOrWhiteSpace([string]$Profile)) {
    ConvertTo-NapCatOfflinePath ([IO.Path]::Combine($env:APPDATA, 'QQ'))
  } else { ConvertTo-NapCatOfflinePath $Profile }
  return $Resolved
}

function Read-NapCatOfflineFileStream {
  param([IO.FileStream]$Stream, [int]$Limit)
  if ($Stream.Length -le 0 -or $Stream.Length -gt $Limit) { throw 'invalid_file' }
  $Bytes = [byte[]]::new([int]$Stream.Length)
  $Offset = 0
  while ($Offset -lt $Bytes.Length) {
    $ReadCount = $Stream.Read($Bytes, $Offset, $Bytes.Length - $Offset)
    if ($ReadCount -le 0) { throw 'invalid_file' }
    $Offset += $ReadCount
  }
  return ,$Bytes
}

function Get-NapCatOfflineFileBytes {
  param([string]$Path, [int]$Limit)
  $Stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
  try {
    return ,(Read-NapCatOfflineFileStream -Stream $Stream -Limit $Limit)
  } finally { $Stream.Dispose() }
}

function ConvertFrom-NapCatOfflineJsonBytes {
  param([byte[]]$Bytes)
  $Text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes).TrimStart([char]0xfeff)
  $Parsed = if ($PSVersionTable.PSEdition -ceq 'Core') {
    ConvertFrom-Json -InputObject $Text -NoEnumerate -ErrorAction Stop
  } else {
    ConvertFrom-Json -InputObject $Text -ErrorAction Stop
  }
  if ($Parsed -is [array]) { return ,$Parsed }
  return $Parsed
}

function Get-NapCatOfflineSha256 {
  param([byte[]]$Bytes)
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($Hasher.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $Hasher.Dispose() }
}

function Get-NapCatOfflinePathPresence {
  param([string]$Path)
  try { $null = [IO.File]::GetAttributes($Path); return $true }
  catch [IO.FileNotFoundException] { return $false }
  catch [IO.DirectoryNotFoundException] { return $false }
}

function Test-NapCatOfflineRecoveryInhibited {
  param($Paths)
  if ((Get-NapCatOfflinePathPresence ([IO.Path]::Combine($Paths.accountStateDir, 'startup.stop'))) -or
      (Get-NapCatOfflinePathPresence ([IO.Path]::Combine($Paths.dataStateDir, 'supervisor-maintenance.json')))) { return $true }
  if (-not (Get-NapCatOfflinePathPresence $Paths.maintenancePath)) { return $false }
  $Maintenance = ConvertFrom-NapCatOfflineJsonBytes (Get-NapCatOfflineFileBytes $Paths.maintenancePath 65536)
  if ($null -eq $Maintenance -or $Maintenance.GetType() -ne [Management.Automation.PSCustomObject]) { return $true }
  $SchemaVersion = $Maintenance.schemaVersion
  if (($SchemaVersion -isnot [int] -and $SchemaVersion -isnot [long]) -or $SchemaVersion -ne 1) { return $true }
  $ReasonsField = $Maintenance.PSObject.Properties['reasons']
  if ($null -ne $ReasonsField) {
    $Reasons = $ReasonsField.Value
    if ($Reasons -is [array]) {
      if ($Reasons.Length -gt 0) { return $true }
    } elseif ($null -ne $Reasons -and $Reasons.GetType() -eq [Management.Automation.PSCustomObject]) {
      if (@($Reasons.PSObject.Properties).Count -gt 0) { return $true }
    } else { return $true }
  }
  foreach ($Name in @('status', 'state', 'mode')) {
    $Field = $Maintenance.PSObject.Properties[$Name]
    if ($null -ne $Field -and ($Field.Value -isnot [string] -or $Field.Value -notin @('', 'inactive'))) { return $true }
  }
  foreach ($Name in @('active', 'maintenance', 'paused')) {
    $Field = $Maintenance.PSObject.Properties[$Name]
    if ($null -ne $Field -and ($Field.Value -isnot [bool] -or $Field.Value)) { return $true }
  }
  return $false
}

function Get-NapCatOfflineDeploymentAccount {
  param($Paths, $Profile, $Deployment, $Binding)
  $Account = [string]$Binding.expectedSelfId
  if ($Deployment -isnot [pscustomobject] -or $Binding -isnot [pscustomobject] -or $Deployment.state -cne 'active' -or
      $Account -cnotmatch '^[0-9]{1,32}$' -or [string]$Deployment.account -cne $Account) { throw 'deployment_unverified' }
  foreach ($Name in @('dataRoot', 'napCatRoot', 'brokerRoot', 'qqExePath')) {
    $DeployedPath = if ($Name -eq 'qqExePath' -and [string]::IsNullOrWhiteSpace([string]$Deployment.$Name)) {
      ''
    } else { ConvertTo-NapCatOfflinePath $Deployment.$Name }
    if ($DeployedPath -ine $Paths.$Name) { throw 'deployment_unverified' }
  }
  if (-not [IO.Directory]::Exists($Deployment.qqUserDataDir)) { throw 'deployment_unverified' }
  $DeployedProfile = Get-NapCatOfflineQqProfile -QqUserDataDir $Deployment.qqUserDataDir
  if ($DeployedProfile.normalizedPath -cne $Profile.normalizedPath -or
      $DeployedProfile.mutexName -cne $Profile.mutexName) { throw 'deployment_unverified' }
  return $Account
}

function Release-NapCatOfflineLoginAttemptFile {
  param($Guard)
  if ($null -ne $Guard -and $null -ne $Guard.loginAttemptFile) {
    $Guard.loginAttemptFile.Dispose()
    $Guard.loginAttemptFile = $null
  }
}

function Close-NapCatOfflineResources {
  param([object[]]$Resources)
  $CleanupFailed = $false
  foreach ($Resource in $Resources) {
    if ($null -eq $Resource) { continue }
    try { $Resource.Dispose() } catch { $CleanupFailed = $true }
  }
  if ($CleanupFailed) { throw 'guard_cleanup_failed' }
}

function Exit-NapCatOfflineRecoveryGuard {
  param($Guard)
  if ($null -eq $Guard) { return }
  if ($Guard.threadId -ne [Threading.Thread]::CurrentThread.ManagedThreadId) { throw 'guard_wrong_thread' }
  $CleanupFailed = $false
  try { Close-NapCatOfflineResources -Resources $Guard.identityFiles.ToArray() } catch { $CleanupFailed = $true }
  $Guard.identityFiles.Clear()
  try { Release-NapCatOfflineLoginAttemptFile -Guard $Guard } catch { $CleanupFailed = $true }
  finally { $Guard.loginAttemptFile = $null }
  try {
    if ($Guard.ownsMutex) { $Guard.mutex.ReleaseMutex(); $Guard.ownsMutex = $false }
  } finally {
    $Files = $Guard.files.ToArray()
    [array]::Reverse($Files)
    try { Close-NapCatOfflineResources -Resources (@($Guard.mutex) + $Files) } catch { $CleanupFailed = $true }
    $Guard.mutex = $null
    $Guard.files.Clear()
    $Guard.acquired = $false
  }
  if ($CleanupFailed) { throw 'guard_cleanup_failed' }
}

function Enter-NapCatOfflineRecoveryGuard {
  param($Paths)
  $ErrorActionPreference = 'Stop'
  $SuppliedPaths = $Paths
  $Guard = [pscustomobject]@{
    acquired = $false; reason = ''; paths = $null; profile = $null; account = $null
    files = [Collections.Generic.List[IO.FileStream]]::new()
    identityFiles = [Collections.Generic.List[IO.FileStream]]::new()
    mutex = $null; ownsMutex = $false; loginAttemptFile = $null
    threadId = [Threading.Thread]::CurrentThread.ManagedThreadId
  }
  $Failure = 'invalid_paths'
  try {
    $Guard.paths = Get-NapCatOfflineRecoveryPaths -Paths $Paths
    $Paths = $Guard.paths
    $Failure = 'profile_unverified'
    $Guard.profile = Get-NapCatOfflineQqProfile -QqUserDataDir $Paths.qqUserDataDir
    $Failure = 'deployment_unverified'
    $DeploymentFile = [IO.File]::Open([IO.Path]::Combine($Paths.accountStateDir, 'deployment.json'), 'Open', 'Read', 'Read')
    $Guard.identityFiles.Add($DeploymentFile)
    $BindingFile = [IO.File]::Open($Paths.bindingPath, 'Open', 'Read', 'Read')
    $Guard.identityFiles.Add($BindingFile)
    $Deployment = ConvertFrom-NapCatOfflineJsonBytes (Read-NapCatOfflineFileStream -Stream $DeploymentFile -Limit 524288)
    $Binding = ConvertFrom-NapCatOfflineJsonBytes (Read-NapCatOfflineFileStream -Stream $BindingFile -Limit 65536)
    $Guard.account = Get-NapCatOfflineDeploymentAccount -Paths $Paths -Profile $Guard.profile -Deployment $Deployment -Binding $Binding
    foreach ($Lock in @(
      @{ dir = $Paths.accountStateDir; file = 'manual-recovery.lock'; reason = 'manual_lock_unavailable' }
      @{ dir = $Paths.accountStateDir; file = 'startup-recovery.lock'; reason = 'startup_lock_unavailable' }
      @{ dir = $Paths.accountStateDir; file = 'account-switch.lock'; reason = 'account_lock_unavailable' }
      @{ dir = $Paths.dataStateDir; file = 'napcat-bridge-update.lock'; reason = 'update_lock_unavailable' }
    )) {
      $Failure = $Lock.reason
      $Guard.files.Add([IO.File]::Open([IO.Path]::Combine($Lock.dir, $Lock.file), 'OpenOrCreate', 'ReadWrite', 'None'))
    }
    $Failure = 'profile_lock_unavailable'
    $Guard.mutex = [Threading.Mutex]::new($false, $Guard.profile.mutexName)
    try { $Guard.ownsMutex = $Guard.mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] {
      $Guard.ownsMutex = $true
      $Failure = 'profile_lock_abandoned'
      throw $Failure
    }
    if (-not $Guard.ownsMutex) { throw $Failure }
    $Failure = 'maintenance_unverified'
    if (Test-NapCatOfflineRecoveryInhibited -Paths $Paths) { $Failure = 'maintenance_active'; throw $Failure }
    $Failure = 'deployment_unverified'
    $DeploymentFile.Position = 0
    $BindingFile.Position = 0
    $Deployment = ConvertFrom-NapCatOfflineJsonBytes (Read-NapCatOfflineFileStream -Stream $DeploymentFile -Limit 524288)
    $Binding = ConvertFrom-NapCatOfflineJsonBytes (Read-NapCatOfflineFileStream -Stream $BindingFile -Limit 65536)
    $CurrentPaths = Get-NapCatOfflineRecoveryPaths -Paths $SuppliedPaths
    $CurrentProfile = Get-NapCatOfflineQqProfile -QqUserDataDir $CurrentPaths.qqUserDataDir
    if ($CurrentProfile.mutexName -cne $Guard.profile.mutexName -or $CurrentPaths.qqExePath -ine $Paths.qqExePath -or
        (Get-NapCatOfflineDeploymentAccount -Paths $CurrentPaths -Profile $CurrentProfile -Deployment $Deployment -Binding $Binding) -cne $Guard.account) {
      throw $Failure
    }
    $Failure = 'login_attempt_lock_unavailable'
    $Guard.loginAttemptFile = [IO.File]::Open([IO.Path]::Combine($Paths.dataStateDir, "napcat-login-attempt-$($Guard.account).lock"), 'OpenOrCreate', 'ReadWrite', 'None')
    $Guard.acquired = $true
    return $Guard
  } catch {
    try { Exit-NapCatOfflineRecoveryGuard -Guard $Guard } catch { $Failure = 'guard_cleanup_failed' }
    return [pscustomobject]@{ acquired = $false; reason = $Failure }
  }
}

function Get-NapCatOfflineRemainingMilliseconds {
  param([long]$DeadlineAt)
  return ($DeadlineAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
}

function Get-NapCatOfflineOneBotTarget {
  param($Guard)
  $Bytes = Get-NapCatOfflineFileBytes $Guard.paths.privateEnvPath 524288
  $PrivateEnvironment = ConvertFrom-NapCatOfflineJsonBytes $Bytes
  $Url = ([string]$PrivateEnvironment.NAPCAT_HTTP_URL).TrimEnd('/')
  $Token = [string]$PrivateEnvironment.NAPCAT_ACCESS_TOKEN
  if ($Url -cnotmatch '^https?://(127\.0\.0\.1|localhost)(:\d+)?$' -or [string]::IsNullOrWhiteSpace($Token)) {
    throw 'onebot_unverified'
  }
  return [pscustomobject]@{ url = $Url; port = ([Uri]$Url).Port; token = $Token; sha = Get-NapCatOfflineSha256 $Bytes }
}

function Get-NapCatOfflineListenerOwners {
  param([int]$Port)
  Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $_.LocalPort -eq $Port -and $_.LocalAddress -in @('127.0.0.1','::1','0.0.0.0','::') } |
    Select-Object -ExpandProperty OwningProcess -Unique
}

function Confirm-NapCatOfflineListener {
  param($Target, [string]$State, [object[]]$Owned, $ExpectedOwner)
  $Owners = @(Get-NapCatOfflineListenerOwners -Port $Target.port)
  if ($State -ceq 'offline' -and $Owners.Count -eq 1 -and
      [int]$Owners[0] -in @($Owned | ForEach-Object { [int]$_.ProcessId }) -and
      ($null -eq $ExpectedOwner -or $ExpectedOwner -eq [int]$Owners[0])) { return [int]$Owners[0] }
  if ($State -ceq 'connection_refused' -and $Owners.Count -eq 0 -and
      ($null -eq $ExpectedOwner -or $ExpectedOwner -eq 0)) { return 0 }
  throw 'onebot_owner_unverified'
}

function Get-NapCatOfflineOneBotState {
  param($Guard, [long]$DeadlineAt, $Target)
  $Response = $null
  $Body = $null
  try {
    if ($null -eq $Target) { $Target = Get-NapCatOfflineOneBotTarget -Guard $Guard }
    $Budget = [Math]::Min(3000, (Get-NapCatOfflineRemainingMilliseconds $DeadlineAt))
    if ($Budget -le 0) { return 'unknown' }
    $Request = [Net.WebRequest]::Create("$($Target.url)/get_status")
    $Request.Method = 'POST'
    $Request.AllowAutoRedirect = $false
    $Request.Proxy = $null
    $Request.KeepAlive = $false
    $Request.Timeout = [int]$Budget
    $Request.ReadWriteTimeout = [int]$Budget
    $Request.ContentType = 'application/json'
    $Request.Headers['Authorization'] = "Bearer $($Target.token)"
    $Request.ContentLength = 2
    $RequestBody = $Request.GetRequestStream()
    try { $RequestBody.Write([byte[]]@(123, 125), 0, 2) } finally { $RequestBody.Dispose() }
    $Response = $Request.GetResponse()
    if ([int]$Response.StatusCode -ne 200) { return 'unknown' }
    $Body = [IO.MemoryStream]::new()
    $Buffer = [byte[]]::new(4096)
    $Stream = $Response.GetResponseStream()
    do {
      if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) { return 'unknown' }
      $Count = $Stream.Read($Buffer, 0, $Buffer.Length)
      if ($Body.Length + $Count -gt 65536) { return 'unknown' }
      $Body.Write($Buffer, 0, $Count)
    } while ($Count -gt 0)
    $Status = ConvertFrom-NapCatOfflineJsonBytes ($Body.ToArray())
    if ($Status -isnot [pscustomobject] -or $Status.status -cne 'ok' -or
        ($null -ne $Status.retcode -and (($Status.retcode -isnot [int] -and $Status.retcode -isnot [long]) -or $Status.retcode -ne 0)) -or
        $Status.data -isnot [pscustomobject] -or $Status.data.online -isnot [bool]) { return 'unknown' }
    if ($Status.data.online) { return 'online' }
    return 'offline'
  } catch {
    $Failure = $_.Exception
    while ($null -ne $Failure) {
      if ($Failure -is [Net.WebException] -and $null -ne $Failure.Response) { $Failure.Response.Dispose() }
      if ($Failure -is [Net.Sockets.SocketException] -and $Failure.SocketErrorCode -eq [Net.Sockets.SocketError]::ConnectionRefused) { return 'connection_refused' }
      $Failure = $Failure.InnerException
    }
    return 'unknown'
  } finally { Close-NapCatOfflineResources -Resources @($Body, $Response) }
}

function Test-NapCatOfflineQuickLoginProof {
  param($Guard, $Proof, [switch]$RetainFiles)
  $Opened = [Collections.Generic.List[IO.FileStream]]::new()
  try {
    if (-not $Guard.acquired -or $Guard.threadId -ne [Threading.Thread]::CurrentThread.ManagedThreadId -or
        $Proof.fileSha256 -cnotmatch '^[0-9a-f]{64}$' -or $null -eq $Proof.sha256) { return $false }
    $Paths = $Guard.paths
    $Pinned = @{}
    $Startup = [IO.Path]::Combine($Paths.accountStateDir, 'startup-ps7.json')
    $StartupKind = 'ps7-plan'
    if (-not (Get-NapCatOfflinePathPresence $Startup)) {
      if ($null -eq $Paths.legacyStartupSha256) { return $false }
      $Startup = [IO.Path]::GetFullPath([IO.Path]::Combine($Paths.accountStateDir, '..', 'ops', 'start-local-napcat.ps1'))
      $StartupKind = 'registered-legacy-launcher'
    }
    if (([IO.File]::GetAttributes($Startup) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    foreach ($Target in @(
      @{ key = 'proof'; path = [IO.Path]::Combine($Paths.accountStateDir, 'native-quick-login-verified.json'); limit = 4096 }
      @{ key = 'deployment'; path = [IO.Path]::Combine($Paths.accountStateDir, 'deployment.json'); limit = 524288 }
      @{ key = 'startup'; path = $Startup; limit = 524288 }
      @{ key = 'binding'; path = $Paths.bindingPath; limit = 65536 }
      @{ key = 'login'; path = $Paths.loginScriptPath; limit = 524288 }
    )) {
      $Stream = [IO.File]::Open($Target.path, 'Open', 'Read', 'Read')
      $Opened.Add($Stream)
      $Pinned[$Target.key] = Read-NapCatOfflineFileStream -Stream $Stream -Limit $Target.limit
    }
    $Bytes = $Pinned.proof
    if ((Get-NapCatOfflineSha256 $Bytes) -cne $Proof.fileSha256) { return $false }
    $Evidence = ConvertFrom-NapCatOfflineJsonBytes $Bytes
    $EvidenceStartupKind = if ($null -eq $Evidence.startupKind) { 'ps7-plan' } else { $Evidence.startupKind }
    if ($EvidenceStartupKind -cne $StartupKind -or
        ($StartupKind -ceq 'registered-legacy-launcher' -and (Get-NapCatOfflineSha256 $Pinned.startup) -cne $Paths.legacyStartupSha256)) { return $false }
    $Now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($Evidence.schema -cne 'napcat.native-quick-login-verified/v1' -or $Evidence.mode -cne 'no-qr-no-password-fallback' -or
        $Evidence.result -cne 'verified-online-from-own-launch' -or $Evidence.provedAt -isnot [long] -or
        $Evidence.provedAt -gt $Now -or $Evidence.provedAt -lt ($Now - 604800000) -or
        $Evidence.qqProfileLayout -cnotin @('legacy_numeric', 'shared_root')) { return $false }
    $Deployment = $Pinned.deployment
    $DeploymentValue = ConvertFrom-NapCatOfflineJsonBytes $Deployment
    $Binding = ConvertFrom-NapCatOfflineJsonBytes $Pinned.binding
    $Layout = if ($null -eq $DeploymentValue.qqProfileLayout) { 'legacy_numeric' } else { $DeploymentValue.qqProfileLayout }
    if ($Layout -cne $Evidence.qqProfileLayout) { return $false }
    if (-not [IO.Directory]::Exists($Paths.qqUserDataDir) -or
        ($Layout -ceq 'legacy_numeric' -and -not [IO.Directory]::Exists([IO.Path]::Combine($Paths.qqUserDataDir, $Guard.account)))) { return $false }
    $CurrentProfile = Get-NapCatOfflineQqProfile -QqUserDataDir $Paths.qqUserDataDir
    if ($CurrentProfile.normalizedPath -cne $Guard.profile.normalizedPath -or
        (Get-NapCatOfflineDeploymentAccount -Paths $Paths -Profile $CurrentProfile -Deployment $DeploymentValue -Binding $Binding) -cne $Guard.account) { return $false }
    $Actual = @{
      deployment = Get-NapCatOfflineSha256 $Deployment
      startup = Get-NapCatOfflineSha256 $Pinned.startup
      binding = Get-NapCatOfflineSha256 $Pinned.binding
      login = Get-NapCatOfflineSha256 $Pinned.login
      profile = Get-NapCatOfflineSha256 ([Text.Encoding]::UTF8.GetBytes($CurrentProfile.normalizedPath))
    }
    foreach ($Key in $Actual.Keys) {
      if ($Actual[$Key] -cne $Proof.sha256.$Key -or $Actual[$Key] -cne $Evidence.sha256.$Key) { return $false }
    }
    if ($RetainFiles) { $Guard.identityFiles.AddRange($Opened); $Opened.Clear() }
    return $true
  } catch { return $false }
  finally { Close-NapCatOfflineResources -Resources $Opened.ToArray() }
}

function ConvertTo-NapCatOfflineProcessId {
  param($Value)
  if (($Value -is [int] -or $Value -is [long] -or $Value -is [uint32]) -and
      $Value -gt 0 -and $Value -le [int]::MaxValue) { return [int]$Value }
  return 0
}

function Get-NapCatOfflineExpectedProcessId {
  param($Record)
  if ($null -ne $Record.pid) { return ConvertTo-NapCatOfflineProcessId $Record.pid }
  return ConvertTo-NapCatOfflineProcessId $Record.ProcessId
}

function ConvertTo-NapCatOfflineIdentityJsonString {
  param([string]$Value)
  $Escaped = [regex]::Replace($Value, '[\x00-\x1f"\\]', [Text.RegularExpressions.MatchEvaluator]{
    param($Match)
    switch ([int][char]$Match.Value) {
      8 { '\b'; break }
      9 { '\t'; break }
      10 { '\n'; break }
      12 { '\f'; break }
      13 { '\r'; break }
      34 { '\"'; break }
      92 { '\\'; break }
      default { '\u{0:x4}' -f ([int][char]$Match.Value) }
    }
  })
  return '"' + $Escaped + '"'
}

function Get-NapCatOfflineProcessIdentityKey {
  param($Record)
  $Parent = ConvertTo-NapCatOfflineProcessId $Record.ParentProcessId
  $ParentJson = if ($Parent -gt 0) { $Parent.ToString([Globalization.CultureInfo]::InvariantCulture) } else { 'null' }
  $Json = '[{0},{1},{2},{3},{4},{5}]' -f ([int]$Record.ProcessId), $ParentJson,
    (ConvertTo-NapCatOfflineIdentityJsonString ([string]$Record.Name).ToLowerInvariant()),
    (ConvertTo-NapCatOfflineIdentityJsonString ([string]$Record.CommandLine)),
    (ConvertTo-NapCatOfflineIdentityJsonString ([string]$Record.CreationDate)),
    (ConvertTo-NapCatOfflineIdentityJsonString ([string]$Record.ExecutablePath).ToLowerInvariant())
  return Get-NapCatOfflineSha256 ([Text.Encoding]::UTF8.GetBytes($Json))
}

function Get-NapCatOfflineExactOwnedProcesses {
  param($Classification, $Root, [object[]]$Expected)
  $Owned = @($Classification.owned)
  if (@($Classification.unknown).Count -ne 0 -or $Owned.Count -eq 0 -or $Expected.Count -ne $Owned.Count) { throw 'process_identity_unverified' }
  $ExpectedById = @{}
  foreach ($Record in $Expected) {
    $ProcessId = Get-NapCatOfflineExpectedProcessId $Record
    if ($ProcessId -lt 2 -or $ProcessId -eq $PID -or $ExpectedById.ContainsKey($ProcessId)) { throw 'process_identity_unverified' }
    $ExpectedById[$ProcessId] = $Record
  }
  $ById = @{}
  foreach ($Record in $Owned) {
    $ProcessId = [int]$Record.ProcessId
    $Previous = $ExpectedById[$ProcessId]
    $Birth = Get-NapCatIdentityBirth $Record
    if ($null -eq $Previous -or $ById.ContainsKey($ProcessId) -or [double]::IsNaN($Birth) -or
        [string]::IsNullOrWhiteSpace([string]$Record.ExecutablePath)) { throw 'process_identity_unverified' }
    $PreviousBirth = Get-NapCatIdentityBirth $Previous
    if (($null -eq $Previous.CreationDate -and $null -eq $Previous.identityKey) -or
        ($null -ne $Previous.CreationDate -and $PreviousBirth -ne $Birth) -or
        ($null -ne $Previous.identityKey -and $Previous.identityKey -cne (Get-NapCatOfflineProcessIdentityKey $Record))) {
      throw 'process_identity_unverified'
    }
    $ById[$ProcessId] = $Record
  }
  $RootId = ConvertTo-NapCatOfflineProcessId $Root.pid
  $RootRecord = $ById[$RootId]
  if ($null -eq $RootRecord -or (Get-NapCatIdentityBirth $Root) -ne (Get-NapCatIdentityBirth $RootRecord)) { throw 'process_identity_unverified' }
  $Roots = @($Owned | Where-Object {
    $_.Name -match '^(qq|qqnt|qqex)(\.exe)?$' -and -not [string]::IsNullOrWhiteSpace([string]$_.CommandLine) -and
      $_.CommandLine -notmatch '(?:^|\s)--type(?:[=\s]|$)'
  })
  if ($Roots.Count -eq 0) {
    $Roots = @($Owned | Where-Object { -not (Test-NapCatIdentityLink $_ $ById[[int]$_.ParentProcessId]) })
  }
  if ($Roots.Count -ne 1 -or [int]$Roots[0].ProcessId -ne $RootId) { throw 'process_identity_unverified' }
  return @($RootRecord) + @($Owned | Where-Object { [int]$_.ProcessId -ne $RootId })
}

function Close-NapCatOfflineProcessHandles {
  param([object[]]$Handles)
  Close-NapCatOfflineResources -Resources @(foreach ($Record in $Handles) { $Record.process })
}

function Open-NapCatOfflineProcessHandles {
  param([object[]]$Processes)
  $Handles = [Collections.Generic.List[object]]::new()
  try {
    foreach ($Expected in $Processes) {
      $Process = [Diagnostics.Process]::GetProcessById([int]$Expected.ProcessId)
      try {
        $SafeHandle = $Process.SafeHandle
        $Started = $Process.StartTime
        if ($SafeHandle.IsInvalid -or $SafeHandle.IsClosed -or $Process.HasExited -or
            -not (Test-NapCatCreationTime $Started $Expected.CreationDate)) { throw 'process_identity_unverified' }
        $Handles.Add([pscustomobject]@{ process = $Process; handle = $SafeHandle; started = $Started })
      } catch {
        try { $Process.Dispose() } catch {}
        throw
      }
    }
    return $Handles.ToArray()
  } catch {
    try { Close-NapCatOfflineProcessHandles -Handles $Handles.ToArray() } catch {}
    throw
  }
}

function Initialize-NapCatOfflineStopApi {
  if ('NapCatOfflineRecoveryNative' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class NapCatOfflineRecoveryNative {
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateProcess(SafeProcessHandle process, uint exitCode);
}
'@
}

function Stop-NapCatOfflineRetainedProcesses {
  param([object[]]$Handles, [long]$DeadlineAt, [ref]$MutationAttempted)
  if ($Handles.Count -eq 0) { throw 'process_identity_unverified' }
  foreach ($Record in $Handles) {
    if ($Record.process.HasExited -or $Record.handle.IsInvalid -or $Record.handle.IsClosed -or
        -not [object]::ReferenceEquals($Record.handle, $Record.process.SafeHandle) -or
        $Record.process.StartTime -ne $Record.started) { throw 'process_identity_unverified' }
  }
  foreach ($Record in $Handles) {
    if ((Get-NapCatOfflineRemainingMilliseconds $DeadlineAt) -le 0) { throw 'deadline_expired' }
    if ($Record.process.HasExited) {
      if (-not $MutationAttempted.Value) { throw 'process_identity_unverified' }
      continue
    }
    $MutationAttempted.Value = $true
    if (-not [NapCatOfflineRecoveryNative]::TerminateProcess($Record.handle, 1) -and -not $Record.process.HasExited) {
      throw 'stop_unverified'
    }
  }
  $WaitUntil = [Math]::Min($DeadlineAt, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + 3000)
  foreach ($Record in $Handles) {
    $WaitMilliseconds = [int][Math]::Max(0, (Get-NapCatOfflineRemainingMilliseconds $WaitUntil))
    if (-not $Record.process.WaitForExit($WaitMilliseconds)) { throw 'stop_unverified' }
  }
}
