[CmdletBinding()]
param(
  [string]$OutputRoot = (Join-Path ([IO.Path]::GetTempPath()) ('napcat-recovery-tests-' + [Guid]::NewGuid().ToString('N'))),
  [string]$WindowsPowerShellPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
  [string]$PowerShell7Path = '',
  [switch]$IdentityFocused,
  [switch]$DiagnosticsFocused,
  [switch]$WindowsPowerShellOnly
)
$ErrorActionPreference = 'Stop'
$EntryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\ops\start-napcat-account-recovery.ps1'))
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw 'OutputRoot must be a new isolated directory.' }
if ([string]::IsNullOrWhiteSpace($PowerShell7Path)) {
  $Command = Get-Command pwsh.exe -ErrorAction SilentlyContinue
  if ($null -ne $Command) { $PowerShell7Path = $Command.Source }
}
$EnginePaths = if ($WindowsPowerShellOnly) { @($WindowsPowerShellPath) } else { @($WindowsPowerShellPath, $PowerShell7Path) }
foreach ($Engine in $EnginePaths) {
  if ([string]::IsNullOrWhiteSpace($Engine) -or -not (Test-Path -LiteralPath $Engine -PathType Leaf)) { throw 'Both Windows PowerShell 5.1 and PowerShell 7 are required; pass their existing executable paths.' }
}
$null = [IO.Directory]::CreateDirectory($OutputRoot)
$Checks = [Collections.Generic.List[object]]::new()
$Engines = [Collections.Generic.List[object]]::new()
$AccountId = '1234567890'
$LoginStub = @'
param($NapCatRoot, $QqExePath, $QqUserDataDir, $DataRoot, $BrokerRoot, $TimeoutSeconds, [switch]$NoQr, [switch]$NoPasswordFallback)
$ErrorActionPreference = 'Stop'
$Scenario = Get-Content -LiteralPath (Join-Path $DataRoot 'scenario.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$CallsPath = Join-Path $DataRoot 'calls.txt'
$Calls = if (Test-Path -LiteralPath $CallsPath) { [int]([IO.File]::ReadAllText($CallsPath)) + 1 } else { 1 }
[IO.File]::WriteAllText($CallsPath, [string]$Calls)
[IO.File]::AppendAllText((Join-Path $DataRoot 'order.txt'), "login`n")
$DirtyNames = @('NAPCAT_QUICK_PASSWORD_MD5','NAPCAT_QUICK_PASSWORD','NAPCAT_QUICK_ACCOUNT','NAPCAT_WEBUI_SECRET_KEY','NODE_OPTIONS','ELECTRON_RUN_AS_NODE')
$EnvironmentClean = @($DirtyNames | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }).Count -eq 0
$ArgumentsCorrect = $TimeoutSeconds -eq 120 -and $NoQr -and $NoPasswordFallback -and $EnvironmentClean -and $env:NAPCAT_WORKDIR -eq $NapCatRoot -and $QqExePath -eq (Join-Path $Scenario.root 'qq\synthetic.exe') -and $QqUserDataDir -eq (Join-Path $Scenario.root 'profile') -and $BrokerRoot -eq $Scenario.root
[IO.File]::WriteAllText((Join-Path $DataRoot 'arguments.json'), (@{correct=[bool]$ArgumentsCorrect;version=$PSVersionTable.PSVersion.ToString();pid=$PID} | ConvertTo-Json))
if ($Scenario.mode -eq 'gated') {
  [IO.File]::WriteAllText((Join-Path $DataRoot 'entered.txt'), 'entered')
  $Clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath (Join-Path $DataRoot 'release.txt'))) { if ($Clock.Elapsed.TotalSeconds -gt 25) { throw 'gate timeout' }; Start-Sleep -Milliseconds 50 }
}
if ($Scenario.mode -match '^manifest_(dataRoot|brokerRoot|napCatRoot|qqExePath|qqUserDataDir|criticalFiles)_drift$' -or $Scenario.mode -eq 'retry_manifest_drift') {
  $Field = if ($Scenario.mode -eq 'retry_manifest_drift') { 'dataRoot' } else { $Matches[1] }
  $ManifestPath = Join-Path $Scenario.root 'state\deployment.json'
  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Alternate = Join-Path $Scenario.root ('alternate-'+$Field)
  if ($Field -eq 'criticalFiles') {
    [IO.File]::WriteAllText($Alternate, 'alternate verified identity')
    $Manifest.criticalFiles += @{path=$Alternate;sha256=(Get-FileHash -LiteralPath $Alternate -Algorithm SHA256).Hash}
  } elseif ($Field -eq 'qqExePath') { [IO.File]::WriteAllText($Alternate, 'alternate synthetic QQ'); $Manifest.$Field=$Alternate }
  else {
    $null = [IO.Directory]::CreateDirectory($Alternate)
    if ($Field -eq 'dataRoot') { [IO.File]::WriteAllText((Join-Path $Alternate 'binding.json'), '{"expectedSelfId":"1234567890"}') }
    if ($Field -eq 'qqUserDataDir') { $null = [IO.Directory]::CreateDirectory((Join-Path $Alternate '1234567890')) }
    $Manifest.$Field=$Alternate
  }
  [IO.File]::WriteAllText($ManifestPath, ($Manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
if ($Scenario.mode -eq 'node_changed_during_login') { [IO.File]::AppendAllText($Scenario.node, 'changed owned copy') }
if ($Scenario.mode -in @('retry_success','retry_failure','stop_backoff','retry_manifest_drift')) {
    if ($Scenario.mode -ne 'retry_success' -or $Calls -eq 1) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = (Get-Process -Id $PID).Path; $Info.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "exit 23"'
    $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true
    $Child = [Diagnostics.Process]::Start($Info)
    $Child.WaitForExit()
    $Log = Join-Path $NapCatRoot ('logs\codex-login-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
    [IO.File]::WriteAllText($Log, 'TEST_SECRET_SENTINEL')
    [IO.File]::WriteAllText([IO.Path]::ChangeExtension($Log, 'error.log'), 'TEST_SECRET_SENTINEL')
    if ($Scenario.mode -eq 'stop_backoff') { [IO.File]::WriteAllText((Join-Path $Scenario.root 'state\startup.stop'), 'test-owned stop') }
    $Prefix = 'NapCat ' + (-join ([char[]]@(0x767b,0x5f55,0x8fdb,0x7a0b,0x63d0,0x524d,0x9000,0x51fa,0xff0c,0x65e5,0x5fd7,0xff1a)))
    $Failure = [InvalidOperationException]::new($Prefix + 'TEST_SECRET_SENTINEL')
    $Failure.Data['RootProcessId'] = $Child.Id; $Failure.Data['ChildExitCode'] = $Child.ExitCode
    $Child.Dispose()
    throw $Failure
  }
}
switch ($Scenario.mode) {
  'manual' { throw '[NAPCAT_MANUAL_LOGIN_REQUIRED] TEST_SECRET_SENTINEL' }
  'process_present' { throw '[NAPCAT_PROCESS_PRESENT] TEST_SECRET_SENTINEL' }
  'login_busy' { throw '[NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS] TEST_SECRET_SENTINEL' }
  'runtime_incomplete' { throw '[NAPCAT_RUNTIME_INCOMPLETE] TEST_SECRET_SENTINEL' }
  'permission' { throw [UnauthorizedAccessException]::new('TEST_SECRET_SENTINEL') }
  'security' { throw [Management.Automation.PSSecurityException]::new('TEST_SECRET_SENTINEL') }
  'win32_denied' { throw [ComponentModel.Win32Exception]::new(5) }
  'unknown' { throw 'TEST_SECRET_SENTINEL' }
  'bad_json' { 'TEST_SECRET_SENTINEL'; return }
  'timeout' {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = (Get-Process -Id $PID).Path; $Info.Arguments = '-NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 5"'
    $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true
    $Child = [Diagnostics.Process]::Start($Info)
    try { if (-not $Child.WaitForExit(100)) { $Child.Kill(); $Child.WaitForExit(); throw [TimeoutException]::new('TEST_SECRET_SENTINEL') } }
    finally { $Child.Dispose() }
  }
  'stop_after_login' { [IO.File]::WriteAllText((Join-Path $Scenario.root 'state\startup.stop'), 'test-owned stop') }
  'switch_after_login' { $global:TestSwitchLock = [IO.File]::Open((Join-Path $Scenario.root 'state\account-switch.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  'login_nonzero' { $global:LASTEXITCODE = 17 }
}
$State = if ($Scenario.mode -in @('already_online','online_existing')) { $Scenario.mode } elseif ($Scenario.mode -eq 'not_online') { 'TEST_SECRET_SENTINEL' } else { 'online' }
$UserId = if ($Scenario.mode -eq 'wrong_account') { '9876543210' } else { '1234567890' }
@{state=$State;userId=$UserId;launched=$false;processId=$PID;existingProcessIds=@($PID,'TEST_SECRET_SENTINEL');token='TEST_SECRET_SENTINEL';password='TEST_SECRET_SENTINEL'} | ConvertTo-Json
'@
$RouterStub = @'
param($DataRoot, $BrokerRoot)
$Scenario = Get-Content -LiteralPath (Join-Path $DataRoot 'scenario.json') -Raw -Encoding UTF8 | ConvertFrom-Json
[IO.File]::AppendAllText((Join-Path $DataRoot 'order.txt'), "router`n")
if ($Scenario.mode -eq 'router_throw') { throw 'TEST_SECRET_SENTINEL' }
if ($Scenario.mode -eq 'router_nonzero') { $global:LASTEXITCODE = 31 }
$Started = $Scenario.mode -notin @('router_existing','router_not_ready')
if ($Scenario.mode -eq 'router_string_false') { $Started = 'false' }
if ($Scenario.mode -eq 'router_missing_started') { $Started = $null }
if ($Scenario.mode -eq 'router_numeric_started') { $Started = 1 }
$Reason = if ($Scenario.mode -eq 'router_existing') { 'already_running' } else { 'TEST_SECRET_SENTINEL' }
@{started=$Started;reason=$Reason;pid=$PID;token='TEST_SECRET_SENTINEL'} | ConvertTo-Json
'@

function Write-TestJson {
  param([string]$Path, $Value)
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}

function Assert-Test {
  param([string]$Name, [bool]$Passed, $Evidence)
  $Checks.Add([pscustomobject]@{name=$Name;passed=$Passed;evidence=$Evidence})
  Write-Output ($(if ($Passed) { 'PASS ' } else { 'FAIL ' }) + $Name)
}

function Test-HistoryPrefix {
  param([byte[]]$Before, [string]$Path)
  $After = [IO.File]::ReadAllBytes($Path)
  return $After.Length -ge $Before.Length -and [Convert]::ToBase64String($After, 0, $Before.Length) -eq [Convert]::ToBase64String($Before)
}

function New-TestFixture {
  param([string]$Name, [string]$Mode, [bool]$RouterEnabled = $false)
  $Root = Join-Path $OutputRoot $Name
  foreach ($Directory in @('state','data\state','code','napcat\logs','qq',('profile\'+$AccountId))) { $null = [IO.Directory]::CreateDirectory((Join-Path $Root $Directory)) }
  $Login = Join-Path $Root 'code\login.ps1'; $Router = Join-Path $Root 'code\router.ps1'; $Identity = Join-Path $Root 'qq\identity.txt'
  [IO.File]::WriteAllText($Login, $LoginStub, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($Router, $RouterStub, [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($Identity, 'synthetic deployment identity')
  $Manifest = [ordered]@{state='active';account=$AccountId;dataRoot=(Join-Path $Root 'data');brokerRoot=$Root;napCatRoot=(Join-Path $Root 'napcat');qqExePath=(Join-Path $Root 'qq\synthetic.exe');qqUserDataDir=(Join-Path $Root 'profile');criticalFiles=@(@{path=$Identity;sha256=(Get-FileHash -LiteralPath $Identity -Algorithm SHA256).Hash})}
  $Node = $Engine
  if ($Mode -in @('node_changed_during_login','node_path_mismatch')) { $Node=Join-Path $Root 'owned-node-copy.exe'; Copy-Item -LiteralPath $Engine -Destination $Node }
  if ($RouterEnabled -and $Mode -ne 'node_unbound') {
    $BoundNode = if ($Mode -eq 'node_path_mismatch') { $Engine } else { $Node }
    $Manifest.criticalFiles += @{path=$BoundNode;sha256=$(if ($Mode -eq 'node_wrong_hash') { '0'*64 } else { (Get-FileHash -LiteralPath $BoundNode -Algorithm SHA256).Hash })}
  }
  Write-TestJson (Join-Path $Root 'state\deployment.json') $Manifest
  Write-TestJson (Join-Path $Root 'data\binding.json') @{expectedSelfId=$AccountId}
  Write-TestJson (Join-Path $Root 'data\scenario.json') @{mode=$Mode;root=$Root;node=$Node}
  if (-not $RouterEnabled) { [IO.File]::WriteAllText((Join-Path $Root 'data\state\task-router.stop'), 'test-owned pause') }
  [IO.File]::WriteAllText((Join-Path $Root 'state\startup-history.jsonl'), ('{"event":"run_start","runId":"old_complete"}' + "`n" + '{"event":"run_end","runId":"old_complete"}' + "`n"), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $Root 'state\last-start.json'), '{"state":"sentinel"}')
  return [pscustomobject]@{root=$Root;login=$Login;router=$Router;node=$Node;manifest=$Manifest;loginHash=(Get-FileHash -LiteralPath $Login -Algorithm SHA256).Hash;routerHash=(Get-FileHash -LiteralPath $Router -Algorithm SHA256).Hash}
}

function Start-TestProcess {
  param([string]$Engine, $Fixture)
  $Arguments = @('-NoLogo','-NoProfile','-NonInteractive','-File',$EntryPath,'-AccountRoot',$Fixture.root,'-ExpectedAccountId',$AccountId,'-LoginScriptPath',$Fixture.login,'-LoginScriptSha256',$Fixture.loginHash,'-RouterScriptPath',$Fixture.router,'-RouterScriptSha256',$Fixture.routerHash,'-NodeExePath',$Fixture.node,'-TriggerSource','isolated_test')
  $Info = [Diagnostics.ProcessStartInfo]::new()
  $Info.FileName = $Engine; $Info.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
  $Info.UseShellExecute = $false; $Info.CreateNoWindow = $true; $Info.RedirectStandardOutput = $true; $Info.RedirectStandardError = $true
  $Info.EnvironmentVariables.Remove('PSModulePath')
  foreach ($Name in @('NAPCAT_QUICK_PASSWORD_MD5','NAPCAT_QUICK_PASSWORD','NAPCAT_QUICK_ACCOUNT','NAPCAT_WEBUI_SECRET_KEY','NODE_OPTIONS','ELECTRON_RUN_AS_NODE')) { $Info.EnvironmentVariables[$Name] = 'TEST_SECRET_SENTINEL' }
  return [Diagnostics.Process]::Start($Info)
}

function Complete-TestProcess {
  param($Process, [string]$Root, [string]$Name = 'wrapper')
  try {
    if (-not $Process.WaitForExit(45000)) { $Process.Kill(); $Process.WaitForExit(); throw 'Test wrapper exceeded the isolated harness deadline.' }
    $Stdout = $Process.StandardOutput.ReadToEnd(); $Stderr = $Process.StandardError.ReadToEnd()
    [IO.File]::WriteAllText((Join-Path $Root ($Name+'-stdout.txt')), $Stdout)
    [IO.File]::WriteAllText((Join-Path $Root ($Name+'-stderr.txt')), $Stderr)
    return [pscustomobject]@{exitCode=$Process.ExitCode;pid=$Process.Id;stdout=$Stdout;stderr=$Stderr}
  } finally { $Process.Dispose() }
}

$Cases = @(
  @{name='online';reason='verified_online';code=0;calls=1},
  @{name='already_online';reason='verified_online';code=0;calls=1},
  @{name='online_existing';reason='verified_online';code=0;calls=1},
  @{name='retry_success';reason='verified_online';code=0;calls=2},
  @{name='retry_failure';reason='login_process_exited';code=1;calls=2},
  @{name='manual';reason='manual_login_required';code=1;calls=1},
  @{name='process_present';reason='existing_process_not_ready';code=1;calls=1},
  @{name='login_busy';reason='concurrent_attempt';code=1;calls=1},
  @{name='runtime_incomplete';reason='identity_drift';code=1;calls=1},
  @{name='permission';reason='security_or_permission_denied';code=1;calls=1},
  @{name='security';reason='security_or_permission_denied';code=1;calls=1},
  @{name='win32_denied';reason='security_or_permission_denied';code=1;calls=1},
  @{name='timeout';reason='login_timeout';code=1;calls=1},
  @{name='login_nonzero';reason='login_nonzero_exit';code=1;calls=1},
  @{name='wrong_account';reason='account_mismatch';code=1;calls=1},
  @{name='not_online';reason='online_verification_failed';code=1;calls=1},
  @{name='unknown';reason='unclassified_failure';code=1;calls=1},
  @{name='bad_json';reason='unclassified_failure';code=1;calls=1},
  @{name='stop_after_login';reason='maintenance_stop';code=1;calls=1},
  @{name='switch_after_login';reason='maintenance_stop';code=1;calls=1},
  @{name='stop_backoff';reason='maintenance_stop';code=1;calls=1},
  @{name='router_started';reason='verified_online';code=0;calls=1;router=$true},
  @{name='router_existing';reason='verified_online';code=0;calls=1;router=$true},
  @{name='router_not_ready';reason='router_not_ready';code=1;calls=1;router=$true},
  @{name='router_nonzero';reason='router_not_ready';code=1;calls=1;router=$true},
  @{name='router_throw';reason='router_not_ready';code=1;calls=1;router=$true},
  @{name='router_string_false';reason='router_not_ready';code=1;calls=1;router=$true},
  @{name='router_missing_started';reason='router_not_ready';code=1;calls=1;router=$true},
  @{name='router_numeric_started';reason='router_not_ready';code=1;calls=1;router=$true},
  @{name='history_unterminated_partial';reason='verified_online';code=0;calls=1},
  @{name='history_unterminated_valid';reason='verified_online';code=0;calls=1},
  @{name='startup_stop';reason='maintenance_stop';code=1;calls=0},
  @{name='deployment_paused';reason='maintenance_stop';code=1;calls=0},
  @{name='manifest_account';reason='account_mismatch';code=1;calls=0},
  @{name='binding_account';reason='account_mismatch';code=1;calls=0},
  @{name='profile_missing';reason='profile_missing';code=1;calls=0},
  @{name='critical_hash';reason='identity_drift';code=1;calls=0},
  @{name='login_hash';reason='identity_drift';code=1;calls=0},
  @{name='router_hash';reason='identity_drift';code=1;calls=0},
  @{name='switch_locked';reason='maintenance_stop';code=1;calls=0},
  @{name='manifest_dataRoot_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='manifest_brokerRoot_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='manifest_napCatRoot_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='manifest_qqExePath_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='manifest_qqUserDataDir_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='manifest_criticalFiles_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='retry_manifest_drift';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true},
  @{name='node_unbound';reason='identity_drift';code=1;calls=0;router=$true;rejectBeforeRouter=$true},
  @{name='node_wrong_hash';reason='identity_drift';code=1;calls=0;router=$true;rejectBeforeRouter=$true},
  @{name='node_path_mismatch';reason='identity_drift';code=1;calls=0;router=$true;rejectBeforeRouter=$true},
  @{name='node_changed_during_login';reason='identity_drift';code=1;calls=1;router=$true;rejectBeforeRouter=$true}
)
if ($IdentityFocused) { $Cases=@($Cases | Where-Object { $_.rejectBeforeRouter -or $_.name -in @('online','already_online','online_existing','retry_success','router_started','router_existing','startup_stop','binding_account','critical_hash','switch_locked') }) }
if ($DiagnosticsFocused) { $Cases=@($Cases | Where-Object { $_.name -in @('online','wrong_account','router_started','router_existing','router_not_ready','router_nonzero','router_throw','router_string_false','router_missing_started','router_numeric_started','history_unterminated_partial','history_unterminated_valid') }) }
foreach ($Engine in $EnginePaths) {
  $VersionOutput = @(& $Engine -NoLogo -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion.ToString()')
  $Version = ($VersionOutput -join '').Trim()
  if ($LASTEXITCODE -ne 0) { $Version = 'unavailable' }
  $Label = if ($Engine -eq $WindowsPowerShellPath) { 'winps51' } else { 'ps7' }
  $VersionCorrect = if ($Label -eq 'winps51') { $Version -like '5.1.*' } else { $Version -like '7.*' }
  Assert-Test ($Label+'.required_version') $VersionCorrect $Version
  $Engines.Add([pscustomobject]@{label=$Label;path=$Engine;version=$Version})
  if (-not $VersionCorrect) { continue }
  foreach ($Case in $Cases) {
    $Fixture = New-TestFixture ($Label+'-'+$Case.name) $Case.name ([bool]$Case.router)
    $Lock = $null
    switch ($Case.name) {
      'startup_stop' { [IO.File]::WriteAllText((Join-Path $Fixture.root 'state\startup.stop'), 'test-owned stop') }
      'deployment_paused' { $Fixture.manifest.state='maintenance'; Write-TestJson (Join-Path $Fixture.root 'state\deployment.json') $Fixture.manifest }
      'manifest_account' { $Fixture.manifest.account='9876543210'; Write-TestJson (Join-Path $Fixture.root 'state\deployment.json') $Fixture.manifest }
      'binding_account' { Write-TestJson (Join-Path $Fixture.root 'data\binding.json') @{expectedSelfId='9876543210'} }
      'profile_missing' { $Fixture.manifest.qqUserDataDir=(Join-Path $Fixture.root 'missing-profile'); Write-TestJson (Join-Path $Fixture.root 'state\deployment.json') $Fixture.manifest }
      'critical_hash' { [IO.File]::WriteAllText((Join-Path $Fixture.root 'qq\identity.txt'), 'changed') }
      'login_hash' { $Fixture.loginHash='0'*64 }
      'router_hash' { $Fixture.routerHash='0'*64 }
      'switch_locked' { $Lock=[IO.File]::Open((Join-Path $Fixture.root 'state\account-switch.lock'), 'OpenOrCreate','ReadWrite','None') }
      'history_unterminated_partial' { [IO.File]::AppendAllText((Join-Path $Fixture.root 'state\startup-history.jsonl'), '{"event":"run_start","runId":"interrupted_partial"') }
      'history_unterminated_valid' { [IO.File]::AppendAllText((Join-Path $Fixture.root 'state\startup-history.jsonl'), '{"event":"run_start","runId":"interrupted_valid"}') }
    }
    $HistoryPath = Join-Path $Fixture.root 'state\startup-history.jsonl'
    $Before = [IO.File]::ReadAllBytes($HistoryPath)
    try { $Result = Complete-TestProcess (Start-TestProcess $Engine $Fixture) $Fixture.root }
    finally { if ($null -ne $Lock) { $Lock.Dispose() } }
    $Summary = Get-Content -LiteralPath (Join-Path $Fixture.root 'state\last-start.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $HistoryText = [IO.File]::ReadAllText($HistoryPath)
    $InvalidHistoryLines = 0
    $History = @(foreach ($Line in Get-Content -LiteralPath $HistoryPath -Encoding UTF8) { try { $Line | ConvertFrom-Json } catch { $InvalidHistoryLines++ } })
    $CallsPath = Join-Path $Fixture.root 'data\calls.txt'
    $Calls = if (Test-Path -LiteralPath $CallsPath) { [int]([IO.File]::ReadAllText($CallsPath)) } else { 0 }
    $Passed = $Result.exitCode -eq $Case.code -and $Summary.reason -eq $Case.reason -and $Calls -eq $Case.calls -and (Test-HistoryPrefix $Before $HistoryPath) -and @($History | Where-Object { $_.runId -eq $Summary.runId -and $_.event -eq 'run_end' }).Count -eq 1
    $SafeText = $HistoryText + ($Summary | ConvertTo-Json -Depth 8) + $Result.stdout + $Result.stderr
    $Passed = $Passed -and $SafeText -notmatch 'TEST_SECRET_SENTINEL'
    if ($Calls -gt 0) { $Arguments = Get-Content -LiteralPath (Join-Path $Fixture.root 'data\arguments.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $Passed = $Passed -and $Arguments.correct -and $Arguments.pid -eq $Result.pid -and $Arguments.version -eq $Version }
    $OrderPath = Join-Path $Fixture.root 'data\order.txt'
    $Order = if (Test-Path -LiteralPath $OrderPath) { [IO.File]::ReadAllText($OrderPath) } else { '' }
    if ($Case.rejectBeforeRouter) { $Passed=$Passed -and $Order -notmatch 'router' }
    elseif ($Case.router) { $Passed = $Passed -and $Order -eq "login`nrouter`n" } else { $Passed = $Passed -and $Order -notmatch 'router' }
    if ($Case.name -in @('retry_success','retry_failure')) {
      $Ends = @($History | Where-Object { $_.runId -eq $Summary.runId -and $_.event -eq 'attempt_end' })
      $NextStart = @($History | Where-Object { $_.runId -eq $Summary.runId -and $_.event -eq 'attempt_start' -and $_.attempt -eq 2 })[0]
      $Delay = ([DateTimeOffset]::Parse($NextStart.timestamp) - [DateTimeOffset]::Parse($Ends[0].timestamp)).TotalSeconds
      $Passed = $Passed -and $Ends[0].reason -eq 'login_process_exited' -and $Ends[0].failure.childExitCode -eq 23 -and $Ends[0].failure.childPid -gt 0 -and $Ends[0].failure.errorLogExists -and $Delay -ge 10 -and $Delay -lt 20
    }
    $ExpectedInvalidHistoryLines = if ($Case.name -eq 'history_unterminated_partial') { 1 } else { 0 }
    $Passed = $Passed -and $InvalidHistoryLines -eq $ExpectedInvalidHistoryLines -and @($History | Where-Object { $_.runId -eq $Summary.runId -and $_.event -eq 'run_start' }).Count -eq 1
    if ($Case.name -like 'history_unterminated_*') { $Passed = $Passed -and @($History | Where-Object { $_.event -eq 'history_tail_interrupted' }).Count -eq 1 }
    if ($Case.name -eq 'wrong_account') { $Passed = $Passed -and $null -eq $Summary.result -and $Summary.ok -eq $false }
    if ($Case.router -and $Case.code -eq 1 -and -not $Case.rejectBeforeRouter) { $Passed = $Passed -and $Summary.result.state -eq 'online' -and $Summary.router.ready -eq $false -and $Summary.router.reason -eq 'router_not_ready' }
    Assert-Test ($Label+'.'+$Case.name) $Passed @{exitCode=$Result.exitCode;reason=$Summary.reason;calls=$Calls;wrapperPid=$Result.pid;fixture=$Fixture.root;invalidHistoryLines=$InvalidHistoryLines}
  }
  if ($IdentityFocused -or $DiagnosticsFocused) { continue }
  $Fixture = New-TestFixture ($Label+'-history') 'manual'
  [IO.File]::AppendAllText((Join-Path $Fixture.root 'state\startup-history.jsonl'), ('{"event":"run_start","runId":"synthetic_unfinished","timestamp":"2026-01-01T00:00:00Z"}' + "`n"))
  $First = Complete-TestProcess (Start-TestProcess $Engine $Fixture) $Fixture.root 'first'
  $Before = [IO.File]::ReadAllBytes((Join-Path $Fixture.root 'state\startup-history.jsonl'))
  Write-TestJson (Join-Path $Fixture.root 'data\scenario.json') @{mode='online';root=$Fixture.root}
  $Second = Complete-TestProcess (Start-TestProcess $Engine $Fixture) $Fixture.root 'second'
  $HistoryText = [IO.File]::ReadAllText((Join-Path $Fixture.root 'state\startup-history.jsonl'))
  $History = @(Get-Content -LiteralPath (Join-Path $Fixture.root 'state\startup-history.jsonl') -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
  Assert-Test ($Label+'.failure_history_preserved') ($First.exitCode -eq 1 -and $Second.exitCode -eq 0 -and (Test-HistoryPrefix $Before (Join-Path $Fixture.root 'state\startup-history.jsonl')) -and @($History | Where-Object { $_.event -eq 'run_interrupted' -and $_.interruptedRunId -eq 'synthetic_unfinished' }).Count -eq 1 -and $HistoryText -match 'manual_login_required' -and $HistoryText -notmatch 'TEST_SECRET_SENTINEL') @{fixture=$Fixture.root}
  $Fixture = New-TestFixture ($Label+'-concurrency') 'gated'
  $Owner = Start-TestProcess $Engine $Fixture
  $OwnerResult = $null; $RejectedResult = $null
  try {
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath (Join-Path $Fixture.root 'data\entered.txt'))) { if ($Owner.HasExited -or $Clock.Elapsed.TotalSeconds -gt 20) { throw 'Owner did not reach the isolated login gate.' }; Start-Sleep -Milliseconds 50 }
    $HistoryHash = (Get-FileHash -LiteralPath (Join-Path $Fixture.root 'state\startup-history.jsonl') -Algorithm SHA256).Hash
    $SummaryHash = (Get-FileHash -LiteralPath (Join-Path $Fixture.root 'state\last-start.json') -Algorithm SHA256).Hash
    $RejectedResult = Complete-TestProcess (Start-TestProcess $Engine $Fixture) $Fixture.root 'rejected'
    $Rejected = $RejectedResult.stdout | ConvertFrom-Json
    $Unchanged = -not $Owner.HasExited -and $HistoryHash -eq (Get-FileHash -LiteralPath (Join-Path $Fixture.root 'state\startup-history.jsonl') -Algorithm SHA256).Hash -and $SummaryHash -eq (Get-FileHash -LiteralPath (Join-Path $Fixture.root 'state\last-start.json') -Algorithm SHA256).Hash
  } finally {
    [IO.File]::WriteAllText((Join-Path $Fixture.root 'data\release.txt'), 'release only this test fixture')
    $OwnerResult = Complete-TestProcess $Owner $Fixture.root 'owner'
  }
  $Summary = Get-Content -LiteralPath (Join-Path $Fixture.root 'state\last-start.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $History = @(Get-Content -LiteralPath (Join-Path $Fixture.root 'state\startup-history.jsonl') -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
  $Calls = [int]([IO.File]::ReadAllText((Join-Path $Fixture.root 'data\calls.txt')))
  Assert-Test ($Label+'.concurrent_shared_bytes_unchanged') ($Unchanged -and $RejectedResult.exitCode -eq 1 -and $Rejected.state -eq 'concurrent' -and $Rejected.reason -eq 'concurrent_attempt') @{ownerPid=$OwnerResult.pid;rejectedPid=$RejectedResult.pid;fixture=$Fixture.root}
  Assert-Test ($Label+'.concurrent_single_login_owner_summary') ($OwnerResult.exitCode -eq 0 -and $Calls -eq 1 -and $Summary.ok -and $Summary.runId -ne $Rejected.runId -and @($History | Where-Object event -eq 'run_interrupted').Count -eq 0) @{calls=$Calls;fixture=$Fixture.root}
}
$Failures = @($Checks.ToArray() | Where-Object { -not $_.passed }).Count
$Report = [ordered]@{checkedAt=[DateTimeOffset]::Now.ToString('o');identityFocused=[bool]$IdentityFocused;windowsPowerShellOnly=[bool]$WindowsPowerShellOnly;entrySha256=(Get-FileHash -LiteralPath $EntryPath -Algorithm SHA256).Hash;testSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash;engines=$Engines.ToArray();passed=$Checks.Count-$Failures;failed=$Failures;checks=$Checks.ToArray()}
Write-TestJson (Join-Path $OutputRoot 'results.json') $Report
Write-Output ('STARTUP_RECOVERY passed='+$Report.passed+' failed='+$Failures+' result='+(Join-Path $OutputRoot 'results.json'))
if ($Failures -gt 0) { exit 1 }
exit 0
