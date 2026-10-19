[CmdletBinding()]
param([Parameter(Mandatory)][string]$ResultsDirectory)
. (Join-Path $PSScriptRoot 'FileSet.Common.ps1')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('napcat-fileset-shadow-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($testRoot)
[void][IO.Directory]::CreateDirectory($ResultsDirectory)
$results = New-Object 'System.Collections.Generic.List[object]'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Save-Bytes([string]$Path, [byte[]]$Bytes) {
  [void][IO.Directory]::CreateDirectory((Split-Path -Parent $Path))
  [IO.File]::WriteAllBytes($Path, $Bytes)
}

function New-Fixture([string]$Name) {
  $fixtureRoot = Join-Path $testRoot $Name
  $codeRoot = Join-Path $fixtureRoot 'target-code'
  $accountRoot = Join-Path $fixtureRoot 'target-account'
  $candidate = Join-Path $fixtureRoot 'candidate'
  foreach ($directory in @('ops','src')) { [void][IO.Directory]::CreateDirectory((Join-Path $codeRoot $directory)) }
  [void][IO.Directory]::CreateDirectory((Join-Path $accountRoot 'ops'))
  $oldBytes = [byte[]](0,255,239,187,191,13,10,128,65,66,0,254)
  $specifications = @(
    @{root='code';path='ops/start-napcat-login.ps1';exists=$true},
    @{root='code';path='ops/start-napcat-task-router.ps1';exists=$true},
    @{root='code';path='ops/napcat-process-identity.ps1';exists=$false},
    @{root='code';path='src/napcat-process-identity.mjs';exists=$false},
    @{root='code';path='src/supervisor-runner.mjs';exists=$true},
    @{root='code';path='ops/start-napcat-supervisor.ps1';exists=$true},
    @{root='account';path='ops/start-local-napcat.ps1';exists=$true},
    @{root='account';path='ops/start-napcat-account-recovery.ps1';exists=$true}
  )
  $rootMap = @{code=$codeRoot;account=$accountRoot}
  $baseline = @{}
  $files = @()
  foreach ($specification in $specifications) {
    $target = Join-Path $rootMap[$specification.root] $specification.path
    if ($specification.exists) {
      Save-Bytes $target ($oldBytes + [Text.Encoding]::UTF8.GetBytes($specification.path))
      $baseline[$target] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($target))
    } else { $baseline[$target] = $null }
    $source = $specification.root + '/' + $specification.path
    Save-Bytes (Join-Path $candidate $source) ([Text.Encoding]::UTF8.GetBytes('SHADOW FIXTURE ONLY ' + $source + "`r`n"))
    $files += @{root=$specification.root;path=$specification.path;source=$source;sha256=(Get-Digest (Join-Path $candidate $source));beforeSha256=(Get-Digest $target)}
  }
  foreach ($relative in @('state/binding.json','state/task-registry.json','state/dedupe.json','state/control-state.json','state/append.jsonl')) {
    $protected = Join-Path $accountRoot $relative
    Save-Bytes $protected ($oldBytes + [Text.Encoding]::UTF8.GetBytes($relative))
    $baseline[$protected] = [Convert]::ToBase64String([IO.File]::ReadAllBytes($protected))
  }
  $manifestPath = Join-Path $fixtureRoot 'shadow-manifest.json'
  $manifest = @{schemaVersion=1;status='frozen';candidateId='shadow-fixture-only';roots=$rootMap;files=$files}
  Write-JsonFile $manifestPath $manifest
  return @{root=$fixtureRoot;code=$codeRoot;account=$accountRoot;candidate=$candidate;baseline=$baseline;manifest=$manifestPath;manifestValue=$manifest;transaction=(Join-Path $fixtureRoot 'transaction');hash=(Get-Digest $manifestPath)}
}

function Apply-Fixture($Fixture, [int]$FaultAfter = 0, [switch]$LeaveFailure) {
  & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') -ManifestPath $Fixture.manifest -ExpectedManifestSha256 $Fixture.hash -CandidateRoot $Fixture.candidate -TransactionDirectory $Fixture.transaction -Mode Shadow -ShadowRoot $Fixture.root -FaultAfter $FaultAfter -LeaveFailureForShadowRestoreTest:$LeaveFailure
}

