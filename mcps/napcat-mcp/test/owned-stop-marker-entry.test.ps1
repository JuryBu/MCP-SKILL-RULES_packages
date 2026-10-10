[CmdletBinding()]
param([string]$OutputRoot = '', [string]$ChildPowerShellPath = '')

$ErrorActionPreference = 'Stop'
if (-not $OutputRoot) { $OutputRoot = Join-Path ([IO.Path]::GetTempPath()) ('napcat-marker-entry-' + [guid]::NewGuid().ToString('N')) }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $OutputRoot) { throw 'OUTPUT_ROOT_MUST_BE_NEW' }
if (-not $ChildPowerShellPath) { $ChildPowerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
$SourceRoot = Split-Path -Parent $PSScriptRoot
$OpsRoot = Join-Path $OutputRoot 'package\ops'
$FixtureRoot = Join-Path $OutputRoot 'package\src'
New-Item -ItemType Directory -Path $OpsRoot, $FixtureRoot | Out-Null
$Files = @('owned-stop-marker.ps1', 'resolve-napcat-data-root.ps1', 'stop-codex-app-server-proxy.ps1', 'stop-napcat-task-router.ps1', 'start-codex-app-server-proxy.ps1', 'start-napcat-task-router.ps1')
$Hashes = @{}
foreach ($Name in $Files) {
    Copy-Item -LiteralPath (Join-Path $SourceRoot ('ops\' + $Name)) -Destination (Join-Path $OpsRoot $Name)
    $Hashes[$Name] = (Get-FileHash -LiteralPath (Join-Path $OpsRoot $Name) -Algorithm SHA256).Hash
}
. (Join-Path $OpsRoot 'owned-stop-marker.ps1')
$Utf8 = New-Object Text.UTF8Encoding($false)
$NodePath = (Get-Command node -ErrorAction Stop).Source
$Fixture = @'
import fs from 'node:fs';
const args = process.argv.slice(2);
const value = name => args[args.indexOf(name) + 1];
const runtimePath = value('--runtime-state');
const markerPath = value('--stop-file');
const lockPath = value('--lock');
fs.writeFileSync(lockPath, JSON.stringify({pid:process.pid,token:'entry-fixture'}));
fs.writeFileSync(runtimePath, JSON.stringify({pid:process.pid,state:'running',instanceToken:'entry-fixture'}));
const timer = setInterval(() => { if (fs.existsSync(markerPath)) { clearInterval(timer); process.exit(0); } }, 25);
setTimeout(() => process.exit(0), 20000).unref();
'@
foreach ($Name in @('task-router-runner.mjs', 'codex-app-server-proxy-runner.mjs')) { [IO.File]::WriteAllText((Join-Path $FixtureRoot $Name), $Fixture, $Utf8) }
$Results = New-Object 'Collections.Generic.List[object]'
function Assert-Entry([bool]$Condition, [string]$Name) {
    $Results.Add([pscustomobject]@{ name = $Name; passed = $Condition })
    if (-not $Condition) { throw ('ASSERTION_FAILED: ' + $Name) }
}
function Invoke-Entry([string]$Name, [string[]]$Arguments) {
    $StartInfo = New-Object Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $ChildPowerShellPath
    $Parts = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', (Join-Path $OpsRoot $Name)) + $Arguments
    $StartInfo.Arguments = ($Parts | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
    $StartInfo.UseShellExecute = $false
    $StartInfo.CreateNoWindow = $true
    $StartInfo.RedirectStandardOutput = $true
    $StartInfo.RedirectStandardError = $true
    $StartInfo.EnvironmentVariables.Remove('PSModulePath')
    $Child = [Diagnostics.Process]::Start($StartInfo)
    $StdoutTask = $Child.StandardOutput.ReadToEndAsync()
    $StderrTask = $Child.StandardError.ReadToEndAsync()
    if (-not $Child.WaitForExit(30000)) { throw 'ENTRY_CHILD_WAIT_EXCEEDED' }
    $Result = [pscustomobject]@{ name = $Name; exitCode = $Child.ExitCode; stdout = $StdoutTask.Result; stderr = $StderrTask.Result; pid = $Child.Id }
    [IO.File]::WriteAllText((Join-Path $OutputRoot ('call-' + [guid]::NewGuid().ToString('N') + '.json')), ($Result | ConvertTo-Json -Depth 8), $Utf8)
    $Child.Dispose()
    return $Result
}
$Failure = $null
try {
    foreach ($Component in @('proxy', 'router')) {
        $DataRoot = Join-Path $OutputRoot $Component
        $StateRoot = Join-Path $DataRoot 'state'
        New-Item -ItemType Directory -Path $StateRoot | Out-Null
        $Stem = if ($Component -eq 'proxy') { 'codex-app-server-proxy' } else { 'task-router' }
        $ScriptStem = if ($Component -eq 'proxy') { 'codex-app-server-proxy' } else { 'napcat-task-router' }
        $MarkerPath = Join-Path $StateRoot ($Stem + '.stop')
        $RuntimePath = Join-Path $StateRoot ($Stem + '-runtime.json')
        $LockPath = Join-Path $StateRoot ($Stem + '.lock')
        $FixturePath = Join-Path $FixtureRoot ($Stem + '-runner.mjs')
        $FixtureArguments = @($FixturePath, '--runtime-state', $RuntimePath, '--stop-file', $MarkerPath, '--lock', $LockPath)
        $FixtureLine = ($FixtureArguments | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $Service = Start-Process -FilePath $NodePath -ArgumentList $FixtureLine -WindowStyle Hidden -PassThru
        $Lease = $null
        try {
            $Deadline = [DateTime]::UtcNow.AddSeconds(8)
            while (-not (Test-Path -LiteralPath $RuntimePath) -and [DateTime]::UtcNow -lt $Deadline) { Start-Sleep -Milliseconds 50 }
            Assert-Entry (Test-Path -LiteralPath $RuntimePath) ($Component + ': fixture started')
            $Attempt = 'entry-' + [guid]::NewGuid().ToString('N')
            $Lease = New-OwnedStopMarker -Path $MarkerPath -Component $Component -AttemptId $Attempt
            $Before = Assert-OwnedStopMarker -Lease $Lease -Path $MarkerPath -Component $Component -AttemptId $Attempt
            $ProofPath = Join-Path $DataRoot 'proof.json'
            [IO.File]::WriteAllText($ProofPath, (Export-OwnedStopMarkerProof -Lease $Lease -Path $MarkerPath -Component $Component -AttemptId $Attempt), $Utf8)
            $StopArgs = @('-DataRoot', $DataRoot, '-StopMarkerProofPath', $ProofPath, '-StopMarkerAttemptId', $Attempt, '-StopMarkerOperationId', $Lease.OperationId)
            $Result = Invoke-Entry ('stop-' + $ScriptStem + '.ps1') $StopArgs
            Assert-Entry ($Result.exitCode -eq 0) ($Component + ': real stop helper accepts held proof')
            $Reply = $Result.stdout | ConvertFrom-Json
            Assert-Entry ($Reply.stopped -eq $true -and $Reply.ownedStopMarker.FileId -eq $Before.FileId) ($Component + ': stop reports same file identity')
            Assert-Entry ($Service.WaitForExit(3000) -and $Service.ExitCode -eq 0) ($Component + ': fixture exits normally')
            $After = Assert-OwnedStopMarker -Lease $Lease -Path $MarkerPath -Component $Component -AttemptId $Attempt
            Assert-Entry ($After.RecordSha256 -eq $Before.RecordSha256) ($Component + ': child leaves held bytes unchanged')
            $BadArgs = @('-DataRoot', $DataRoot, '-StopMarkerProofPath', $ProofPath, '-StopMarkerAttemptId', 'wrong-attempt', '-StopMarkerOperationId', $Lease.OperationId)
            $Bad = Invoke-Entry ('stop-' + $ScriptStem + '.ps1') $BadArgs
            Assert-Entry ($Bad.exitCode -ne 0) ($Component + ': wrong attempt refused')
            $AfterBad = Assert-OwnedStopMarker -Lease $Lease -Path $MarkerPath -Component $Component -AttemptId $Attempt
            Assert-Entry ($AfterBad.RecordSha256 -eq $Before.RecordSha256) ($Component + ': refusal preserves held object')
            $HeldStart = Invoke-Entry ('start-' + $ScriptStem + '.ps1') @('-DataRoot', $DataRoot, '-RequireNoStopMarker')
            Assert-Entry ($HeldStart.exitCode -ne 0 -and $HeldStart.stderr.Contains('EXISTING_STOP_REQUIREMENT_PRESERVED')) ($Component + ': start preserves unconsumed stop')
            $Consumed = Consume-OwnedStopMarker -Lease $Lease -Path $MarkerPath -Component $Component -AttemptId $Attempt
            Assert-Entry ($Consumed.DispositionApplied -and -not (Test-Path -LiteralPath $MarkerPath)) ($Component + ': owner consumes exact file')
            [IO.File]::WriteAllText($MarkerPath, 'new-independent-stop', $Utf8)
            $NewHash = (Get-FileHash -LiteralPath $MarkerPath -Algorithm SHA256).Hash
            $NewStart = Invoke-Entry ('start-' + $ScriptStem + '.ps1') @('-DataRoot', $DataRoot, '-RequireNoStopMarker')
            Assert-Entry ($NewStart.exitCode -ne 0 -and $NewStart.stderr.Contains('EXISTING_STOP_REQUIREMENT_PRESERVED')) ($Component + ': start refuses new independent stop')
            Assert-Entry ((Get-FileHash -LiteralPath $MarkerPath -Algorithm SHA256).Hash -eq $NewHash) ($Component + ': independent stop bytes preserved')
        } finally {
            if ($Lease -and $Lease.State -eq 'Held') { Close-OwnedStopMarker -Lease $Lease | Out-Null }
            if (-not $Service.HasExited -and -not (Test-Path -LiteralPath $MarkerPath)) { [IO.File]::WriteAllText($MarkerPath, 'fixture-cleanup', $Utf8) }
            $Exited = $Service.WaitForExit(21000)
            $Results.Add([pscustomobject]@{ name = $Component + ': owned fixture cleanup'; passed = $Exited; pid = $Service.Id })
            $Service.Dispose()
        }
    }
} catch { $Failure = $_.Exception.ToString() }
$Summary = [pscustomobject]@{ parentPowerShell = $PSVersionTable.PSVersion.ToString(); childPowerShellPath = $ChildPowerShellPath; sourceHashes = $Hashes; cases = @($Results.ToArray()); failure = $Failure; productionTouched = $false; fullOfficialRunnerChain = $false }
[IO.File]::WriteAllText((Join-Path $OutputRoot 'results.json'), ($Summary | ConvertTo-Json -Depth 12), $Utf8)
[pscustomobject]@{ outputRoot = $OutputRoot; passed = @($Results | Where-Object passed).Count; total = $Results.Count; failure = $Failure } | ConvertTo-Json -Depth 4
if ($Failure -or @($Results | Where-Object { -not $_.passed }).Count) { exit 1 }
