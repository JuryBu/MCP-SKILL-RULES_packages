[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$SourceRoot,
  [Parameter(Mandatory)][string]$InstalledRoot,
  [Parameter(Mandatory)][string]$PackageRoot,
  [Parameter(Mandatory)][string]$NodePath,
  [string]$DesktopLauncherPath = '-',
  [ValidateSet('TempFixture','ManualProduction')][string]$Mode = 'TempFixture',
  [string]$FixtureRoot = '',
  [string]$OwnerPowerShellPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
  [string]$WholeRuntimeManifestPath = '',
  [string]$WholeRuntimeManifestSha256 = '',
  [string]$InnerProfilePath = '',
  [string]$OuterStartupPath = '',
  [string]$QqCanonicalManifestPath = '',
  [string]$QqCanonicalManifestSha256 = '',
  [string]$QqStateRoot = ''
)
$ErrorActionPreference='Stop'
$Utf8=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$Utf8
$Sections=[Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group -bor [Security.AccessControl.AccessControlSections]::Access
$OwnerPowerShellPath=[IO.Path]::GetFullPath($OwnerPowerShellPath)
$ShellName=[IO.Path]::GetFileName($OwnerPowerShellPath)
if ($ShellName -inotmatch '^(powershell|pwsh)\.exe$' -or -not (Test-Path -LiteralPath $OwnerPowerShellPath -PathType Leaf)) {throw 'SUPPORTED_OWNER_POWERSHELL_REQUIRED'}
$OwnerShell=[ordered]@{path=$OwnerPowerShellPath;sha256=(Get-FileHash -LiteralPath $OwnerPowerShellPath -Algorithm SHA256).Hash.ToLowerInvariant();major=if($ShellName -ieq 'pwsh.exe'){7}else{5};edition=if($ShellName -ieq 'pwsh.exe'){'Core'}else{'Desktop'}}
if (Test-Path -LiteralPath $PackageRoot) {throw 'PACKAGE_ALREADY_EXISTS'}
$PayloadOutput=Join-Path $PackageRoot 'payload'
if ($WholeRuntimeManifestPath) {
  if (-not $WholeRuntimeManifestSha256 -or -not $InnerProfilePath -or -not $OuterStartupPath) {throw 'WHOLE_RUNTIME_BOUND_INPUTS_REQUIRED'}
  $BuildArguments=@($SourceRoot,$InstalledRoot,$DesktopLauncherPath,$PayloadOutput,$WholeRuntimeManifestPath,$WholeRuntimeManifestSha256,$InnerProfilePath,$OuterStartupPath)
  if ($QqCanonicalManifestPath) {$BuildArguments+=@($QqCanonicalManifestPath,$QqCanonicalManifestSha256,$QqStateRoot)}
  elseif ($QqCanonicalManifestSha256 -or $QqStateRoot) {throw 'QQ_CANONICAL_MANIFEST_REQUIRED'}
  $Build=& $NodePath (Join-Path $SourceRoot 'ops\build-full-upgrade-payload.mjs') @BuildArguments
} else {
  if ($WholeRuntimeManifestSha256 -or $InnerProfilePath -or $OuterStartupPath -or $QqCanonicalManifestPath -or $QqCanonicalManifestSha256 -or $QqStateRoot) {throw 'WHOLE_RUNTIME_MANIFEST_REQUIRED'}
  $Build=& $NodePath (Join-Path $SourceRoot 'ops\build-startup-repair.mjs') $SourceRoot $InstalledRoot $DesktopLauncherPath $PayloadOutput
}
if ($LASTEXITCODE -ne 0) {throw 'PAYLOAD_PREPARATION_FAILED'}
$Build=$Build | ConvertFrom-Json
$Payload=Get-Content -LiteralPath $Build.payloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (@($Payload.files).Count -lt 1) {throw 'NO_REPAIR_FILES'}
New-Item -ItemType Directory -Path (Join-Path $PackageRoot 'candidate'),(Join-Path $PackageRoot 'original') | Out-Null
$Files=@()
foreach ($Index in 0..($Payload.files.Count-1)) {
  $File=$Payload.files[$Index]
  $Exists=Test-Path -LiteralPath $File.targetPath -PathType Leaf
  $Original=if ($Exists) {
    [ordered]@{exists=$true;sha256=(Get-FileHash -LiteralPath $File.targetPath -Algorithm SHA256).Hash.ToLowerInvariant();sddl=(Get-Acl -LiteralPath $File.targetPath).GetSecurityDescriptorSddlForm($Sections);attributes=[int][IO.File]::GetAttributes($File.targetPath)}
  } else {[ordered]@{exists=$false;sha256=$null;sddl=$null;attributes=$null}}
  if ($Original.sha256 -cne $File.beforeSha256) {throw 'PRODUCTION_BASELINE_CHANGED'}
  if ($File.provenance.originalSddl -and $Original.sddl -cne $File.provenance.originalSddl) {throw 'QQ_ORIGINAL_ACL_CHANGED'}
  [IO.File]::Copy($File.payloadPath,(Join-Path $PackageRoot ('candidate/'+$Index+'.bin')),$false)
  if ($Exists) {[IO.File]::Copy($File.targetPath,(Join-Path $PackageRoot ('original/'+$Index+'.bin')),$false)}
  $Reference=if ($Exists) {$File.targetPath} else {(Get-ChildItem -LiteralPath (Split-Path -Parent $File.targetPath) -File | Select-Object -First 1).FullName}
  if (-not $Reference) {throw 'NEW_FILE_PERMISSION_REFERENCE_MISSING'}
  $Installed=[ordered]@{exists=$true;sha256=$File.candidateSha256;sddl=(Get-Acl -LiteralPath $Reference).GetSecurityDescriptorSddlForm($Sections);attributes=if($Exists){$Original.attributes}else{32}}
  $Files += [ordered]@{name=$File.name;targetPath=$File.targetPath;candidateSha256=$File.candidateSha256;original=$Original;installed=$Installed;provenance=$File.provenance}
}
$Template=Get-Content -LiteralPath (Join-Path $SourceRoot 'ops\startup-repair-files.template.ps1') -Raw -Encoding UTF8
$Bindings=@{
  '__PRODUCTION_ROOT__'=[string]$Payload.targetRoot
  '__PRODUCTION_TARGETS_JSON__'=ConvertTo-Json -InputObject @($Files | ForEach-Object targetPath) -Compress
  '__FILE_NAMES_JSON__'=ConvertTo-Json -InputObject @($Files | ForEach-Object name) -Compress
  '__CANDIDATE_HASHES_JSON__'=ConvertTo-Json -InputObject @($Files | ForEach-Object candidateSha256) -Compress
  '__ORIGINAL_HASHES_JSON__'=ConvertTo-Json -InputObject @($Files | ForEach-Object {$_.original.sha256}) -Compress
}
foreach ($Key in $Bindings.Keys) {$Template=$Template.Replace($Key,([string]$Bindings[$Key]).Replace("'","''"))}
$Entry=Join-Path $PackageRoot 'repair-files.ps1'
[IO.File]::WriteAllText($Entry,$Template,[Text.UTF8Encoding]::new($true))
$Manifest=[ordered]@{schemaVersion=1;mode=$Mode;targetRoot=$Payload.targetRoot;preparedAtUtc=[DateTimeOffset]::UtcNow.ToString('o');entrySha256=(Get-FileHash -LiteralPath $Entry -Algorithm SHA256).Hash.ToLowerInvariant();ownerPowerShell=$OwnerShell;files=$Files}
$Manifest['scope']=$Payload.scope
if ($Payload.taskUpgrade) {
  $TaskDirectory=Join-Path $PackageRoot 'task'
  [IO.Directory]::CreateDirectory($TaskDirectory) | Out-Null
  $TaskUpgrade=$Payload.taskUpgrade
  foreach ($Phase in @('original','candidate')) {
    $SourcePath=$TaskUpgrade.($Phase+'XmlPath')
    $Destination=Join-Path $TaskDirectory ($Phase+'.xml')
    [IO.File]::Copy($SourcePath,$Destination,$false)
    $TaskUpgrade.($Phase+'XmlPath')=$Destination
  }
  if ($TaskUpgrade.deriveCandidateAction) {
    $Document=[xml][IO.File]::ReadAllText($TaskUpgrade.candidateXmlPath)
    $Document.Task.Actions.Exec.Command=$TaskUpgrade.action.execute
    $Document.Task.Actions.Exec.Arguments=$TaskUpgrade.action.arguments
    $Document.Task.Actions.Exec.WorkingDirectory=$TaskUpgrade.action.workingDirectory
    [IO.File]::WriteAllText($TaskUpgrade.candidateXmlPath,$Document.OuterXml,[Text.UnicodeEncoding]::new($false,$true))
    $TaskUpgrade.candidateXmlSha256=(Get-FileHash -LiteralPath $TaskUpgrade.candidateXmlPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $Manifest['taskUpgrade']=$TaskUpgrade
}
if ($Mode -eq 'TempFixture') {$Manifest.fixtureRoot=$FixtureRoot}
$ManifestPath=Join-Path $PackageRoot 'manifest.json'
[IO.File]::WriteAllText($ManifestPath,($Manifest|ConvertTo-Json -Depth 12),$Utf8)
$ManifestSha=(Get-FileHash -LiteralPath $ManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.Directory]::CreateDirectory((Join-Path $PackageRoot 'recovery\ops')) | Out-Null
foreach ($Name in @('owned-stop-marker.ps1','stop-codex-app-server-proxy.ps1','resolve-napcat-data-root.ps1')) {
  [IO.File]::Copy((Join-Path $SourceRoot ('ops\'+$Name)),(Join-Path $PackageRoot ('recovery\ops\'+$Name)),$false)
}
[IO.File]::WriteAllText((Join-Path $PackageRoot 'receipt.json'),([ordered]@{manifestSha256=$ManifestSha;status='PREPARED';intent=$null;progress=@($Files | ForEach-Object {'ORIGINAL'})}|ConvertTo-Json -Depth 12),$Utf8)
[ordered]@{status='PREPARED_NOT_INSTALLED';files=$Files.Count;manifestPath=$ManifestPath;manifestSha256=$ManifestSha;entrySha256=$Manifest.entrySha256;targetWrites=0;serviceActions=0}|ConvertTo-Json -Compress