function Assert-Baseline($Fixture) {
  foreach ($target in $Fixture.baseline.Keys) {
    if ($null -eq $Fixture.baseline[$target]) { Assert-True (-not [IO.File]::Exists($target)) "New file survived restore: $target" }
    else { Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -ceq $Fixture.baseline[$target]) "Byte comparison failed: $target" }
  }
  Assert-True (@(Get-ChildItem -LiteralPath $Fixture.code,$Fixture.account -Recurse -File -Filter '.napcat-fileset-*.tmp').Count -eq 0) 'Staging file leaked'
}

function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
  $caught = $null
  try { & $Action | Out-Null } catch { $caught = $_.Exception.Message }
  Assert-True ($null -ne $caught -and $caught -match $Pattern) "Expected error $Pattern ; received $caught"
  return $caught
}

function Run-Case([string]$Name, [scriptblock]$Body) {
  $started = [DateTimeOffset]::UtcNow
  try {
    & $Body | Out-Null
    $results.Add([pscustomobject]@{name=$Name;status='passed';atUtc=$started.ToString('o')})
    Write-Output ('PASS ' + $Name)
  } catch {
    $results.Add([pscustomobject]@{name=$Name;status='failed';error=$_.Exception.Message;atUtc=$started.ToString('o')})
    Write-Output ('FAIL ' + $Name + ' ' + $_.Exception.Message)
  }
}

function New-LiveFixtureGate($Fixture, [int]$LifetimeSeconds = 300) {
  $owner = [Guid]::NewGuid().ToString('N')
  $markerPath = Join-Path $Fixture.root 'own-supervisor-maintenance.json'
  Write-JsonFile $markerPath @{schemaVersion=1;ownerId=$owner;manifestSha256=$Fixture.hash}
  $runtimePath = Join-Path $Fixture.root 'supervisor.runtime.json'
  Write-JsonFile $runtimePath @{schemaVersion=1;pid=2147483647;state='stopped'}
  $gate = @{schemaVersion=1;manifestSha256=$Fixture.hash;writerQuiescenceVerified=$true;protectedProcessesVerified=$true;expiresAtUtc=[DateTimeOffset]::UtcNow.AddSeconds($LifetimeSeconds).ToString('o');ownerId=$owner;ownMarkerPath=$markerPath;ownMarkerSha256=(Get-Digest $markerPath);supervisor=@{processId=2147483647;runtimeStatePath=$runtimePath;lockPath=(Join-Path $Fixture.root 'supervisor.lock')};protectedProcesses=@((Get-FileSetProcessIdentity $PID))}
  $gatePath = Join-Path $Fixture.root 'simulated-gate.json'
  Write-JsonFile $gatePath $gate
  return @{path=$gatePath;hash=(Get-Digest $gatePath);value=$gate;marker=$markerPath;apply=@{ManifestPath=$Fixture.manifest;ExpectedManifestSha256=$Fixture.hash;CandidateRoot=$Fixture.candidate;TransactionDirectory=$Fixture.transaction;Mode='LiveFiles';MaintenanceGatePath=$gatePath;ExpectedGateSha256=(Get-Digest $gatePath)}}
}

Run-Case 'full-install-and-independent-byte-restore' {
  $fixture = New-Fixture 'success'
  Apply-Fixture $fixture | Out-Null
  foreach ($file in $fixture.manifestValue.files) { Assert-True ((Get-Digest (Join-Path $fixture.manifestValue.roots[$file.root] $file.path)) -eq $file.sha256) 'Installed digest differs' }
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  $shellPath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $restoreOutput = & $shellPath -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash
  Assert-True ($LASTEXITCODE -eq 0) ('Independent restore process failed: ' + ($restoreOutput -join ' '))
  $restore = Get-Content -LiteralPath (Join-Path $fixture.transaction 'state.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True ($restore.restored -eq 6 -and $restore.removed -eq 2) 'Restore counts differ'
  Assert-Baseline $fixture
  $again = & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash
  Assert-True ($again.restored -eq 0 -and $again.removed -eq 0) 'Repeat restore changed files'
}

foreach ($faultIndex in 1..8) {
  Run-Case ('automatic-rollback-after-write-' + $faultIndex) {
    $fixture = New-Fixture ('fault-' + $faultIndex)
    Expect-Failure { Apply-Fixture $fixture $faultIndex } 'APPLY_FAILED_RESTORED' | Out-Null
    Assert-Baseline $fixture
  }
}

Run-Case 'interrupted-snapshot-independent-restore' {
  $fixture = New-Fixture 'interrupted'
  Expect-Failure { Apply-Fixture $fixture 3 -LeaveFailure } 'Injected shadow fault' | Out-Null
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash | Out-Null
  Assert-Baseline $fixture
}

Run-Case 'modified-new-file-refuses-removal-without-partial-restore' {
  $fixture = New-Fixture 'concurrent-new'
  Apply-Fixture $fixture | Out-Null
  $newFile = Join-Path $fixture.code 'ops/napcat-process-identity.ps1'
  [IO.File]::WriteAllText($newFile, 'THIRD PARTY CHANGE')
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash } 'concurrent or unknown' | Out-Null
  Assert-True ([IO.File]::ReadAllText($newFile) -eq 'THIRD PARTY CHANGE') 'Third party change removed'
  Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Partial restore occurred before refusal'
}

