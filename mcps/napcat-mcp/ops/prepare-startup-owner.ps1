[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceRoot,
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$ServiceRoot,
  [Parameter(Mandatory)][string]$DataRoot,
  [Parameter(Mandatory)][string]$BrokerRoot,
  [Parameter(Mandatory)][string]$NapCatRoot,
  [Parameter(Mandatory)][string]$QqExePath,
  [Parameter(Mandatory)][string]$NodePath,
  [Parameter(Mandatory)][string]$CodexExecutablePath,
  [ValidatePattern('^[a-z0-9-]*$')][string]$EntrySuffix=''
)
$ErrorActionPreference='Stop'
$DataRoot=[IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
$Utf8=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$Utf8
function Sha([string]$Path) {(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()}
$ManifestPath=Join-Path $PackageRoot 'manifest.json'
$Manifest=Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Manifest.mode -cne 'ManualProduction' -or $Manifest.targetRoot -ine [IO.Path]::GetFullPath($ServiceRoot).TrimEnd('\')) {throw 'PREPARED_PACKAGE_BINDING_CHANGED'}
$ConfigurationPath=Join-Path $PackageRoot ('owner-configuration'+$EntrySuffix+'.json')
$OwnerEntry=Join-Path $PackageRoot ('owner-entry'+$EntrySuffix+'.ps1')
if ((Test-Path -LiteralPath $ConfigurationPath) -or (Test-Path -LiteralPath $OwnerEntry)) {throw 'OWNER_ENTRY_ALREADY_PREPARED'}
$StopOps=Join-Path $PackageRoot 'recovery\ops'
[IO.Directory]::CreateDirectory($StopOps) | Out-Null
foreach ($Name in @('owned-stop-marker.ps1','stop-codex-app-server-proxy.ps1','resolve-napcat-data-root.ps1')) {
  $Source=Join-Path $SourceRoot ('ops\'+$Name)
  $Destination=Join-Path $StopOps $Name
  if (Test-Path -LiteralPath $Destination) {if ((Sha $Destination) -cne (Sha $Source)) {throw 'RECOVERY_SOURCE_CHANGED'}} else {[IO.File]::Copy($Source,$Destination,$false)}
}
$Wrapper=Get-Content -LiteralPath (Join-Path $SourceRoot 'ops\continue-startup-repair.ps1') -Raw -Encoding UTF8
[IO.File]::WriteAllText($OwnerEntry,$Wrapper,[Text.UTF8Encoding]::new($true))
$ServiceOps=Join-Path $ServiceRoot 'ops'
$Task=Get-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'
if (@($Task.Actions).Count -ne 1) {throw 'WATCHDOG_ACTION_COUNT_CHANGED'}
[IO.File]::WriteAllText((Join-Path $PackageRoot 'original-watchdog.xml'),(Export-ScheduledTask -TaskName 'CodexNapCatSupervisor' -TaskPath '\'),$Utf8)
$Stop=Join-Path $DataRoot 'state\supervisor.stop'
$Pins=@()
  $OwnerShell=if($Manifest.ownerPowerShell){$Manifest.ownerPowerShell}else{[pscustomobject]@{path=(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe');sha256=(Sha (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'));major=5;edition='Desktop'}}
if ($OwnerShell.sha256 -and (Sha $OwnerShell.path) -cne $OwnerShell.sha256) {throw 'OWNER_POWERSHELL_IDENTITY_CHANGED'}
$Pins+=@{path=$OwnerShell.path;sha256=(Sha $OwnerShell.path)}
foreach ($Path in @($NodePath,$CodexExecutablePath,(Join-Path $PackageRoot 'repair-files.ps1'),(Join-Path $StopOps 'owned-stop-marker.ps1'),(Join-Path $StopOps 'stop-codex-app-server-proxy.ps1'),(Join-Path $StopOps 'resolve-napcat-data-root.ps1'),(Join-Path $ServiceOps 'start-codex-model-stream-proxy.ps1'),(Join-Path $ServiceOps 'start-napcat-task-router.ps1'),(Join-Path $ServiceOps 'start-napcat-supervisor.ps1'),(Join-Path $ServiceOps 'resolve-napcat-data-root.ps1'),(Join-Path $ServiceOps 'Run-NapCatSupervisorWatchdog.ps1'),(Join-Path $ServiceOps 'Run-HiddenPowerShell.vbs'))) {
  if ($Path -iin @($Manifest.files | ForEach-Object targetPath)) {continue}
  $Pins+=@{path=$Path;sha256=(Sha $Path)}
}
$Configuration=[ordered]@{schemaVersion=1;mode='ManualProduction';ownerEntrySha256=(Sha $OwnerEntry);ownerPowerShell=$OwnerShell;fileEntry=(Join-Path $PackageRoot 'repair-files.ps1');manifestPath=$ManifestPath;manifestSha256=(Sha $ManifestPath);serviceOps=$ServiceOps;stopOps=$StopOps;dataRoot=$DataRoot;brokerRoot=$BrokerRoot;napCatRoot=$NapCatRoot;qqExePath=$QqExePath;nodePath=$NodePath;codexExecutablePath=$CodexExecutablePath;supervisorStopSha256=if(Test-Path -LiteralPath $Stop){Sha $Stop}else{$null};watchdogExecute=$Task.Actions[0].Execute;watchdogArguments=$Task.Actions[0].Arguments;originalWatchdogEnabled=$Task.Settings.Enabled;pins=$Pins}
$Configuration['upgradeScope']=if($Manifest.scope){$Manifest.scope}else{'startup-notification-only'}
if ($Configuration.upgradeScope -cnotin @('startup-notification-only','full-runtime-and-startup')) {throw 'OWNER_UPGRADE_SCOPE_INVALID'}
if ($Manifest.taskUpgrade) {
  $TaskHelper=Join-Path $StopOps 'startup-task-transaction.ps1'
  [IO.File]::Copy((Join-Path $SourceRoot 'ops\startup-task-transaction.ps1'),$TaskHelper,$false)
  $Configuration['taskHelperPath']=$TaskHelper
  $Configuration['taskUpgrade']=$Manifest.taskUpgrade
  $Settings=[pscustomobject]$Configuration
  . $TaskHelper
  $Live=Get-StartupTaskLive $Settings
  if ((Get-StartupTaskXmlKey $Live.xml -IgnoreEnabled) -cne (Get-StartupTaskXmlKey ([IO.File]::ReadAllText($Settings.taskUpgrade.originalXmlPath)) -IgnoreEnabled)) {throw 'TASK_ORIGINAL_DEFINITION_CHANGED'}
  $Settings.taskUpgrade | Add-Member -NotePropertyName securityDescriptor -NotePropertyValue $Live.securityDescriptor
  $Configuration['pins']+=@{path=$TaskHelper;sha256=(Sha $TaskHelper)}
}
[IO.File]::WriteAllText($ConfigurationPath,($Configuration|ConvertTo-Json -Depth 8),$Utf8)
[ordered]@{status='OWNER_ENTRY_PREPARED_NOT_EXECUTED';entryPath=$OwnerEntry;entrySha256=$Configuration.ownerEntrySha256;configurationPath=$ConfigurationPath;configurationSha256=(Sha $ConfigurationPath);manifestSha256=$Configuration.manifestSha256;files=@($Manifest.files).Count;targetWrites=0;serviceActions=0}|ConvertTo-Json -Compress
