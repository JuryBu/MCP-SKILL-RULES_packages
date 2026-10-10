[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$AccountRoot,
  [Parameter(Mandatory = $true)][ValidatePattern('^\d+$')][string]$ExpectedAccountId,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$LoginScriptPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$LoginScriptSha256,
  [Parameter(Mandatory = $true)][ValidateNotNullOrEmpty()][string]$RouterScriptPath,
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$RouterScriptSha256,
  [string]$NodeExePath = '',
  [ValidateSet('logon', 'resume', 'manual', 'isolated_test')][string]$TriggerSource = 'logon'
)
$ErrorActionPreference = 'Stop'
$ManifestPath = Join-Path $AccountRoot 'state\deployment.json'
$RunLog = Join-Path $AccountRoot 'state\last-start.json'
$HistoryPath = Join-Path $AccountRoot 'state\startup-history.jsonl'
$StopPath = Join-Path $AccountRoot 'state\startup.stop'
$SwitchPath = Join-Path $AccountRoot 'state\account-switch.lock'
$RunId = [Guid]::NewGuid().ToString('N')
$StartedAt = [DateTimeOffset]::Now.ToString('o')
$Attempt = 0
$Phase = 'preflight'
$RootProcessId = $null
$RunLock = $null
$OwnsRunLock = $false
$Deployment = $null
$DeploymentIdentity = $null
$RunClock = [Diagnostics.Stopwatch]::StartNew()
$ExitCode = 1
$Output = $null
$FailureEvidence = $null
$Result = $null
$Router = $null
$AttemptStartedAt = [DateTimeOffset]::Now

function Get-PositiveProcessId {
  param($Value)
  $Parsed = 0
  if ([int]::TryParse([string]$Value, [ref]$Parsed) -and $Parsed -gt 0) { return $Parsed }
  return $null
}