Run-Case 'corrupt-backup-refused-before-target-write' {
  $fixture = New-Fixture 'corrupt-backup'
  Apply-Fixture $fixture | Out-Null
  [IO.File]::WriteAllText((Join-Path $fixture.transaction 'backup/0000.bin'), 'CORRUPT')
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash } 'Corrupt backup' | Out-Null
  Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Target changed after corrupt backup'
}

foreach ($scenario in @('manifest-hash','candidate-hash','baseline-hash','unfrozen','traversal','duplicate')) {
  Run-Case ('preflight-' + $scenario) {
    $fixture = New-Fixture $scenario
    $expected = ''
    switch ($scenario) {
      'manifest-hash' { $fixture.hash = ('0' * 64); $expected='SHA256 mismatch' }
      'candidate-hash' { [IO.File]::AppendAllText((Join-Path $fixture.candidate $fixture.manifestValue.files[0].source),'drift'); $expected='Candidate file hash mismatch' }
      'baseline-hash' { $fixture.manifestValue.files[0].beforeSha256 = ('0' * 64); $expected='Installed baseline mismatch' }
      'unfrozen' { $fixture.manifestValue.status='pending-freeze'; $expected='frozen schemaVersion' }
      'traversal' { $fixture.manifestValue.files[0].path='../outside.ps1'; $expected='Invalid path segment' }
      'duplicate' { $fixture.manifestValue.files += $fixture.manifestValue.files[0]; $expected='Duplicate target' }
    }
    if ($scenario -notin @('manifest-hash','candidate-hash')) { Write-JsonFile $fixture.manifest $fixture.manifestValue; $fixture.hash=Get-Digest $fixture.manifest }
    Expect-Failure { Apply-Fixture $fixture } $expected | Out-Null
    Assert-Baseline $fixture
    Assert-True (-not (Test-Path -LiteralPath $fixture.transaction)) 'Preflight created a transaction'
  }
}

