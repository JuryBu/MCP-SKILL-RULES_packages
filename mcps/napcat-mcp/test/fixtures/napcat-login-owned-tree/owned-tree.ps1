param([string]$SourcePath, [string]$NodePath, [string]$FixtureRoot, [string]$RunId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($RunId -notmatch '^[a-f0-9]{32}$' -or -not $FixtureRoot.StartsWith($TempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path -Leaf $FixtureRoot).Contains($RunId)) { throw 'Unsafe fixture root' }
$SourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
$HelperPath = Join-Path $FixtureRoot 'helper.cjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'helper.cjs') -Destination $HelperPath
$Tokens = $null
$ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -ne 0) { throw 'Login source did not parse' }
foreach ($Name in @('Initialize-QqPathIdentityApi', 'Get-NormalizedQqPath', 'Get-NapCatCreationStamp', 'New-NapCatOwnedRecord', 'New-NapCatOwnedTree', 'Update-NapCatOwnedTree', 'Stop-NapCatOwnedTree', 'Close-NapCatOwnedTree')) {
  $Definition = $Ast.Find({ param($Entry) $Entry -is [Management.Automation.Language.FunctionDefinitionAst] -and $Entry.Name -eq $Name }, $true)
  if ($null -eq $Definition) { throw "Missing source function: $Name" }
  . ([scriptblock]::Create($Definition.Extent.Text))
}
function Test-FixtureProcess {
  param($Entry)
  return [string]$Entry.ExecutablePath -ieq $NodePath -and ([string]$Entry.CommandLine).Contains($HelperPath) -and ([string]$Entry.CommandLine).Contains($RunId)
}
$Provider = { @(CimCmdlets\Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object { Test-FixtureProcess $_ }) }
$Verifier = { param($Entry) Test-FixtureProcess $Entry }
function Start-FixtureProcess {
  param([string]$Directory, [string]$Scenario, [int]$Level = 0)
  [IO.Directory]::CreateDirectory($Directory) | Out-Null
  $Info = [Diagnostics.ProcessStartInfo]::new($NodePath)
  $Info.UseShellExecute = $false
  $Info.CreateNoWindow = $true
  $Info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $Info.Arguments = (@($HelperPath, $RunId, $Directory, $Scenario, [string]$Level) | ForEach-Object { '"' + $_ + '"' }) -join ' '
  $Created = [Diagnostics.Process]::Start($Info)
  $Snapshot = [pscustomobject]@{ ProcessId=$Created.Id; ParentProcessId=$PID; CreationDate=$Created.StartTime.ToUniversalTime(); ExecutablePath=$NodePath; CommandLine=('"' + $NodePath + '" ' + $Info.Arguments) }
  return [pscustomobject]@{ process=$Created; snapshot=$Snapshot }
}
function Wait-FixtureFile {
  param([string]$Path)
  $Clock = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath $Path)) {
    if ($Clock.Elapsed.TotalSeconds -gt 4) { throw "Fixture startup timed out: $Path" }
    Start-Sleep -Milliseconds 15
  }
}
$Cases = [Collections.Generic.List[object]]::new()
$Contexts = [Collections.Generic.List[object]]::new()
$Sibling = Start-FixtureProcess (Join-Path $FixtureRoot 'sibling') 'sibling' 9
$SiblingContext = New-NapCatOwnedTree $Sibling.process $Sibling.snapshot $Provider $Verifier
$Contexts.Add($SiblingContext)
Wait-FixtureFile (Join-Path $FixtureRoot 'sibling/level-9.json')
try {
  foreach ($Scenario in @('normal', 'root_exit', 'spawn_during_cleanup', 'partial_failure')) {
    $Directory = Join-Path $FixtureRoot $Scenario
    $Started = Start-FixtureProcess $Directory $Scenario
    $Context = New-NapCatOwnedTree $Started.process $Started.snapshot $Provider $Verifier
    $Contexts.Add($Context)
    Wait-FixtureFile (Join-Path $Directory $(if ($Scenario -eq 'spawn_during_cleanup') { 'level-1.json' } else { 'level-2.json' }))
    Update-NapCatOwnedTree $Context
    if ($Scenario -eq 'root_exit') {
      [IO.File]::WriteAllText((Join-Path $Directory 'root-exit.request'), 'go')
      if (-not $Started.process.WaitForExit(2000)) { throw 'Root did not exit' }
    }
    $RootExited = $Started.process.HasExited
    $BeforeTerminate = { param($Record) }
    if ($Scenario -eq 'spawn_during_cleanup') {
      $BeforeTerminate = { param($Record) if ($Record.processId -eq $Context.rootId) { [IO.File]::WriteAllText((Join-Path $Directory 'spawn.request'), 'go'); Wait-FixtureFile (Join-Path $Directory 'level-2.json') } }
    }
    if ($Scenario -eq 'partial_failure') {
      $BeforeTerminate = { param($Record) if ($Record.parentId -eq $Context.rootId) { throw 'fixture_termination_denied' } }
    }
    $Result = Stop-NapCatOwnedTree $Context -TimeoutMilliseconds 2000 -BeforeTerminate $BeforeTerminate
    $SiblingAlive = -not $Sibling.process.HasExited
    $ExpectedState = if ($Scenario -eq 'partial_failure') { 'unknown' } else { 'terminated' }
    $Passed = $Result.state -eq $ExpectedState -and $Result.captured -ge 3 -and $SiblingAlive
    if ($Scenario -eq 'root_exit') { $Passed = $Passed -and $RootExited }
    if ($Scenario -eq 'partial_failure') {
      $Passed = $Passed -and @($Result.problems | Where-Object { $_ -like '*fixture_termination_denied*' }).Count -gt 0 -and $Result.remaining.Count -gt 0
      $Final = Stop-NapCatOwnedTree $Context -TimeoutMilliseconds 1500
      $Passed = $Passed -and $Final.remaining.Count -eq 0
    } else { $Passed = $Passed -and $Result.remaining.Count -eq 0 }
    Close-NapCatOwnedTree $Context
    $Disposed = @($Context.records.Values | Where-Object { -not $_.disposed -or -not $_.handle.IsClosed }).Count -eq 0
    $Cases.Add([pscustomobject]@{ name=$Scenario; passed=($Passed -and $Disposed); rootExitedBeforeCleanup=$RootExited; siblingAlive=$SiblingAlive; handlesDisposed=$Disposed; result=$Result })
  }
} finally {
  foreach ($Context in $Contexts) {
    if (-not $Context.disposed) { $null = Stop-NapCatOwnedTree $Context -TimeoutMilliseconds 1500; Close-NapCatOwnedTree $Context }
  }
}
$Remaining = @(& $Provider)
$SourceUnchanged = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash -eq $SourceHash
[pscustomobject]@{ runtime=$PSVersionTable.PSVersion.ToString(); sourceSha256=$SourceHash; sourceUnchanged=$SourceUnchanged; runId=$RunId; cases=@($Cases.ToArray()); ownRemainingCount=$Remaining.Count; allTrackedHandlesDisposed=@($Contexts | Where-Object { -not $_.disposed }).Count -eq 0; productionProcessActions=0 } | ConvertTo-Json -Depth 12
if (@($Cases | Where-Object { -not $_.passed }).Count -gt 0 -or $Remaining.Count -ne 0 -or -not $SourceUnchanged) { exit 1 }
