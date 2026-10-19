param([string]$SourcePath, [string]$NodePath, [string]$FixtureRoot, [string]$RunId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($RunId -notmatch '^[a-f0-9]{32}$' -or -not $FixtureRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or -not $FixtureRoot.Contains($RunId)) { throw 'Unsafe fixture root' }
$SourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
$HelperPath = Join-Path $FixtureRoot 'helper.cjs'
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'helper.cjs') -Destination $HelperPath
$global:FixtureMockCalls = 0
function Invoke-RestMethod {
  param($Method, $Uri, $Headers, $ContentType, $Body, $TimeoutSec)
  if (-not ([string]$Uri).StartsWith('http://127.0.0.1:1/')) { throw 'Unexpected fixture HTTP endpoint' }
  $global:FixtureMockCalls++
  if (([string]$Uri).EndsWith('/get_status')) {
    $Ready = Test-Path -LiteralPath (Join-Path $global:FixtureCaseRoot 'helper-ready')
    $Online = $global:FixtureScenario -eq 'already_online' -or ($Ready -and $global:FixtureScenario -in @('normal', 'wrong_account'))
    return [pscustomobject]@{ status='ok'; data=[pscustomobject]@{ online=[bool]$Online; good=[bool]$Online } }
  }
  if (([string]$Uri).EndsWith('/get_login_info')) {
    $Account = if ($global:FixtureScenario -eq 'wrong_account') { '900000002' } else { '900000001' }
    return [pscustomobject]@{ status='ok'; data=[pscustomobject]@{ user_id=$Account; nickname='fixture' } }
  }
  throw 'Unexpected fixture OneBot action'
}
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position=0)][string]$ClassName, [string]$Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected fixture CIM class' }
  $All = @(CimCmdlets\Get-CimInstance Win32_Process -ErrorAction Stop)
  $Owned = @{}
  foreach ($Entry in $All) {
    if ($Entry.ProcessId -ne $PID -and ([string]$Entry.CommandLine).IndexOf($global:FixtureCaseRoot + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) { $Owned[[int]$Entry.ProcessId] = $true }
  }
  do {
    $Changed = $false
    foreach ($Entry in $All) {
      if ($Entry.ProcessId -ne $PID -and $Owned.ContainsKey([int]$Entry.ParentProcessId) -and -not $Owned.ContainsKey([int]$Entry.ProcessId)) { $Owned[[int]$Entry.ProcessId] = $true; $Changed = $true }
    }
  } while ($Changed)
  $Selected = @($All | Where-Object { $Owned.ContainsKey([int]$_.ProcessId) })
  if ($Filter) {
    if ($Filter -notmatch '^ProcessId\s*=\s*(\d+)$') { throw 'Unexpected fixture CIM filter' }
    $TargetId = [int]$Matches[1]
    return @($Selected | Where-Object { [int]$_.ProcessId -eq $TargetId })
  }
  return $Selected
}
$Cases = [Collections.Generic.List[object]]::new()
$env:NAPCAT_QUICK_ACCOUNT = 'inherited-fixture-account'
$env:NAPCAT_QUICK_PASSWORD = 'inherited-fixture-password'
$env:NAPCAT_QUICK_PASSWORD_MD5 = 'inherited-fixture-md5'
foreach ($Scenario in @('already_online', 'normal', 'wrong_account', 'no_qr')) {
  $global:FixtureScenario = $Scenario
  $global:FixtureCaseRoot = Join-Path $FixtureRoot $Scenario
  $Data = Join-Path $global:FixtureCaseRoot 'data'
  $Broker = Join-Path $global:FixtureCaseRoot 'broker'
  $Runtime = Join-Path $global:FixtureCaseRoot 'runtime'
  $Profile = Join-Path $global:FixtureCaseRoot 'profile/QQ'
  foreach ($Directory in @($Data, $Broker, $Runtime, $Profile, (Join-Path $Data 'private/napcat-login'))) { [IO.Directory]::CreateDirectory($Directory) | Out-Null }
  [IO.File]::WriteAllText((Join-Path $Data 'binding.json'), '{"expectedSelfId":"900000001","expectedNickname":"fixture"}')
  [IO.File]::WriteAllText((Join-Path $Broker 'broker-private.env.json'), '{"NAPCAT_HTTP_URL":"http://127.0.0.1:1","NAPCAT_ACCESS_TOKEN":"fixture-no-network"}')
  [IO.File]::WriteAllText((Join-Path $Runtime 'napcat.mjs'), 'fixture-not-executed')
  $CredentialPath = Join-Path $Data 'private/napcat-login/credential.json'
  [IO.File]::WriteAllText($CredentialPath, 'fixture-unused-credential')
  $CredentialHash = (Get-FileHash -LiteralPath $CredentialPath -Algorithm SHA256).Hash
  $Launcher = '@echo off' + [Environment]::NewLine + '"' + $NodePath + '" "' + $HelperPath + '" ' + $RunId + ' "' + $global:FixtureCaseRoot + '" entry_' + $Scenario + [Environment]::NewLine
  [IO.File]::WriteAllText((Join-Path $Runtime 'launcher-user.bat'), $Launcher)
  $Clock = [Diagnostics.Stopwatch]::StartNew()
  $Failure = $null
  $Result = $null
  try {
    $Output = & $SourcePath -NapCatRoot $Runtime -DataRoot $Data -BrokerRoot $Broker -CodexHome (Join-Path $global:FixtureCaseRoot 'codex') -QqUserDataDir $Profile -TimeoutSeconds 30 -NoQr -NoPasswordFallback
    $Result = $Output | ConvertFrom-Json
  } catch { $Failure = $_.Exception.Message }
  $EntryElapsed = $Clock.Elapsed.TotalMilliseconds
  $RemainingAtReturn = @(Get-CimInstance Win32_Process)
  $Wait = [Diagnostics.Stopwatch]::StartNew()
  do {
    $Remaining = @(Get-CimInstance Win32_Process)
    if ($Remaining.Count -gt 0) { Start-Sleep -Milliseconds 30 }
  } while ($Remaining.Count -gt 0 -and $Wait.Elapsed.TotalSeconds -lt 5)
  $LockReleased = -not (Test-Path -LiteralPath (Join-Path $Data 'state/napcat-login-attempt-900000001.lock'))
  $CredentialPreserved = (Get-FileHash -LiteralPath $CredentialPath -Algorithm SHA256).Hash -eq $CredentialHash -and -not (Test-Path -LiteralPath (Join-Path $Data 'private/napcat-login/credential.disabled.json'))
  $EnvironmentClean = $true
  if ($Scenario -ne 'already_online') {
    $EnvironmentRecord = Get-Content -LiteralPath (Join-Path $global:FixtureCaseRoot 'environment.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $EnvironmentClean = @($EnvironmentRecord.PSObject.Properties | Where-Object { $_.Value }).Count -eq 0
  }
  $Passed = if ($Scenario -eq 'already_online') { $null -eq $Failure -and $Result.state -eq 'already_online' -and -not $Result.launched -and -not (Test-Path -LiteralPath (Join-Path $global:FixtureCaseRoot 'helper-ready')) }
    elseif ($Scenario -eq 'normal') { $null -eq $Failure -and $Result.state -eq 'online' -and $Result.launched }
    elseif ($Scenario -eq 'wrong_account') { $Failure -match '900000002' -and $RemainingAtReturn.Count -eq 0 }
    else { $Failure -like '*NAPCAT_MANUAL_LOGIN_REQUIRED*' -and $RemainingAtReturn.Count -eq 0 }
  $Cases.Add([pscustomobject]@{ name=$Scenario; passed=($Passed -and $LockReleased -and $CredentialPreserved -and $EnvironmentClean -and $Remaining.Count -eq 0 -and $EntryElapsed -lt 10000); elapsedMs=$EntryElapsed; result=$Result; error=$Failure; lockReleased=$LockReleased; unusedCredentialPreserved=$CredentialPreserved; inheritedCredentialsCleared=$EnvironmentClean; remainingAtReturn=$RemainingAtReturn.Count; ownRemainingCount=$Remaining.Count })
}
$SourceUnchanged = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash -eq $SourceHash
[pscustomobject]@{ runtime=$PSVersionTable.PSVersion.ToString(); sourceSha256=$SourceHash; sourceUnchanged=$SourceUnchanged; sourceExecutedUnmodified=$true; runId=$RunId; cases=@($Cases.ToArray()); mockOneBotCalls=$global:FixtureMockCalls; realHttpCalls=0; productionProcessActions=0 } | ConvertTo-Json -Depth 10
if (@($Cases | Where-Object { -not $_.passed }).Count -gt 0 -or -not $SourceUnchanged) { exit 1 }