Run-Case 'live-mode-missing-maintenance-gate-refused' {
  $fixture = New-Fixture 'live-gate'
  Expect-Failure { & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') -ManifestPath $fixture.manifest -ExpectedManifestSha256 $fixture.hash -CandidateRoot $fixture.candidate -TransactionDirectory $fixture.transaction -Mode LiveFiles } 'maintenance gate receipt' | Out-Null
  Assert-Baseline $fixture
}

Run-Case 'read-only-preflight-does-not-create-files' {
  $fixture = New-Fixture 'validate-only'
  $reply = & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') -ManifestPath $fixture.manifest -ExpectedManifestSha256 $fixture.hash -CandidateRoot $fixture.candidate -TransactionDirectory $fixture.transaction -Mode LiveFiles -ValidateOnly
  Assert-True ($reply.status -eq 'validated-no-writes') 'Preflight status differs'
  Assert-True (-not (Test-Path -LiteralPath $fixture.transaction)) 'Read-only preflight wrote transaction'
  Assert-Baseline $fixture
}

Run-Case 'append-only-log-keeps-prefix-and-new-tail' {
  $fixture = New-Fixture 'append-log'
  $logPath = Join-Path $fixture.account 'state/append.jsonl'
  $prefix = [IO.File]::ReadAllBytes($logPath)
  Apply-Fixture $fixture | Out-Null
  [IO.File]::AppendAllText($logPath, "LEGITIMATE NEW TAIL`n")
  $expectedLog = [Convert]::ToBase64String([IO.File]::ReadAllBytes($logPath))
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash | Out-Null
  Assert-True ([Convert]::ToBase64String([IO.File]::ReadAllBytes($logPath)) -ceq $expectedLog) 'Appended log changed during restore'
  Assert-True ([Convert]::ToBase64String([byte[]]([IO.File]::ReadAllBytes($logPath))[0..($prefix.Length - 1)]) -ceq [Convert]::ToBase64String($prefix)) 'Append-only prefix changed'
}

Run-Case 'reparse-target-rejected' {
  $fixture = New-Fixture 'junction'
  New-Item -ItemType Junction -Path (Join-Path $fixture.code 'ops-link') -Target (Join-Path $fixture.code 'ops') | Out-Null
  $fixture.manifestValue.files[0].path = 'ops-link/start-napcat-login.ps1'
  Write-JsonFile $fixture.manifest $fixture.manifestValue
  $fixture.hash = Get-Digest $fixture.manifest
  Expect-Failure { Apply-Fixture $fixture } 'Reparse point rejected' | Out-Null
  Assert-Baseline $fixture
}

Run-Case 'restore-plan-tamper-refused' {
  $fixture = New-Fixture 'plan-tamper'
  Apply-Fixture $fixture | Out-Null
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  [IO.File]::AppendAllText((Join-Path $fixture.transaction 'restore-plan.json'), ' ')
  Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash } 'SHA256 mismatch' | Out-Null
  Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Tamper rejection changed target'
}

foreach ($gateScenario in @('expired','false-quiescence','mismatch','valid-shadow-livefiles')) {
  Run-Case ('gate-' + $gateScenario) {
    $fixture = New-Fixture ('gate-' + $gateScenario)
    $receipt = New-LiveFixtureGate $fixture
    $gatePath = $receipt.path
    $gate = $receipt.value
    $expected = ''
    switch ($gateScenario) {
      'expired' { $gate.expiresAtUtc=[DateTimeOffset]::UtcNow.AddSeconds(-5).ToString('o'); $expected='expired' }
      'false-quiescence' { $gate.writerQuiescenceVerified=$false; $expected='has not verified' }
      'mismatch' { $gate.manifestSha256=('0' * 64); $expected='has not verified' }
    }
    Write-JsonFile $gatePath $gate
    $gateHash = Get-Digest $gatePath
    $applyArguments = @{ManifestPath=$fixture.manifest;ExpectedManifestSha256=$fixture.hash;CandidateRoot=$fixture.candidate;TransactionDirectory=$fixture.transaction;Mode='LiveFiles';MaintenanceGatePath=$gatePath;ExpectedGateSha256=$gateHash}
    if ($expected) {
      Expect-Failure { & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @applyArguments } $expected | Out-Null
    } else {
      & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @applyArguments | Out-Null
      $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
      & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $gatePath -ExpectedGateSha256 $gateHash | Out-Null
    }
    Assert-Baseline $fixture
  }
}

