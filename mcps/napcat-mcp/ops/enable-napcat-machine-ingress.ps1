[CmdletBinding()]
param(
  [string]$BindingPath = (Join-Path $env:USERPROFILE ".codex-toolkit\napcat-mcp\binding.json")
)

$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $Encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $Encoding)
}

function Set-PropertyValue {
  param($Object, [string]$Name, $Value)
  if ($Object.PSObject.Properties.Name -contains $Name) {
    $Object.$Name = $Value
  } else {
    $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  }
}

if (-not (Test-Path -LiteralPath $BindingPath -PathType Leaf)) {
  throw "NapCat binding not found: $BindingPath"
}

$Raw = [System.IO.File]::ReadAllText($BindingPath)
$Binding = $Raw | ConvertFrom-Json
if ($null -eq $Binding.controlPlane) {
  throw "binding.controlPlane is required; configure schemaVersion 2, localMachine, and trustedPeerQq first"
}

$LocalMachine = [string]$Binding.controlPlane.localMachine
$TrustedPeerQq = [string]$Binding.controlPlane.trustedPeerQq
if (@("development", "training") -notcontains $LocalMachine) {
  throw "controlPlane.localMachine must be development or training"
}
if ([string]::IsNullOrWhiteSpace($TrustedPeerQq)) {
  throw "controlPlane.trustedPeerQq must not be empty"
}

$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss-fff") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$BackupPath = "$BindingPath.bak-machine-ingress-$Stamp"
Copy-Item -LiteralPath $BindingPath -Destination $BackupPath -Force

Set-PropertyValue -Object $Binding -Name "schemaVersion" -Value 2
Set-PropertyValue -Object $Binding.controlPlane -Name "enabled" -Value $true
Set-PropertyValue -Object $Binding.controlPlane -Name "machineIngressEnabled" -Value $true

$TempPath = "$BindingPath.tmp-$Stamp"
try {
  Write-Utf8NoBom -Path $TempPath -Content (($Binding | ConvertTo-Json -Depth 32) + "`n")
  Move-Item -LiteralPath $TempPath -Destination $BindingPath -Force
} finally {
  if (Test-Path -LiteralPath $TempPath) {
    Remove-Item -LiteralPath $TempPath -Force
  }
}

$Verified = [System.IO.File]::ReadAllText($BindingPath) | ConvertFrom-Json
if (
  [int]$Verified.schemaVersion -ne 2 -or
  $Verified.controlPlane.enabled -ne $true -or
  $Verified.controlPlane.machineIngressEnabled -ne $true -or
  [string]$Verified.controlPlane.localMachine -ne $LocalMachine -or
  [string]$Verified.controlPlane.trustedPeerQq -ne $TrustedPeerQq
) {
  Copy-Item -LiteralPath $BackupPath -Destination $BindingPath -Force
  throw "Machine-ingress verification failed; the binding backup was restored"
}

Write-Host "NapCat machine ingress is enabled."
Write-Host "Local machine: $LocalMachine"
Write-Host "Trusted peer: configured"
Write-Host "Backup: $BackupPath"
Write-Host "targets/defaultTargetKey were preserved. Reload only the NapCat backend and task router, then verify napcat_status.controlPlane.machineIngressReady=true."
