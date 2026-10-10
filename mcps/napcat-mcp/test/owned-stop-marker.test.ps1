param(
    [string]$EvidenceRoot = (Join-Path ([IO.Path]::GetTempPath()) 'napcat-owned-marker-tests'),
    [ValidateSet('Suite', 'Attack', 'Verify', 'Race', 'ExitHolder')][string]$Mode = 'Suite'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$Helper = Join-Path $PSScriptRoot '..\ops\owned-stop-marker.ps1'
$null = [IO.Directory]::CreateDirectory($EvidenceRoot)
$env:TEMP = $EvidenceRoot
$env:TMP = $EvidenceRoot
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. $Helper

function Error-Code($Failure) {
    $Exception = $Failure.Exception
    while ($Exception.InnerException) { $Exception = $Exception.InnerException }
    if ($Exception.Message -match 'OWNED_STOP_MARKER_[A-Z0-9_]+') { return $Matches[0] }
    return ('HRESULT_' + $Exception.HResult.ToString('X8'))
}

if ($Mode -ne 'Suite') {
    $InputData = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $WorkerResult = [ordered]@{ mode = $Mode; processId = $PID }
    if ($Mode -eq 'Verify') {
        $Items = @()
        foreach ($Entry in $InputData.entries) {
            try {
                $Result = Assert-OwnedStopMarkerProof -ProofJson $Entry.proof -Path $Entry.path -Component $Entry.component -AttemptId $Entry.attempt -OperationId $Entry.operation
                $Items += [ordered]@{ name = $Entry.name; accepted = $true; fileId = $Result.FileId; hash = $Result.RecordSha256; state = $Result.State }
            } catch { $Items += [ordered]@{ name = $Entry.name; accepted = $false; code = (Error-Code $_) } }
        }
        $WorkerResult.entries = $Items
    } elseif ($Mode -eq 'Attack') {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedStopMarkerReplacementTest {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    static extern bool ReplaceFileW(string replaced, string replacement, string backup, uint flags, IntPtr exclude, IntPtr reserved);
    public static int Replace(string replaced, string replacement) {
        return ReplaceFileW(replaced, replacement, null, 0, IntPtr.Zero, IntPtr.Zero) ? 0 : Marshal.GetLastWin32Error();
    }
}
'@
        $ReadHandle = [IO.File]::Open($InputData.path, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $Buffer = [byte[]]::new([int]$ReadHandle.Length)
            $Count = $ReadHandle.Read($Buffer, 0, $Buffer.Length)
            $WorkerResult.readSucceeded = ($Count -eq $Buffer.Length)
        } finally { $ReadHandle.Dispose() }
        [IO.File]::WriteAllBytes($InputData.replacement, $Buffer)
        $Items = @()
        foreach ($Action in @('Write', 'Delete', 'SameBytesReplace', 'OrdinaryRead')) {
            try {
                switch ($Action) {
                    'Write' { [IO.File]::WriteAllText($InputData.path, 'foreign overwrite') }
                    'Delete' { [IO.File]::Delete($InputData.path) }
                    'SameBytesReplace' {
                        $ReplaceError = [OwnedStopMarkerReplacementTest]::Replace($InputData.path, $InputData.replacement)
                        if ($ReplaceError -ne 0) { throw ('OWNED_STOP_MARKER_REPLACE_WIN32_' + $ReplaceError) }
                    }
                    'OrdinaryRead' { $null = [IO.File]::ReadAllText($InputData.path) }
                }
                $Items += [ordered]@{ name = $Action; blocked = $false }
            } catch { $Items += [ordered]@{ name = $Action; blocked = $true; code = (Error-Code $_) } }
        }
        $WorkerResult.entries = $Items
    } elseif ($Mode -eq 'Race') {
        [IO.File]::WriteAllText($InputData.ready, 'ready')
        $Clock = [Diagnostics.Stopwatch]::StartNew()
        while (-not [IO.File]::Exists($InputData.go)) {
            if ($Clock.Elapsed.TotalSeconds -gt 15) { throw 'RACE_GATE_TIMEOUT' }
            Start-Sleep -Milliseconds 20
        }
        try {
            $Owned = New-OwnedStopMarker -Path $InputData.path -Component proxy -AttemptId $InputData.attempt
            $WorkerResult.won = $true
            $State = Read-OwnedStopMarker -Lease $Owned -Path $InputData.path -Component proxy -AttemptId $InputData.attempt
            $WorkerResult.fileId = $State.FileId
            $WorkerResult.hash = $State.RecordSha256
            $Owned.Dispose()
        } catch { $WorkerResult.won = $false; $WorkerResult.code = (Error-Code $_) }
    } elseif ($Mode -eq 'ExitHolder') {
        $Owned = New-OwnedStopMarker -Path $InputData.path -Component router -AttemptId exited-holder
        $State = Read-OwnedStopMarker -Lease $Owned -Path $InputData.path -Component router -AttemptId exited-holder
        $WorkerResult.fileId = $State.FileId
        $WorkerResult.hash = $State.RecordSha256
        $WorkerResult.state = $State.State
    }
    [Console]::Out.WriteLine(($WorkerResult | ConvertTo-Json -Depth 8 -Compress))
    exit 0
}

$RunRoot = Join-Path ([IO.Path]::GetFullPath($EvidenceRoot)) ('run-' + [guid]::NewGuid().ToString('N'))
$null = [IO.Directory]::CreateDirectory($RunRoot)
$Processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$Leases = [Collections.Generic.List[object]]::new()
$Results = [Collections.Generic.List[object]]::new()
$ProcessResults = [Collections.Generic.List[object]]::new()
$PowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$Stopwatch = [Diagnostics.Stopwatch]::StartNew()

function Start-Worker([string]$WorkerMode, [object]$Data) {
    $Info = [Diagnostics.ProcessStartInfo]::new()
    $Info.FileName = $PowerShell
    $Info.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Mode ' + $WorkerMode + ' -EvidenceRoot "' + $RunRoot + '"'
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    $Info.RedirectStandardInput = $true
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Process = [Diagnostics.Process]::Start($Info)
    $Processes.Add($Process)
    $Process.StandardInput.Write(($Data | ConvertTo-Json -Depth 10 -Compress))
    $Process.StandardInput.Close()
    return $Process
}

function Wait-Worker([Diagnostics.Process]$Process) {
    if (-not $Process.WaitForExit(30000)) { throw 'OWN_TEST_CHILD_TIMEOUT' }
    $Output = $Process.StandardOutput.ReadToEnd()
    $ErrorOutput = $Process.StandardError.ReadToEnd()
    $ProcessResults.Add([ordered]@{ processId = $Process.Id; exitCode = $Process.ExitCode; exited = $Process.HasExited; stderrEmpty = ($ErrorOutput.Length -eq 0) })
    if ($Process.ExitCode -ne 0 -or $ErrorOutput.Length -gt 0) { throw 'OWN_TEST_CHILD_FAILED' }
    return ($Output | ConvertFrom-Json)
}

function Check([string]$Name, [bool]$Passed, [object]$Detail = $null) {
    $Results.Add([ordered]@{ name = $Name; passed = $Passed; detail = $Detail })
    $Status = if ($Passed) { 'PASS' } else { 'FAIL' }
    Write-Output ($Status + ' ' + $Name)
}

function Reject([string]$Name, [scriptblock]$Action) {
    try { $null = & $Action; Check $Name $false 'unexpected acceptance' }
    catch { Check $Name $true (Error-Code $_) }
}

function Bind([object]$Lease, [string]$Path, [string]$Component, [string]$Attempt) {
    return @{ Lease = $Lease; Path = $Path; Component = $Component; AttemptId = $Attempt }
}

try {
    $Layout = [NapCat.OwnedStopMarker.Native]::Layout()
    Check 'native-layout-1-24-24' ($Layout.FileDispositionInfo -eq 1 -and $Layout.FileIdInfo -eq 24 -and $Layout.FileStandardInfo -eq 24) $Layout
    $Path = Join-Path $RunRoot 'held.stop'
    $Lease = New-OwnedStopMarker -Path $Path -Component proxy -AttemptId held-case
    $Leases.Add($Lease)
    $Binding = Bind $Lease $Path proxy held-case
    $Before = Read-OwnedStopMarker @Binding
    $Proof = Export-OwnedStopMarkerProof @Binding
    $ProofObject = $Proof | ConvertFrom-Json
    Check 'high-entropy-token-shape-not-logged' ($ProofObject.ownerToken -cmatch '^[0-9a-f]{64}$')
    Check 'independent-operation-id' ($ProofObject.operationId -ne $ProofObject.attemptId)
    Check 'sanitized-evidence-has-no-token' (-not (($Before | ConvertTo-Json -Compress).Contains($ProofObject.ownerToken)))
    $Attack = Wait-Worker (Start-Worker Attack @{ path = $Path; replacement = (Join-Path $RunRoot 'same-bytes.tmp') })
    Check 'other-process-compatible-read' $Attack.readSucceeded
    foreach ($AttackResult in $Attack.entries) {
        $ExpectedCode = if ($AttackResult.name -eq 'SameBytesReplace') { 'OWNED_STOP_MARKER_REPLACE_WIN32_32' } else { 'HRESULT_80070020' }
        Check ('other-process-' + $AttackResult.name + '-blocked') ($AttackResult.blocked -and $AttackResult.code -eq $ExpectedCode) $AttackResult.code
    }
    $After = Assert-OwnedStopMarker @Binding
    Check 'same-file-id-and-hash-after-attacks' ($Before.FileId -eq $After.FileId -and $Before.RecordSha256 -eq $After.RecordSha256)
    Reject 'create-existing-marker-rejected' { New-OwnedStopMarker -Path $Path -Component proxy -AttemptId second-owner }
    Reject 'wrong-lease-object-rejected' { Assert-OwnedStopMarker -Lease $ProofObject -Path $Path -Component proxy -AttemptId held-case }
    Reject 'wrong-path-rejected' { Consume-OwnedStopMarker -Lease $Lease -Path (Join-Path $RunRoot 'wrong.stop') -Component proxy -AttemptId held-case }
    Reject 'wrong-component-rejected' { Consume-OwnedStopMarker -Lease $Lease -Path $Path -Component router -AttemptId held-case }
    Reject 'wrong-attempt-rejected' { Consume-OwnedStopMarker -Lease $Lease -Path $Path -Component proxy -AttemptId wrong-attempt }
    Reject 'wrong-operation-rejected' { Consume-OwnedStopMarker @Binding -OperationId ([guid]::NewGuid().ToString('D')) }
    $Entries = @(@{ name = 'valid'; proof = $Proof; path = $Path; component = 'proxy'; attempt = 'held-case'; operation = $Lease.OperationId })
    foreach ($Field in @('fileId', 'recordSha256', 'operationId', 'ownerToken', 'component', 'attemptId', 'schema', 'path', 'ownerProcessId', 'expiresUtc')) {
        $Changed = $Proof | ConvertFrom-Json
        switch ($Field) {
            'operationId' { $Changed.$Field = [guid]::NewGuid().ToString('D') }
            'ownerToken' { $Changed.$Field = ('0' * 64) }
            'ownerProcessId' { $Changed.$Field = 'wrong-type' }
            'expiresUtc' { $Changed.$Field = '2000-01-01T00:00:00.0000000Z' }
            'path' { $Changed.$Field = Join-Path $RunRoot 'other.stop' }
            default { $Changed.$Field = 'incorrect' }
        }
        $Entries += @{ name = 'wrong-' + $Field; proof = ($Changed | ConvertTo-Json -Depth 6 -Compress); path = $Path; component = 'proxy'; attempt = 'held-case'; operation = $Lease.OperationId }
    }
    $Entries += @{ name = 'invalid-json'; proof = '{'; path = $Path; component = 'proxy'; attempt = 'held-case'; operation = $Lease.OperationId }
    $Entries += @{ name = 'duplicate-json-key'; proof = ($Proof.Substring(0, $Proof.Length - 1) + ',"component":"proxy"}'); path = $Path; component = 'proxy'; attempt = 'held-case'; operation = $Lease.OperationId }
    $Entries += @{ name = 'escaped-duplicate-json-key'; proof = ($Proof.Substring(0, $Proof.Length - 1) + ',"\u0063omponent":"proxy"}'); path = $Path; component = 'proxy'; attempt = 'held-case'; operation = $Lease.OperationId }
    $Verification = Wait-Worker (Start-Worker Verify @{ entries = $Entries })
    foreach ($Entry in $Verification.entries) {
        Check ('child-proof-' + $Entry.name) ($Entry.accepted -eq ($Entry.name -eq 'valid')) $Entry
    }
    $NodeInfo = [Diagnostics.ProcessStartInfo]::new()
    $NodeInfo.FileName = (Get-Command node.exe -ErrorAction Stop).Source
    $NodeInfo.Arguments = '-e "const fs=require(''fs'');const p=process.argv[1];console.log(JSON.stringify({exists:fs.existsSync(p),bytes:fs.readFileSync(p).length}));" "' + $Path + '"'
    $NodeInfo.UseShellExecute = $false
    $NodeInfo.CreateNoWindow = $true
    $NodeInfo.RedirectStandardOutput = $true
    $NodeInfo.RedirectStandardError = $true
    $Node = [Diagnostics.Process]::Start($NodeInfo)
    $Processes.Add($Node)
    $NodeResult = Wait-Worker $Node
    Check 'real-node-discovers-and-reads-held-marker' ($NodeResult.exists -and $NodeResult.bytes -gt 0) $NodeResult
    $Consumed = Consume-OwnedStopMarker @Binding
    Check 'same-native-handle-consumed' ($Consumed.State -eq 'Consumed' -and $Consumed.DispositionApplied -and $Consumed.LeaseReleased -and $Consumed.PathState -eq 'Missing') $Consumed
    Reject 'duplicate-consume-rejected' { Consume-OwnedStopMarker @Binding }
    Reject 'consumed-assert-rejected' { Assert-OwnedStopMarker @Binding }
    $NewLease = New-OwnedStopMarker -Path $Path -Component proxy -AttemptId new-stop
    $Leases.Add($NewLease)
    $NewBinding = Bind $NewLease $Path proxy new-stop
    $NewEvidence = Read-OwnedStopMarker @NewBinding
    Reject 'old-consume-cannot-delete-new-stop' { Consume-OwnedStopMarker @Binding }
    $NewAfter = Read-OwnedStopMarker @NewBinding
    Check 'new-stop-preserved-after-old-consume' ($NewAfter.OperationId -eq $NewEvidence.OperationId -and $NewAfter.RecordSha256 -eq $NewEvidence.RecordSha256)
    $null = Close-OwnedStopMarker -Lease $NewLease
    Check 'close-preserves-marker-and-bytes' ([IO.File]::Exists($Path) -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $NewEvidence.RecordSha256)
    Reject 'closed-lease-rejected' { Assert-OwnedStopMarker @NewBinding }
    Reject 'closed-proof-cannot-adopt' { Assert-OwnedStopMarkerProof -ProofJson (ConvertTo-Json $ProofObject -Depth 6 -Compress) -Path $Path -Component proxy }
    $DisposePath = Join-Path $RunRoot 'disposed.stop'
    $Disposed = New-OwnedStopMarker -Path $DisposePath -Component router -AttemptId dispose-case
    $DisposedBinding = Bind $Disposed $DisposePath router dispose-case
    $DisposeProof = Export-OwnedStopMarkerProof @DisposedBinding
    $Disposed.Dispose()
    Check 'dispose-preserves-marker' ([IO.File]::Exists($DisposePath))
    Reject 'proof-from-released-live-holder-rejected' { Assert-OwnedStopMarkerProof -ProofJson $DisposeProof -Path $DisposePath -Component router }
    $DeleteOnlyReader = [IO.File]::Open($DisposePath, 'Open', 'Read', [IO.FileShare]::ReadWrite)
    try {
        Reject 'released-proof-with-delete-only-lock-rejected' { Assert-OwnedStopMarkerProof -ProofJson $DisposeProof -Path $DisposePath -Component router }
        $WritableProbe = [IO.File]::Open($DisposePath, 'Open', 'Write', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try { Check 'delete-only-lock-really-allows-write' $WritableProbe.CanWrite } finally { $WritableProbe.Dispose() }
    } finally { $DeleteOnlyReader.Dispose() }
    $UnrelatedReadLock = [IO.File]::Open($DisposePath, 'Open', 'Read', [IO.FileShare]::Read)
    try {
        $Observation = Assert-OwnedStopMarkerProof -ProofJson $DisposeProof -Path $DisposePath -Component router
        Check 'unrelated-read-lock-observation-only' ($Observation.State -eq 'ReadOnlyVerified')
        Reject 'unrelated-read-lock-cannot-restore-parent-lease' { Assert-OwnedStopMarker @DisposedBinding }
        Reject 'unrelated-read-lock-cannot-consume' { Consume-OwnedStopMarker @DisposedBinding }
    } finally { $UnrelatedReadLock.Dispose() }
    $PendingPath = Join-Path $RunRoot 'pending.stop'
    $PendingLease = New-OwnedStopMarker -Path $PendingPath -Component proxy -AttemptId pending-reader
    $Leases.Add($PendingLease)
    $Reader = [IO.File]::Open($PendingPath, 'Open', 'Read', ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try {
        $PendingResult = Consume-OwnedStopMarker -Lease $PendingLease -Path $PendingPath -Component proxy -AttemptId pending-reader
        Check 'outstanding-reader-delete-pending-is-not-missing' ($PendingResult.PathState -eq 'Unavailable') $PendingResult.PathState
        Reject 'delete-pending-create-rejected' { New-OwnedStopMarker -Path $PendingPath -Component proxy -AttemptId pending-new }
    } finally { $Reader.Dispose() }
    Check 'last-reader-release-finishes-delete' (-not [IO.File]::Exists($PendingPath))
    $ExpirePath = Join-Path $RunRoot 'expired.stop'
    $Expired = New-OwnedStopMarker -Path $ExpirePath -Component proxy -AttemptId expire-case -LifetimeSeconds 1
    $Leases.Add($Expired)
    $ExpireBinding = Bind $Expired $ExpirePath proxy expire-case
    $ExpireProof = Export-OwnedStopMarkerProof @ExpireBinding
    Start-Sleep -Milliseconds 1150
    Reject 'expired-lease-consume-rejected' { Consume-OwnedStopMarker @ExpireBinding }
    Reject 'expired-proof-rejected' { Assert-OwnedStopMarkerProof -ProofJson $ExpireProof -Path $ExpirePath -Component proxy }
    $null = Close-OwnedStopMarker -Lease $Expired
    Check 'expired-marker-preserved' ([IO.File]::Exists($ExpirePath))
    Reject 'relative-path-rejected' { New-OwnedStopMarker -Path '.\relative.stop' -Component proxy -AttemptId bad-path }
    Reject 'alternate-data-stream-rejected' { New-OwnedStopMarker -Path ($Path + ':stream') -Component proxy -AttemptId bad-path }
    $ExitPath = Join-Path $RunRoot 'exited-holder.stop'
    $Exited = Wait-Worker (Start-Worker ExitHolder @{ path = $ExitPath })
    Check 'holder-normal-exit-preserves-marker' ([IO.File]::Exists($ExitPath) -and (Get-FileHash -LiteralPath $ExitPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Exited.hash) $Exited
    $RacePath = Join-Path $RunRoot 'race.stop'
    $Go = Join-Path $RunRoot 'race.go'
    $ReadyA = Join-Path $RunRoot 'race-a.ready'
    $ReadyB = Join-Path $RunRoot 'race-b.ready'
    $WorkerA = Start-Worker Race @{ path = $RacePath; go = $Go; ready = $ReadyA; attempt = 'race-a' }
    $WorkerB = Start-Worker Race @{ path = $RacePath; go = $Go; ready = $ReadyB; attempt = 'race-b' }
    $RaceClock = [Diagnostics.Stopwatch]::StartNew()
    while (-not ([IO.File]::Exists($ReadyA) -and [IO.File]::Exists($ReadyB))) {
        if ($RaceClock.Elapsed.TotalSeconds -gt 15) { throw 'OWN_TEST_RACE_READY_TIMEOUT' }
        Start-Sleep -Milliseconds 20
    }
    [IO.File]::WriteAllText($Go, 'go')
    $RaceResults = @((Wait-Worker $WorkerA), (Wait-Worker $WorkerB))
    $Winners = @($RaceResults | Where-Object { $_.won })
    Check 'two-process-create-new-exactly-one-winner' ($Winners.Count -eq 1) $RaceResults
    Check 'race-winner-record-preserved' ($Winners.Count -eq 1 -and (Get-FileHash -LiteralPath $RacePath -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Winners[0].hash)
} catch {
    Check 'suite-unexpected-error' $false (Error-Code $_)
} finally {
    foreach ($Lease in $Leases) { $Lease.Dispose() }
    foreach ($Process in $Processes) {
        if (-not $Process.HasExited) { $null = $Process.WaitForExit(35000) }
    }
    $AllExited = @($Processes | Where-Object { -not $_.HasExited }).Count -eq 0
    Check 'all-owned-child-processes-exited-normally' $AllExited
    if ($AllExited) {
        foreach ($File in [IO.Directory]::GetFiles($RunRoot)) {
            if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($File)) -ne $RunRoot) { throw 'OWN_TEST_CLEANUP_SCOPE_MISMATCH' }
            if ([IO.Path]::GetExtension($File) -in @('.stop', '.tmp', '.go', '.ready')) { [IO.File]::Delete($File) }
        }
    }
    foreach ($Process in $Processes) { if ($Process.HasExited) { $Process.Dispose() } }
}

$Failed = @($Results | Where-Object { -not $_.passed }).Count
$Summary = [ordered]@{
    schema = 'napcat.owned-stop-marker-native-test/v1'
    native = $true
    mocks = $false
    powershell = $PSVersionTable.PSVersion.ToString()
    os = [Environment]::OSVersion.VersionString
    helperSha256 = (Get-FileHash -LiteralPath $Helper -Algorithm SHA256).Hash.ToLowerInvariant()
    passed = $Results.Count - $Failed
    failed = $Failed
    durationSeconds = [math]::Round($Stopwatch.Elapsed.TotalSeconds, 3)
    resources = @{ allChildrenExited = $AllExited; transientFixtureFilesRemoved = $AllExited }
    children = $ProcessResults.ToArray()
    checks = $Results.ToArray()
}
$ResultPath = Join-Path $RunRoot 'result.json'
[IO.File]::WriteAllText($ResultPath, ($Summary | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Write-Output ('RESULT passed=' + $Summary.passed + ' failed=' + $Failed + ' native=true mocks=false')
Write-Output ('EVIDENCE ' + $ResultPath)
if ($Failed -gt 0) { exit 1 }
