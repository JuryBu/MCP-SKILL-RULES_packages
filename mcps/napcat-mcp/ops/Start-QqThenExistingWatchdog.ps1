[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PlanPath,
  [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$PlanSha256
)
$ErrorActionPreference='Stop'
if ($PSVersionTable.PSVersion.Major -ne 7 -or $PSVersionTable.PSEdition -cne 'Core') {throw 'QQ_STARTUP_POWERSHELL7_REQUIRED'}
if ((Get-ExecutionPolicy -Scope Process) -cne 'Undefined' -or (Get-ExecutionPolicy) -cnotin @('RemoteSigned','AllSigned','Unrestricted')) {throw 'QQ_STARTUP_ORDINARY_POLICY_REQUIRED'}
if ((Get-FileHash -LiteralPath $PlanPath -Algorithm SHA256).Hash -ine $PlanSha256) {throw 'STARTUP_ATTACHMENT_PLAN_DRIFT'}
$Plan=Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Plan.schema -cne 'qq.fixed-ps7-startup/v1' -or $Plan.state -cne 'active') {throw 'STARTUP_ATTACHMENT_NOT_ACTIVE'}
if ([IO.Path]::GetFullPath($Plan.ps7Path) -ine [IO.Path]::GetFullPath([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)) {throw 'QQ_STARTUP_RUNTIME_IDENTITY_CHANGED'}
foreach ($File in $Plan.inputs) {
  if (-not [IO.Path]::IsPathRooted([string]$File.path) -or (Get-FileHash -LiteralPath $File.path -Algorithm SHA256).Hash -ine $File.sha256) {throw 'STARTUP_ATTACHMENT_INPUT_DRIFT'}
}
function Invoke-StartupChild {
  param([string[]]$Arguments,[switch]$Capture)
  $Start=[Diagnostics.ProcessStartInfo]::new()
  $Start.FileName=$Plan.ps7Path
  $Start.UseShellExecute=$false
  $Start.CreateNoWindow=$true
  $Start.WindowStyle=[Diagnostics.ProcessWindowStyle]::Hidden
  $Start.WorkingDirectory=$Plan.workingDirectory
  $Start.Environment.Remove('PSModulePath') | Out-Null
  $Start.Environment['CODEX_TOOLKIT_NODE_EXE']=$Plan.nodePath
  $Start.Environment['CODEX_REAL_NODE_EXE']=$Plan.nodePath
  foreach ($Argument in $Arguments) {$Start.ArgumentList.Add($Argument)}
  $Start.RedirectStandardOutput=[bool]$Capture
  $Start.RedirectStandardError=[bool]$Capture
  $Child=[Diagnostics.Process]::Start($Start)
  try {
    if ($Capture) {$Output=$Child.StandardOutput.ReadToEndAsync();$ErrorText=$Child.StandardError.ReadToEndAsync()}
    $Child.WaitForExit()
    return [pscustomobject]@{exitCode=$Child.ExitCode;stdout=$(if($Capture){$Output.GetAwaiter().GetResult()}else{''});stderr=$(if($Capture){$ErrorText.GetAwaiter().GetResult()}else{''})}
  } finally {$Child.Dispose()}
}
$RecoveryArguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$Plan.recoveryPath,'-AccountRoot',$Plan.accountRoot,'-ExpectedAccountId',$Plan.accountId,'-LoginScriptPath',$Plan.loginPath,'-LoginScriptSha256',$Plan.loginSha256,'-RouterScriptPath',$Plan.routerPath,'-RouterScriptSha256',$Plan.routerSha256,'-NodeExePath',$Plan.nodePath,'-TriggerSource','logon')
$RecoveryState='unverified'
try {
  $Recovered=Invoke-StartupChild -Arguments $RecoveryArguments -Capture
  if ($Recovered.exitCode -eq 0) {
    $Parsed=$Recovered.stdout | ConvertFrom-Json
    if ($Parsed.ok -is [bool] -and $Parsed.ok -and [string]$Parsed.account -ceq [string]$Plan.accountId) {$RecoveryState='verified'}
  }
} catch {$RecoveryState='failed'}
if ($RecoveryState -cne 'verified') {Write-Warning 'QQ recovery requires attention; existing watchdog startup remains available. See the account startup history.'}
$WatchdogArguments=@('-NoLogo','-NoProfile','-NonInteractive','-File',$Plan.watchdogPath,'-DataRoot',$Plan.accountRoot,'-BrokerRoot',$Plan.brokerRoot)
$Watchdog=Invoke-StartupChild -Arguments $WatchdogArguments
exit $Watchdog.exitCode
