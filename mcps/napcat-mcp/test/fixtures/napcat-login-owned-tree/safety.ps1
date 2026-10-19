param([string]$SourcePath, [string]$NodePath, [string]$FixtureRoot, [string]$RunId, [switch]$LockHolder)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$FixtureRoot = [IO.Path]::GetFullPath($FixtureRoot)
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($RunId -notmatch '^[a-f0-9]{32}$' -or -not $FixtureRoot.StartsWith($TempRoot, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path -Leaf $FixtureRoot).Contains($RunId)) { throw 'Unsafe fixture root' }
$SourceHash = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash
$Tokens = $null
$ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count -ne 0) { throw 'Login source did not parse' }
. (Join-Path (Split-Path -Parent $SourcePath) 'napcat-quick-login-credential.ps1')
foreach ($Name in @('Initialize-QqPathIdentityApi', 'Get-NormalizedQqPath', 'Get-QqLoginLockName', 'New-NapCatLoginAttemptLock', 'Release-NapCatLoginAttemptLock', 'Clear-InheritedQuickLoginEnvironment', 'Write-DisabledQuickLoginMarker', 'Disable-QuickLoginCredential')) {
  $Definition = $Ast.Find({ param($Entry) $Entry -is [Management.Automation.Language.FunctionDefinitionAst] -and $Entry.Name -eq $Name }, $true)
  if ($null -eq $Definition) { throw "Missing source function: $Name" }
  . ([scriptblock]::Create($Definition.Extent.Text))
}
$Profile = Join-Path $FixtureRoot 'profile/QQ'
$FirstData = Join-Path $FixtureRoot 'first-data'
$SecondData = Join-Path $FixtureRoot 'second-data'
[IO.Directory]::CreateDirectory($Profile) | Out-Null
if ($LockHolder) {
  $Held = New-NapCatLoginAttemptLock -DataRoot $FirstData -NapCatRoot $FixtureRoot -ExpectedSelfId '900000001' -QqProfileRoot $Profile -NoQr
  try {
    [IO.File]::WriteAllText((Join-Path $FixtureRoot 'holder-ready'), [string]$PID)
    $Clock = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot 'release.request')) -and $Clock.Elapsed.TotalSeconds -lt 8) { Start-Sleep -Milliseconds 20 }
  } finally { Release-NapCatLoginAttemptLock $Held }
  exit 0
}
$Cases = [Collections.Generic.List[object]]::new()
$env:NAPCAT_QUICK_ACCOUNT = 'fixture-account'
$env:NAPCAT_QUICK_PASSWORD = 'fixture-password'
$env:NAPCAT_QUICK_PASSWORD_MD5 = 'fixture-md5'
$Info = [Diagnostics.ProcessStartInfo]::new($env:ComSpec)
$Info.UseShellExecute = $false
Clear-InheritedQuickLoginEnvironment $Info
$Clear = @('NAPCAT_QUICK_ACCOUNT', 'NAPCAT_QUICK_PASSWORD', 'NAPCAT_QUICK_PASSWORD_MD5') | Where-Object { $Info.EnvironmentVariables.ContainsKey($_) }
$Cases.Add([pscustomobject]@{ name='inherited_environment_cleared'; passed=(@($Clear).Count -eq 0 -and $env:NAPCAT_QUICK_PASSWORD -eq 'fixture-password') })
$CredentialDirectory = Join-Path $FixtureRoot 'credential'
[IO.Directory]::CreateDirectory($CredentialDirectory) | Out-Null
$CredentialPath = Join-Path $CredentialDirectory 'credential.json'
[IO.File]::WriteAllText($CredentialPath, 'fixture-credential-bytes')
$CredentialHash = (Get-FileHash -LiteralPath $CredentialPath -Algorithm SHA256).Hash
$Unused = Disable-QuickLoginCredential -CredentialPath $CredentialPath -Reason 'fixture-rejected' -FallbackUsed $false
$Cases.Add([pscustomobject]@{ name='fallback_unused_credential_preserved'; passed=(-not $Unused.disabled -and $Unused.reason -eq 'fallback_not_used' -and (Get-FileHash -LiteralPath $CredentialPath -Algorithm SHA256).Hash -eq $CredentialHash -and -not (Test-Path -LiteralPath (Join-Path $CredentialDirectory 'credential.disabled.json'))) })
$Used = Disable-QuickLoginCredential -CredentialPath $CredentialPath -Reason 'fixture-rejected' -FallbackUsed $true
$Marker = Get-Content -LiteralPath (Join-Path $CredentialDirectory 'credential.disabled.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Cases.Add([pscustomobject]@{ name='fallback_used_credential_disabled'; passed=($Used.disabled -and -not (Test-Path -LiteralPath $CredentialPath) -and (Get-FileHash -LiteralPath $Used.path -Algorithm SHA256).Hash -eq $CredentialHash -and $Marker.reason -eq 'fixture-rejected') })
$Runtime = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$HolderInfo = [Diagnostics.ProcessStartInfo]::new($Runtime)
$HolderInfo.UseShellExecute = $false
$HolderInfo.CreateNoWindow = $true
$HolderInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$HolderInfo.Arguments = (@('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-SourcePath', $SourcePath, '-FixtureRoot', $FixtureRoot, '-RunId', $RunId, '-LockHolder') | ForEach-Object { '"' + $_ + '"' }) -join ' '
$Holder = [Diagnostics.Process]::Start($HolderInfo)
try {
  $Wait = [Diagnostics.Stopwatch]::StartNew()
  while (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot 'holder-ready'))) {
    if ($Holder.HasExited -or $Wait.Elapsed.TotalSeconds -gt 5) { throw 'Profile lock fixture did not become ready' }
    Start-Sleep -Milliseconds 20
  }
  $Alias = Join-Path $Profile '../QQ'
  $AliasSame = (Get-QqLoginLockName $Alias) -ceq (Get-QqLoginLockName $Profile.ToUpperInvariant())
  $Blocked = $false
  $UnexpectedLock = $null
  try { $UnexpectedLock = New-NapCatLoginAttemptLock -DataRoot $SecondData -NapCatRoot $FixtureRoot -ExpectedSelfId '900000002' -QqProfileRoot $Alias -NoQr }
  catch { $Blocked = $_.Exception.Message -like '*NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS*' }
  finally { Release-NapCatLoginAttemptLock $UnexpectedLock }
  $Cases.Add([pscustomobject]@{ name='profile_mutex_blocks_other_data_root'; passed=($Blocked -and $AliasSame -and -not (Test-Path -LiteralPath $SecondData)); aliasUsesSameMutex=$AliasSame })
  $Blocked = $false
  $UnexpectedLock = $null
  $OtherProfile = Join-Path $FixtureRoot 'independent-profile/QQ'
  try { $UnexpectedLock = New-NapCatLoginAttemptLock -DataRoot $FirstData -NapCatRoot $FixtureRoot -ExpectedSelfId '900000001' -QqProfileRoot $OtherProfile -NoQr }
  catch { $Blocked = $_.Exception.Message -like '*NAPCAT_LOGIN_ATTEMPT_IN_PROGRESS*' }
  finally { Release-NapCatLoginAttemptLock $UnexpectedLock }
  $Cases.Add([pscustomobject]@{ name='account_file_lock_blocks_other_profile'; passed=$Blocked })
  $Independent = New-NapCatLoginAttemptLock -DataRoot $SecondData -NapCatRoot $FixtureRoot -ExpectedSelfId '900000002' -QqProfileRoot $OtherProfile -NoQr
  $IndependentPath = $Independent.Path
  Release-NapCatLoginAttemptLock $Independent
  $Cases.Add([pscustomobject]@{ name='independent_profile_allowed'; passed=(-not (Test-Path -LiteralPath $IndependentPath) -and -not $Holder.HasExited) })
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'release.request'), 'release')
  if (-not $Holder.WaitForExit(3000) -or $Holder.ExitCode -ne 0) { throw 'Lock holder did not release' }
  $Reacquired = New-NapCatLoginAttemptLock -DataRoot $FirstData -NapCatRoot $FixtureRoot -ExpectedSelfId '900000001' -QqProfileRoot $Profile -NoQr
  $ReacquiredPath = $Reacquired.Path
  Release-NapCatLoginAttemptLock $Reacquired
  $Cases.Add([pscustomobject]@{ name='profile_and_account_locks_reacquired_after_release'; passed=(-not (Test-Path -LiteralPath $ReacquiredPath)) })
} finally {
  if (-not $Holder.HasExited) { $Holder.Kill(); $null = $Holder.WaitForExit(2000) }
  $Holder.Dispose()
}
$SourceUnchanged = (Get-FileHash -LiteralPath $SourcePath -Algorithm SHA256).Hash -eq $SourceHash
[pscustomobject]@{ runtime=$PSVersionTable.PSVersion.ToString(); sourceSha256=$SourceHash; sourceUnchanged=$SourceUnchanged; runId=$RunId; cases=@($Cases.ToArray()); productionProcessActions=0 } | ConvertTo-Json -Depth 8
if (@($Cases | Where-Object { -not $_.passed }).Count -gt 0 -or -not $SourceUnchanged) { exit 1 }
