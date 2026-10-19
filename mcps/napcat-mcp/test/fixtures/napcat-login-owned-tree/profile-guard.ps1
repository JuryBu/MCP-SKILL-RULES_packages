param([string]$SourcePath, [string]$NodePath, [string]$FixtureRoot, [string]$RunId)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if ($RunId -notmatch '^[a-f0-9]{32}$' -or -not $FixtureRoot.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase) -or -not $FixtureRoot.Contains($RunId)) { throw 'Unsafe fixture root' }
$SourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
. (Join-Path (Split-Path -Parent $SourcePath) 'napcat-process-identity.ps1')
$Tokens = $null
$ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -ne 0) { throw 'Login source did not parse' }
foreach ($Definition in @($Ast.FindAll({ param($Entry) $Entry -is [Management.Automation.Language.FunctionDefinitionAst] -and $Entry.Parent -isnot [Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
  . ([scriptblock]::Create($Definition.Extent.Text))
}
$ExpectedSelfId = '900000001'
$ExpectedNickname = 'fixture'
$NapCatRoot = Join-Path $FixtureRoot 'runtime'
$QqUserDataDir = Join-Path $FixtureRoot 'profile/QQ'
$QqExePath = Join-Path $FixtureRoot 'QQ.exe'
$script:Online = $false
$script:SnapshotFailure = $false
$script:FixtureProcesses = @()
function Invoke-OneBot {
  param($Action)
  if ($Action -eq 'get_status') { return [pscustomobject]@{ status='ok'; data=[pscustomobject]@{ online=$script:Online; good=$script:Online } } }
  if ($Action -eq 'get_login_info') { return [pscustomobject]@{ status='ok'; data=[pscustomobject]@{ user_id='900000001'; nickname='fixture' } } }
  throw 'Unexpected fixture OneBot action'
}
function Get-NapCatOwnershipSnapshot {
  if ($script:SnapshotFailure) { throw 'fixture inspection unavailable' }
  return $script:FixtureProcesses
}
function Get-CimInstance {
  [CmdletBinding()]
  param([Parameter(Position=0)][string]$ClassName, [string]$Filter)
  if ($ClassName -ne 'Win32_Process') { throw 'Unexpected fixture CIM class' }
  return @(Get-NapCatOwnershipSnapshot)
}
function New-FixtureQq {
  param([string]$Profile)
  return [pscustomobject]@{ ProcessId=900001; ParentProcessId=900000; Name='QQ.exe'; ExecutablePath=$QqExePath; CommandLine=('"' + $QqExePath + '" --user-data-dir="' + $Profile + '"'); CreationDate='2026-10-19T00:00:00Z'; ModuleScanState='ok'; ModulePaths=@('C:\Windows\System32\ntdll.dll') }
}
$script:OrdinaryStopCalls = 0
function Stop-NapCatVerifiedProcesses {
  param($Processes, $NapCatRoot)
  $script:OrdinaryStopCalls++
  throw 'Fixture forbids stopping ordinary QQ'
}
function Stop-Process {
  [CmdletBinding()]
  param($Id, $Name, [switch]$Force)
  $script:OrdinaryStopCalls++
  throw 'Fixture forbids stopping ordinary QQ'
}
$Cases = [Collections.Generic.List[object]]::new()
$script:FixtureProcesses = @(New-FixtureQq $QqUserDataDir)
$Failure = $null
$Allowed = $false
try { $Result = Get-LockedQqLoginState -UserDataDir $QqUserDataDir; $Allowed = $null -eq $Result }
catch { $Failure = $_.Exception.Message }
$Cases.Add([pscustomobject]@{ name='verified_ordinary_qq_same_profile_allows_preflight_without_stop'; passed=($Allowed -and $null -eq $Failure -and $script:OrdinaryStopCalls -eq 0); launchPreflightAllowed=$Allowed; ordinaryStopCalls=$script:OrdinaryStopCalls; error=$Failure })
$script:FixtureProcesses = @(New-FixtureQq (Join-Path $FixtureRoot 'other-profile/QQ'))
$Failure = $null
$Allowed = $false
try { $Result = Get-LockedQqLoginState -UserDataDir $QqUserDataDir; $Allowed = $null -eq $Result }
catch { $Failure = $_.Exception.Message }
$Cases.Add([pscustomobject]@{ name='confirmed_other_profile_allows_launch'; passed=($Allowed -and $null -eq $Failure); error=$Failure })
$script:SnapshotFailure = $true
$Failure = $null
try { $null = Get-LockedQqLoginState -UserDataDir $QqUserDataDir }
catch { $Failure = $_.Exception.Message }
$Cases.Add([pscustomobject]@{ name='inspection_failure_blocks_launch'; passed=($Failure -match 'NAPCAT_PROCESS_(SCAN|STATE)_UNKNOWN'); error=$Failure })
$script:Online = $true
$Result = Get-LockedQqLoginState -UserDataDir $QqUserDataDir
$Cases.Add([pscustomobject]@{ name='newly_online_account_reused_before_inspection'; passed=($Result.userId -eq $ExpectedSelfId) })
$SourceUnchanged = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash -eq $SourceHash
[pscustomobject]@{ runtime=$PSVersionTable.PSVersion.ToString(); sourceSha256=$SourceHash; sourceUnchanged=$SourceUnchanged; runId=$RunId; cases=@($Cases.ToArray()); realHttpCalls=0; productionProcessActions=0 } | ConvertTo-Json -Depth 8
if (@($Cases | Where-Object { -not $_.passed }).Count -gt 0 -or -not $SourceUnchanged) { exit 1 }
