param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$OutputPath,
  [Parameter(Mandatory=$true)][string]$SourceSha256
)
$ErrorActionPreference='Stop'
$Source=Join-Path ([IO.Path]::GetFullPath($SourceRoot)) 'ops\hidden-powershell-host.cs'
$OutputPath=[IO.Path]::GetFullPath($OutputPath)
if ($SourceSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $SourceSha256) {throw 'HOST_SOURCE_IDENTITY_CHANGED'}
if ([IO.Path]::GetExtension($OutputPath) -ine '.exe' -or (Test-Path -LiteralPath $OutputPath)) {throw 'NEW_HOST_EXECUTABLE_OUTPUT_REQUIRED'}
$OutputDirectory=[IO.Path]::GetDirectoryName($OutputPath)
if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {throw 'HOST_OUTPUT_DIRECTORY_REQUIRED'}
$Compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$CompilerSha256=(Get-FileHash -LiteralPath $Compiler -Algorithm SHA256).Hash.ToLowerInvariant()
& $Compiler /nologo /target:winexe ('/out:'+$OutputPath) $Source
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {throw 'HOST_COMPILATION_FAILED'}
$Bytes=[IO.File]::ReadAllBytes($OutputPath)
$Header=[BitConverter]::ToInt32($Bytes,0x3c)
if ([BitConverter]::ToUInt16($Bytes,$Header+24+68) -ne 2) {throw 'GUI_SUBSYSTEM_REQUIRED'}
[ordered]@{status='BUILT_NOT_INSTALLED';path=$OutputPath;sha256=(Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$Bytes.Length;sourceSha256=$SourceSha256;compilerSha256=$CompilerSha256;guiSubsystem=2;targetWrites=0;serviceActions=0}|ConvertTo-Json -Compress