function Write-StartupEvent {
  param([string]$Event, [string]$Reason, [bool]$Retryable = $false, $Result = $null)
  $Entry = [ordered]@{
    timestamp = [DateTimeOffset]::Now.ToString('o'); runId = $RunId
    startedAt = $StartedAt; event = $Event; triggerSource = $TriggerSource
    wrapperPid = $PID; attempt = $Attempt; phase = $Phase
    reason = $Reason; retryable = $Retryable; rootPid = $RootProcessId
  }
  if ($Event -eq 'run_end') { $Entry.exitCode = $ExitCode; $Entry.ok = [bool]$Output.ok }
  if ($null -ne $FailureEvidence) { $Entry.failure = $FailureEvidence }
  if ($null -ne $Result -and $Result.state -in @('online', 'already_online', 'online_existing')) {
    $Entry.state = [string]$Result.state
    $Entry.launched = [bool]$Result.launched
    $Entry.existingProcessIds = @($Result.existingProcessIds | ForEach-Object { Get-PositiveProcessId $_ } | Where-Object { $null -ne $_ })
  }
  try { [IO.File]::AppendAllText($HistoryPath, (($Entry | ConvertTo-Json -Depth 5 -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false)) }
  catch { throw '[STARTUP_HISTORY_WRITE_FAILED]' }
}

function Get-SafeStartupFailureEvidence {
  param([Management.Automation.ErrorRecord]$Record)
  $Exception = $Record.Exception
  $Type = $Exception.GetType().FullName
  if ($Type -notmatch '^(System|Microsoft\.PowerShell)\.[A-Za-z0-9.]+$') { $Type = 'custom_exception_type_redacted' }
  $ErrorId = [string]$Record.FullyQualifiedErrorId
  if ($ErrorId -notmatch '^(System\.(UnauthorizedAccessException|Security\.SecurityException|Management\.Automation\.(RuntimeException|PSSecurityException))|AuthorizationManagerCheckFailed|PermissionDenied|UnauthorizedAccess)$') { $ErrorId = 'untrusted_error_identifier_redacted' }
  $ScriptName = 'untrusted_script_name_redacted'
  $SourcePath = [string]$Record.InvocationInfo.ScriptName
  if ($SourcePath -eq $PSCommandPath) { $ScriptName = 'start-napcat-account-recovery.ps1' }
  elseif ($SourcePath -eq $LoginScriptPath) { $ScriptName = 'login_entry' }
  elseif ($SourcePath -eq $RouterScriptPath) { $ScriptName = 'router_entry' }
  $Marker = 'unclassified'
  if ($Record.Exception.Message -match '\[(NAPCAT_MANUAL_LOGIN_REQUIRED|NAPCAT_PROCESS_PRESENT|NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS|NAPCAT_RUNTIME_INCOMPLETE|STARTUP_MAINTENANCE_STOP|STARTUP_IDENTITY_DRIFT|STARTUP_ACCOUNT_MISMATCH|STARTUP_HISTORY_WRITE_FAILED|STARTUP_LOGIN_NONZERO|STARTUP_ROUTER_NONZERO)\]') { $Marker = $Matches[1] }
  $Evidence = [ordered]@{
    exceptionType = $Type; errorId = $ErrorId; errorMarker = $Marker; errorCategory = [string]$Record.CategoryInfo.Category
    scriptName = $ScriptName; scriptLine = $Record.InvocationInfo.ScriptLineNumber
    loginLogPath = $null; errorLogPath = $null; errorLogExists = $false; logUnavailableReason = 'no_current_attempt_log_found'
    childPid = $RootProcessId; childExitCode = $null; nativeErrorCode = $null
    pidUnavailableReason = 'login_entry_did_not_return_pid'; exitCodeUnavailableReason = 'login_entry_did_not_return_child_exit_code'
  }
  while ($null -ne $Exception) {
    if ($Exception -is [ComponentModel.Win32Exception]) { $Evidence.nativeErrorCode = $Exception.NativeErrorCode }
    $Parsed = 0
    if ([int]::TryParse([string]$Exception.Data['RootProcessId'], [ref]$Parsed) -and $Parsed -gt 0) { $Evidence.childPid = $Parsed }
    if ([int]::TryParse([string]$Exception.Data['ChildExitCode'], [ref]$Parsed)) { $Evidence.childExitCode = $Parsed; $Evidence.exitCodeUnavailableReason = $null }
    $Exception = $Exception.InnerException
  }
  if ($null -ne $Evidence.childPid) { $Evidence.pidUnavailableReason = $null }
  if ($null -ne $Deployment -and $Phase -in @('login', 'verify', 'router')) {
    try {
      $LogDirectory = Join-Path $Deployment.napCatRoot 'logs'
      if (Test-Path -LiteralPath $LogDirectory -PathType Container) {
        $Log = Get-ChildItem -LiteralPath $LogDirectory -File -Filter 'codex-login-*.log' | Where-Object { $_.Name -match '^codex-login-\d{8}-\d{6}\.log$' -and $_.CreationTimeUtc -ge $AttemptStartedAt.UtcDateTime.AddSeconds(-1) } | Sort-Object CreationTimeUtc -Descending | Select-Object -First 1
        if ($null -ne $Log) { $Evidence.loginLogPath = $Log.FullName; $Evidence.errorLogPath = [IO.Path]::ChangeExtension($Log.FullName, 'error.log'); $Evidence.errorLogExists = Test-Path -LiteralPath $Evidence.errorLogPath -PathType Leaf; $Evidence.logUnavailableReason = $null }
      }
    } catch { $Evidence.logUnavailableReason = 'log_lookup_failed' }
  }
  return $Evidence
}

function Repair-StartupHistoryBoundary {
  if (-not (Test-Path -LiteralPath $HistoryPath)) { return }
  $History = [IO.File]::Open($HistoryPath, 'Open', 'Read', 'Read')
  try {
    if ($History.Length -eq 0) { return }
    $null = $History.Seek(-1, [IO.SeekOrigin]::End)
    $Terminated = $History.ReadByte() -in @(10, 13)
  } finally { $History.Dispose() }
  if (-not $Terminated) {
    [IO.File]::AppendAllText($HistoryPath, [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    Write-StartupEvent -Event 'history_tail_interrupted' -Reason 'previous_line_missing_terminator'
  }
}

function Record-UnfinishedStartupRuns {
  $Pending = @{}
  foreach ($Line in [IO.File]::ReadLines($HistoryPath)) {
    try {
      $Previous = $Line | ConvertFrom-Json
      if ($Previous.event -eq 'run_start' -and $Previous.runId -ne $RunId) { $Pending[[string]$Previous.runId] = $Previous.timestamp }
      if ($Previous.event -eq 'run_end') { $Pending.Remove([string]$Previous.runId) }
      if ($Previous.event -eq 'run_interrupted') { $Pending.Remove([string]$Previous.interruptedRunId) }
    } catch { }
  }
  foreach ($PreviousId in @($Pending.Keys)) {
    $Entry = [ordered]@{ timestamp = [DateTimeOffset]::Now.ToString('o'); runId = $RunId; event = 'run_interrupted'; reason = 'previous_run_missing_end'; interruptedRunId = $PreviousId; previousStartedAt = $Pending[$PreviousId]; wrapperPid = $PID }
    [IO.File]::AppendAllText($HistoryPath, (($Entry | ConvertTo-Json -Compress) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  }
}

function Get-StartupDeploymentIdentity {
  param($Current)
  $Identity = [ordered]@{ account = [string]$Current.account }
  foreach ($Name in @('dataRoot', 'brokerRoot', 'napCatRoot', 'qqExePath', 'qqUserDataDir')) {
    $Identity[$Name] = [IO.Path]::GetFullPath([string]$Current.$Name).ToUpperInvariant()
  }
  $Identity.criticalFiles = @($Current.criticalFiles | ForEach-Object {
    [pscustomobject]@{ path = [IO.Path]::GetFullPath([string]$_.path).ToUpperInvariant(); sha256 = ([string]$_.sha256).ToUpperInvariant() }
  } | Sort-Object -Property path, sha256)
  return ($Identity | ConvertTo-Json -Depth 6 -Compress)
}

function Assert-StartupNodeIdentity {
  param($Current)
  if ([string]::IsNullOrWhiteSpace($NodeExePath) -or -not [IO.Path]::IsPathRooted($NodeExePath) -or -not (Test-Path -LiteralPath $NodeExePath -PathType Leaf)) { throw '[STARTUP_IDENTITY_DRIFT]' }
  $NodePath = [IO.Path]::GetFullPath($NodeExePath)
  $NodeFiles = @($Current.criticalFiles | Where-Object { [IO.Path]::GetFullPath([string]$_.path) -ieq $NodePath })
  if ($NodeFiles.Count -ne 1 -or (Get-FileHash -LiteralPath $NodePath -Algorithm SHA256).Hash -ne $NodeFiles[0].sha256) { throw '[STARTUP_IDENTITY_DRIFT]' }
}

function Assert-StartupAllowed {
  if (Test-Path -LiteralPath $StopPath) { throw '[STARTUP_MAINTENANCE_STOP]' }
  $Current = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Current.state -ne 'active') { throw '[STARTUP_MAINTENANCE_STOP]' }
  if ($null -ne $DeploymentIdentity) {
    try { $CurrentIdentity = Get-StartupDeploymentIdentity $Current }
    catch { throw '[STARTUP_IDENTITY_DRIFT]' }
    if ($CurrentIdentity -cne $DeploymentIdentity) { throw '[STARTUP_IDENTITY_DRIFT]' }
  }
  $SwitchProbe = $null
  if (Test-Path -LiteralPath $SwitchPath) {
    try { $SwitchProbe = [IO.File]::Open($SwitchPath, 'Open', 'Read', 'None') }
    catch { throw '[STARTUP_MAINTENANCE_STOP]' }
    finally { if ($null -ne $SwitchProbe) { $SwitchProbe.Dispose() } }
  }
  return $Current
}

function Assert-StartupPreflight {
  $Current = Assert-StartupAllowed
  if ([string]$Current.account -ne $ExpectedAccountId) { throw '[STARTUP_ACCOUNT_MISMATCH]' }
  foreach ($Value in @($Current.dataRoot, $Current.brokerRoot, $Current.napCatRoot, $Current.qqExePath, $Current.qqUserDataDir, $LoginScriptPath, $RouterScriptPath)) {
    if ([string]::IsNullOrWhiteSpace([string]$Value) -or -not [IO.Path]::IsPathRooted([string]$Value)) { throw '[STARTUP_IDENTITY_DRIFT]' }
  }
  $Binding = Get-Content -LiteralPath (Join-Path $Current.dataRoot 'binding.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$Binding.expectedSelfId -ne $ExpectedAccountId) { throw '[STARTUP_ACCOUNT_MISMATCH]' }
  if (-not (Test-Path -LiteralPath (Join-Path $Current.qqUserDataDir $ExpectedAccountId) -PathType Container)) { throw '[STARTUP_PROFILE_MISSING]' }
  if (@($Current.criticalFiles).Count -eq 0) { throw '[STARTUP_IDENTITY_DRIFT]' }
  foreach ($File in $Current.criticalFiles) {
    if (-not [IO.Path]::IsPathRooted([string]$File.path) -or [string]$File.sha256 -notmatch '^[A-Fa-f0-9]{64}$' -or (Get-FileHash -LiteralPath $File.path -Algorithm SHA256).Hash -ne $File.sha256) { throw '[STARTUP_IDENTITY_DRIFT]' }
  }
  if ((Get-FileHash -LiteralPath $LoginScriptPath -Algorithm SHA256).Hash -ne $LoginScriptSha256 -or (Get-FileHash -LiteralPath $RouterScriptPath -Algorithm SHA256).Hash -ne $RouterScriptSha256) { throw '[STARTUP_IDENTITY_DRIFT]' }
  if (-not (Test-Path -LiteralPath (Join-Path $Current.dataRoot 'state\task-router.stop'))) { Assert-StartupNodeIdentity $Current }
  return $Current
}

function Get-StartupFailure {
  param([Management.Automation.ErrorRecord]$Record)
  $Message = $Record.Exception.Message
  if ($Message -match '\[STARTUP_MAINTENANCE_STOP\]') { return 'maintenance_stop' }
  if ($Message -match '\[STARTUP_CONCURRENT_RUN\]|\[NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS\]') { return 'concurrent_attempt' }
  if ($Message -match '\[NAPCAT_MANUAL_LOGIN_REQUIRED\]') { return 'manual_login_required' }
  if ($Message -match '\[NAPCAT_PROCESS_PRESENT\]') { return 'existing_process_not_ready' }
  if ($Message -match '\[STARTUP_ACCOUNT_MISMATCH\]|^NapCat \u767b\u5f55\u4e86\u9519\u8bef') { return 'account_mismatch' }
  if ($Message -match '\[STARTUP_IDENTITY_DRIFT\]|\[NAPCAT_RUNTIME_INCOMPLETE\]') { return 'identity_drift' }
  if ($Message -match '\[STARTUP_HISTORY_WRITE_FAILED\]') { return 'history_write_failed' }
  if ($Message -match '\[STARTUP_PROFILE_MISSING\]') { return 'profile_missing' }
  $Exception = $Record.Exception
  while ($null -ne $Exception) {
    if ($Exception -is [UnauthorizedAccessException] -or $Exception -is [Security.SecurityException] -or $Exception -is [Management.Automation.PSSecurityException]) { return 'security_or_permission_denied' }
    if ($Exception -is [ComponentModel.Win32Exception] -and $Exception.NativeErrorCode -in @(5, 225, 226, 577, 740, 1260)) { return 'security_or_permission_denied' }
    if ($Exception -is [TimeoutException]) { return 'login_timeout' }
    $Exception = $Exception.InnerException
  }
  if ($Record.FullyQualifiedErrorId -match 'Authorization|Permission|Security|Unauthorized') { return 'security_or_permission_denied' }
  if ($Phase -eq 'login' -and $Message -match '^NapCat \u767b\u5f55\u8fdb\u7a0b\u63d0\u524d\u9000\u51fa\uff0c\u65e5\u5fd7\uff1a') { return 'login_process_exited' }
  if ($Message -match '\[STARTUP_LOGIN_NONZERO\]') { return 'login_nonzero_exit' }
  if ($Message -match '\[STARTUP_NOT_ONLINE\]') { return 'online_verification_failed' }
  if ($Message -match '\[STARTUP_TIME_BUDGET\]') { return 'time_budget_exhausted' }
  if ($Phase -eq 'router') { return 'router_not_ready' }
  return 'unclassified_failure'
}

try {
  if (-not [IO.Path]::IsPathRooted($AccountRoot)) { throw '[STARTUP_IDENTITY_DRIFT]' }
  try { $RunLock = [IO.File]::Open((Join-Path $AccountRoot 'state\startup-recovery.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch {
    $LockError = $_.Exception
    while ($null -ne $LockError) {
      if (($LockError.HResult -band 65535) -in @(32, 33)) { throw '[STARTUP_CONCURRENT_RUN]' }
      $LockError = $LockError.InnerException
    }
    throw
  }
  $OwnsRunLock = $true
  Repair-StartupHistoryBoundary
  Write-StartupEvent -Event 'run_start' -Reason 'started'
  Record-UnfinishedStartupRuns
  for ($Attempt = 1; $Attempt -le 2; $Attempt++) {
    $Phase = 'preflight'; $RootProcessId = $null; $FailureEvidence = $null; $Result = $null
    $AttemptStartedAt = [DateTimeOffset]::Now
    Write-StartupEvent -Event 'attempt_start' -Reason 'started'
    try {
      if ($RunClock.Elapsed.TotalSeconds -ge 150) { throw '[STARTUP_TIME_BUDGET]' }
      $Deployment = Assert-StartupPreflight
      if ($null -eq $DeploymentIdentity) { $DeploymentIdentity = Get-StartupDeploymentIdentity $Deployment }
      foreach ($Name in @('NAPCAT_QUICK_PASSWORD_MD5', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_ACCOUNT', 'NAPCAT_WEBUI_SECRET_KEY', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE')) { [Environment]::SetEnvironmentVariable($Name, $null, 'Process') }
      $env:NAPCAT_WORKDIR = $Deployment.napCatRoot
      $Phase = 'login'
      $global:LASTEXITCODE = 0
      $LoginText = & $LoginScriptPath -NapCatRoot $Deployment.napCatRoot -QqExePath $Deployment.qqExePath -QqUserDataDir $Deployment.qqUserDataDir -DataRoot $Deployment.dataRoot -BrokerRoot $Deployment.brokerRoot -TimeoutSeconds 120 -NoQr -NoPasswordFallback
      if ($LASTEXITCODE -ne 0) { throw '[STARTUP_LOGIN_NONZERO]' }
      $Result = $LoginText | ConvertFrom-Json
      $RootProcessId = Get-PositiveProcessId $Result.processId
      $Phase = 'verify'
      if ([string]$Result.userId -ne $ExpectedAccountId) { throw '[STARTUP_ACCOUNT_MISMATCH]' }
      if ($Result.state -notin @('online', 'already_online', 'online_existing')) { throw '[STARTUP_NOT_ONLINE]' }
      $Deployment = Assert-StartupPreflight
      $Router = [ordered]@{ ready = $false; started = $false; reason = 'paused'; pid = $null }
      $Phase = 'router'
      if (-not (Test-Path -LiteralPath (Join-Path $Deployment.dataRoot 'state\task-router.stop'))) {
        Assert-StartupNodeIdentity $Deployment
        $env:CODEX_TOOLKIT_NODE_EXE = $NodeExePath
        $global:LASTEXITCODE = 0
        $RouterText = & $RouterScriptPath -DataRoot $Deployment.dataRoot -BrokerRoot $Deployment.brokerRoot
        if ($LASTEXITCODE -ne 0) { throw '[STARTUP_ROUTER_NONZERO]' }
        $RouterResult = $RouterText | ConvertFrom-Json
        if ($RouterResult.started -isnot [bool]) { throw '[STARTUP_ROUTER_RESULT_INVALID]' }
        if (-not $RouterResult.started -and $RouterResult.reason -ne 'already_running') { throw '[STARTUP_ROUTER_NOT_READY]' }
        $Router = [ordered]@{ ready = $true; started = [bool]$RouterResult.started; reason = $(if ($RouterResult.started) { 'started' } else { 'already_running' }); pid = (Get-PositiveProcessId $RouterResult.pid) }
      }
      $Phase = 'complete'
      Write-StartupEvent -Event 'attempt_end' -Reason 'verified_online' -Result $Result
      $Output = [ordered]@{
        checkedAt = [DateTimeOffset]::Now.ToString('o'); ok = $true; account = $ExpectedAccountId
        runId = $RunId; attempts = $Attempt; reason = 'verified_online'; routerStarted = $Router.started; router = $Router
        result = [ordered]@{ state = [string]$Result.state; userId = $ExpectedAccountId; launched = [bool]$Result.launched; processId = $RootProcessId; existingProcessIds = @($Result.existingProcessIds | ForEach-Object { Get-PositiveProcessId $_ } | Where-Object { $null -ne $_ }) }
      }
      $ExitCode = 0
      break
    } catch {
      $Reason = Get-StartupFailure -Record $_
      $FailureEvidence = Get-SafeStartupFailureEvidence -Record $_
      if ($null -ne $FailureEvidence.childPid) { $RootProcessId = $FailureEvidence.childPid }
      $Retryable = $Reason -eq 'login_process_exited'
      Write-StartupEvent -Event 'attempt_end' -Reason $Reason -Retryable $Retryable -Result $Result
      if (-not $Retryable -or $Attempt -ge 2) { throw ('[STARTUP_FINAL] ' + $Reason) }
      $Phase = 'backoff'
      Write-StartupEvent -Event 'retry_wait' -Reason $Reason -Retryable $true
      $DelayClock = [Diagnostics.Stopwatch]::StartNew()
      do {
        $null = Assert-StartupAllowed
        if ($RunClock.Elapsed.TotalSeconds -ge 270) { throw '[STARTUP_TIME_BUDGET]' }
        Start-Sleep -Milliseconds 200
      } while ($DelayClock.Elapsed.TotalSeconds -lt 10)
    }
  }
} catch {
  $Reason = if ($_.Exception.Message -match '^\[STARTUP_FINAL\] (.+)$') { $Matches[1] } else { Get-StartupFailure -Record $_ }
  $Output = [ordered]@{ checkedAt = [DateTimeOffset]::Now.ToString('o'); ok = $false; account = $ExpectedAccountId; runId = $RunId; attempts = $Attempt; reason = $Reason; error = $Reason; routerStarted = $false }
  if ($null -ne $Result -and $Result.state -in @('online', 'already_online', 'online_existing') -and [string]$Result.userId -eq $ExpectedAccountId) {
    $Output.result = [ordered]@{ state = [string]$Result.state; userId = [string]$Result.userId; launched = [bool]$Result.launched; processId = $RootProcessId }
  }
  if ($null -ne $Router) {
    if ($Phase -eq 'router') { $Router.reason = $Reason }
    $Output.router = $Router
  }
  if ($null -eq $FailureEvidence -or $_.Exception.Message -notmatch '^\[STARTUP_FINAL\] ') { $FailureEvidence = Get-SafeStartupFailureEvidence -Record $_ }
  $Output.failure = $FailureEvidence
  if ($Reason -eq 'concurrent_attempt' -and -not $OwnsRunLock) { $Output.state = 'concurrent' }
} finally {
  if ($OwnsRunLock) {
    try {
      $Phase = 'complete'
      [IO.File]::WriteAllText($RunLog, ($Output | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    } catch {
      $ExitCode = 1; $Output.ok = $false; $Output.reason = 'summary_write_failed'; $Output.error = 'summary_write_failed'
      [Console]::Error.WriteLine('startup_summary_write_failed')
    }
    try { Write-StartupEvent -Event 'run_end' -Reason $Output.reason }
    catch {
      $ExitCode = 1; $Output.ok = $false; $Output.reason = 'history_write_failed'; $Output.error = 'history_write_failed'
      try { [IO.File]::WriteAllText($RunLog, ($Output | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false)) } catch { }
      [Console]::Error.WriteLine('startup_history_write_failed')
    }
  }
  if ($null -ne $RunLock) { $RunLock.Dispose() }
}
if ($ExitCode -eq 0) { $Output | ConvertTo-Json -Depth 8 }
elseif (-not $OwnsRunLock -and $Output.reason -eq 'concurrent_attempt') { $Output | ConvertTo-Json -Depth 8; [Console]::Error.WriteLine('concurrent_attempt') }
else { [Console]::Error.WriteLine([string]$Output.reason) }
exit $ExitCode