Run-Case 'gate-expiry-after-first-write-rolls-back' {
  $fixture = New-Fixture 'expiry-after-write'
  $receipt = New-LiveFixtureGate $fixture 2
  $arguments = $receipt.apply
  $context = [pscustomobject]@{observed=$false;target=(Join-Path $fixture.code 'ops/start-napcat-login.ps1');expiry=[DateTimeOffset]::Parse($receipt.value.expiresAtUtc)}
  $line = (Select-String -LiteralPath (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') -SimpleMatch 'if ($FaultAfter -eq $written)').LineNumber
  $action = {
    if (-not $context.observed) {
      if (-not [IO.File]::ReadAllText($context.target).StartsWith('SHADOW FIXTURE ONLY')) { throw 'First target was not written before expiry' }
      $context.observed = $true
      $delay = [int][Math]::Max(0, ($context.expiry - [DateTimeOffset]::UtcNow).TotalMilliseconds) + 50
      Start-Sleep -Milliseconds $delay
    }
    continue
  }.GetNewClosure()
  $breakpoint = Set-PSBreakpoint -Script (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') -Line $line -Action $action
  try { Expect-Failure { & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments } 'APPLY_FAILED_RESTORED:.*expired' | Out-Null }
  finally { Remove-PSBreakpoint -Breakpoint $breakpoint }
  Assert-True $context.observed 'Expiry did not follow a verified first write'
  Assert-Baseline $fixture
}

foreach ($scenario in @('foreign-marker','alternate-gate','tampered-plan','tampered-manifest')) {
  Run-Case ('restore-refuses-' + $scenario) {
    $fixture = New-Fixture ('restore-' + $scenario)
    $receipt = New-LiveFixtureGate $fixture
    $arguments = $receipt.apply
    & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments | Out-Null
    $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
    $expected = 'SHA256 mismatch'
    switch ($scenario) {
      'foreign-marker' { Write-JsonFile $receipt.marker @{schemaVersion=1;ownerId='another-owner';manifestSha256=$fixture.hash} }
      'alternate-gate' { $receipt = New-LiveFixtureGate $fixture; $expected='Restore gate differs' }
      'tampered-plan' { [IO.File]::AppendAllText((Join-Path $fixture.transaction 'restore-plan.json'), ' ') }
      'tampered-manifest' { [IO.File]::AppendAllText((Join-Path $fixture.transaction 'manifest.json'), ' ') }
    }
    Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $receipt.path -ExpectedGateSha256 $receipt.hash } $expected | Out-Null
    Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Refused restore changed target'
  }
}

foreach ($scenario in @('supervisor-present','locked-supervisor','protected-birth','protected-image','marker-owner')) {
  Run-Case ('fresh-gate-refuses-' + $scenario) {
    $fixture = New-Fixture ('fresh-' + $scenario)
    $receipt = New-LiveFixtureGate $fixture
    $lock = $null
    $expected = 'Protected process identity changed'
    switch ($scenario) {
      'supervisor-present' { $receipt.value.supervisor.processId=$PID; $expected='Supervisor has not exited' }
      'locked-supervisor' { Save-Bytes $receipt.value.supervisor.lockPath ([byte[]]@(1)); $lock=[IO.File]::Open($receipt.value.supervisor.lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); $expected='Supervisor lock is not released' }
      'protected-birth' { $receipt.value.protectedProcesses[0].createdAtUtc=[DateTimeOffset]::UtcNow.AddYears(-1).ToString('o') }
      'protected-image' { $receipt.value.protectedProcesses[0].executablePath=(Join-Path $fixture.root 'different.exe') }
      'marker-owner' { $receipt.value.ownerId='another-owner'; $expected='marker owner' }
    }
    Write-JsonFile $receipt.path $receipt.value
    $arguments = $receipt.apply
    $arguments.ExpectedGateSha256=Get-Digest $receipt.path
    try { Expect-Failure { & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments } $expected | Out-Null }
    finally { if ($null -ne $lock) { $lock.Dispose() } }
    Assert-Baseline $fixture
  }
}

foreach ($scenario in @('supervisor-reappeared','lock-reacquired','protected-birth-changed','protected-image-changed')) {
  Run-Case ('restore-fresh-observation-' + $scenario) {
    $fixture = New-Fixture ('restore-fresh-' + $scenario)
    $receipt = New-LiveFixtureGate $fixture
    $arguments = $receipt.apply
    & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments | Out-Null
    $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
    $lock = $null
    $expected = 'Protected process identity changed'
    if ($scenario -eq 'lock-reacquired') {
      Save-Bytes $receipt.value.supervisor.lockPath ([byte[]]@(1))
      $lock = [IO.File]::Open($receipt.value.supervisor.lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
      $expected = 'Supervisor lock is not released'
    }
    if ($scenario -eq 'supervisor-reappeared') { $expected = 'Supervisor has not exited' }
    function Get-Process {
      [CmdletBinding()]
      param([int]$Id)
      if ($scenario -eq 'supervisor-reappeared' -and $Id -eq 2147483647) { return Microsoft.PowerShell.Management\Get-Process -Id $PID -ErrorAction Stop }
      $actual = Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
      if ($Id -eq $PID -and $scenario -like 'protected-*') {
        $start = $actual.StartTime
        $image = $actual.MainModule.FileName
        $actual.Dispose()
        if ($scenario -eq 'protected-birth-changed') { $start = $start.AddSeconds(-1) }
        else { $image = Join-Path $fixture.root 'different.exe' }
        $fake = [pscustomobject]@{Id=$Id;StartTime=$start;MainModule=[pscustomobject]@{FileName=$image}}
        $fake | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
        return $fake
      }
      return $actual
    }
    try { Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $receipt.path -ExpectedGateSha256 $receipt.hash } $expected | Out-Null }
    finally { if ($null -ne $lock) { $lock.Dispose() } }
    Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Fresh observation refusal changed target'
  }
}

Run-Case 'apply-rejects-new-runtime-pid-with-old-gate-pid-gone' {
  $fixture = New-Fixture 'new-runtime-apply'
  $receipt = New-LiveFixtureGate $fixture
  Write-JsonFile $receipt.value.supervisor.runtimeStatePath @{schemaVersion=1;pid=$PID;state='stopped'}
  $arguments = $receipt.apply
  Expect-Failure { & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments } 'Current runtime supervisor has not exited' | Out-Null
  Assert-Baseline $fixture
}

foreach ($observation in @('runtime','node-lock')) {
  Run-Case ('restore-rejects-live-' + $observation + '-then-allows-stopped-generation') {
    $fixture = New-Fixture ('new-generation-' + $observation)
    $receipt = New-LiveFixtureGate $fixture
    $arguments = $receipt.apply
    & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments | Out-Null
    $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
    if ($observation -eq 'runtime') {
      Write-JsonFile $receipt.value.supervisor.runtimeStatePath @{schemaVersion=1;pid=$PID;state='running'}
      $expected = 'Current runtime supervisor has not exited'
    } else {
      Write-JsonFile $receipt.value.supervisor.lockPath @{pid=$PID;startedAt=[DateTimeOffset]::UtcNow.ToString('o');token=[Guid]::NewGuid().ToString()}
      $expected = 'Supervisor lock owner has not exited'
    }
    Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $receipt.path -ExpectedGateSha256 $receipt.hash } $expected | Out-Null
    Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Refusal changed candidate target'
    Write-JsonFile $receipt.value.supervisor.runtimeStatePath @{schemaVersion=1;pid=2147483646;state='stopped'}
    if ($observation -eq 'node-lock') { Write-JsonFile $receipt.value.supervisor.lockPath @{pid=2147483646;startedAt=[DateTimeOffset]::UtcNow.ToString('o');token=[Guid]::NewGuid().ToString()} }
    & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $receipt.path -ExpectedGateSha256 $receipt.hash | Out-Null
    Assert-Baseline $fixture
  }
}

Run-Case 'nonprotected-simulated-backend-generation-change-allows-restore' {
  $fixture = New-Fixture 'backend-generation'
  $receipt = New-LiveFixtureGate $fixture
  $backendPath = Join-Path $fixture.root 'mock-backend.runtime.json'
  $mockBackendPid = 2147483646
  function Get-Process {
    [CmdletBinding()]
    param([int]$Id)
    if ($Id -eq $mockBackendPid) {
      $actual = Microsoft.PowerShell.Management\Get-Process -Id $PID -ErrorAction Stop
      $fake = [pscustomobject]@{Id=$mockBackendPid;StartTime=$actual.StartTime;MainModule=[pscustomobject]@{FileName=$actual.MainModule.FileName}}
      $actual.Dispose()
      $fake | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
      return $fake
    }
    return Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
  }
  $beforeBackend = Get-FileSetProcessIdentity $mockBackendPid
  Write-JsonFile $backendPath @{pid=$mockBackendPid;state='running'}
  $arguments = $receipt.apply
  & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments | Out-Null
  $mockBackendPid = 2147483645
  $afterBackend = Get-FileSetProcessIdentity $mockBackendPid
  Assert-True ($beforeBackend.processId -ne $afterBackend.processId) 'Mock backend PID did not change'
  Assert-True (@($receipt.value.protectedProcesses.processId) -notcontains $mockBackendPid) 'Mock backend was incorrectly protected'
  Write-JsonFile $backendPath @{pid=$mockBackendPid;state='running'}
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $receipt.path -ExpectedGateSha256 $receipt.hash | Out-Null
  Assert-Baseline $fixture
  Assert-True ((Get-Content -LiteralPath $backendPath -Raw -Encoding UTF8 | ConvertFrom-Json).pid -eq $mockBackendPid) 'Restore changed nonprotected backend observation'
}

Run-Case 'protected-pid-generation-change-refuses-restore' {
  $fixture = New-Fixture 'protected-generation'
  $receipt = New-LiveFixtureGate $fixture
  $arguments = $receipt.apply
  & (Join-Path $PSScriptRoot 'Apply-FileSet.ps1') @arguments | Out-Null
  $planHash = Get-Content -LiteralPath (Join-Path $fixture.transaction 'restore-plan.sha256') -Raw -Encoding UTF8
  function Get-Process {
    [CmdletBinding()]
    param([int]$Id)
    if ($Id -eq $PID) { return Microsoft.PowerShell.Management\Get-Process -Id 2147483644 -ErrorAction Stop }
    return Microsoft.PowerShell.Management\Get-Process -Id $Id -ErrorAction Stop
  }
  Expect-Failure { & (Join-Path $PSScriptRoot 'Restore-FileSet.ps1') -TransactionDirectory $fixture.transaction -ExpectedPlanSha256 $planHash -MaintenanceGatePath $receipt.path -ExpectedGateSha256 $receipt.hash } 'Protected process identity changed' | Out-Null
  Assert-True ((Get-Digest (Join-Path $fixture.code 'ops/start-napcat-login.ps1')) -eq $fixture.manifestValue.files[0].sha256) 'Protected PID refusal changed target'
}

Run-Case 'frozen-json-creation-time-preserves-zone-and-fraction' {
  $path = Join-Path $testRoot 'timestamp-preservation.json'
  $stamp = '2026-10-19T05:38:40.3446302Z'
  Write-JsonFile $path @{createdAtUtc=$stamp}
  $value = Read-FrozenJson $path (Get-Digest $path)
  Assert-True ((Get-FileSetUtcTicks $value.createdAtUtc) -eq [DateTimeOffset]::Parse($stamp).UtcDateTime.Ticks) 'Frozen JSON timestamp changed'
}

Run-Case 'typed-utc-creation-time-preserves-fraction' {
  $stamp = [DateTimeOffset]::Parse('2026-10-19T05:38:40.3446302Z')
  Assert-True ((Get-FileSetUtcTicks $stamp.UtcDateTime) -eq $stamp.UtcDateTime.Ticks) 'Typed UTC timestamp changed'
  Assert-True ((Get-FileSetUtcTicks $stamp) -eq $stamp.UtcDateTime.Ticks) 'Typed offset timestamp changed'
}

Run-Case 'explicit-offset-creation-time-matches-utc' {
  $utc = Get-FileSetUtcTicks '2026-10-19T05:38:40.3446302Z'
  $offset = Get-FileSetUtcTicks '2026-10-19T13:38:40.3446302+08:00'
  Assert-True ($utc -eq $offset) 'Explicit offset did not identify the same instant'
}

Run-Case 'unqualified-creation-time-refused' {
  Expect-Failure { Get-FileSetUtcTicks '2026-10-19T05:38:40.3446302' } 'time zone' | Out-Null
  Expect-Failure { Get-FileSetUtcTicks ([DateTime]::SpecifyKind([DateTime]::Now, [DateTimeKind]::Unspecified)) } 'time zone' | Out-Null
  Expect-Failure { Get-FileSetUtcTicks 'invalidZ' } 'time zone|Invalid timestamp' | Out-Null
}

$summary = [ordered]@{schemaVersion=1;shadowOnly=$true;testRoot=$testRoot;powershell=$PSVersionTable.PSVersion.ToString();passed=@($results | Where-Object status -EQ 'passed').Count;failed=@($results | Where-Object status -EQ 'failed').Count;results=@($results.ToArray());productionActions=@();generatedAtUtc=[DateTimeOffset]::UtcNow.ToString('o')}
Write-JsonFile (Join-Path $ResultsDirectory 'shadow-results.json') $summary
Write-Output ("RESULT passed=$($summary.passed) failed=$($summary.failed) shadowRoot=$testRoot")
if ($summary.failed) { throw "$($summary.failed) shadow tests failed; evidence retained: $testRoot" }
