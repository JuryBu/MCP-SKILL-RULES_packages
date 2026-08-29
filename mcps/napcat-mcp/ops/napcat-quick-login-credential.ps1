$ErrorActionPreference = "Stop"

function Get-NapCatQuickLoginEntropy {
  param([Parameter(Mandatory = $true)][string]$Account)
  Add-Type -AssemblyName System.Security
  return [System.Text.Encoding]::UTF8.GetBytes("codex-napcat-quick-login-v1:$Account")
}

function Protect-NapCatQuickLoginPasswordMd5 {
  param(
    [Parameter(Mandatory = $true)][string]$Account,
    [Parameter(Mandatory = $true)][string]$PasswordMd5
  )
  if ($PasswordMd5 -notmatch '^[a-fA-F0-9]{32}$') { throw "PasswordMd5 must be a 32-character hexadecimal MD5" }
  Add-Type -AssemblyName System.Security
  $Bytes = [System.Text.Encoding]::UTF8.GetBytes($PasswordMd5.ToLowerInvariant())
  try {
    $Protected = [System.Security.Cryptography.ProtectedData]::Protect(
      $Bytes,
      (Get-NapCatQuickLoginEntropy -Account $Account),
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    return [Convert]::ToBase64String($Protected)
  } finally {
    [Array]::Clear($Bytes, 0, $Bytes.Length)
  }
}

function Unprotect-NapCatQuickLoginPasswordMd5 {
  param(
    [Parameter(Mandatory = $true)][string]$Account,
    [Parameter(Mandatory = $true)][string]$ProtectedPasswordMd5
  )
  Add-Type -AssemblyName System.Security
  $Protected = [Convert]::FromBase64String($ProtectedPasswordMd5)
  $Plain = $null
  try {
    $Plain = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $Protected,
      (Get-NapCatQuickLoginEntropy -Account $Account),
      [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $PasswordMd5 = [System.Text.Encoding]::UTF8.GetString($Plain)
    if ($PasswordMd5 -notmatch '^[a-fA-F0-9]{32}$') { throw "The decrypted PasswordMd5 has an invalid format" }
    return $PasswordMd5.ToLowerInvariant()
  } finally {
    if ($null -ne $Plain) { [Array]::Clear($Plain, 0, $Plain.Length) }
    [Array]::Clear($Protected, 0, $Protected.Length)
  }
}

function Read-NapCatQuickLoginCredential {
  param(
    [Parameter(Mandatory = $true)][string]$CredentialPath,
    [Parameter(Mandatory = $true)][string]$ExpectedAccount
  )
  if (-not (Test-Path -LiteralPath $CredentialPath -PathType Leaf)) { return $null }
  $Credential = Get-Content -LiteralPath $CredentialPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$Credential.schemaVersion -ne 1) { throw "Unsupported NapCat quick-login credential schema" }
  try {
    return Unprotect-NapCatQuickLoginPasswordMd5 -Account $ExpectedAccount -ProtectedPasswordMd5 ([string]$Credential.protectedPasswordMd5)
  } catch [System.Security.Cryptography.CryptographicException] {
    throw "NapCat quick-login credential cannot be decrypted for the bound account and current Windows user"
  }
}

function Protect-NapCatCredentialPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  $CurrentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $CurrentSid = [string]$CurrentIdentity.User.Value
  $IcaclsPath = Join-Path $env:SystemRoot "System32\icacls.exe"
  foreach ($Target in @((Split-Path -Parent $Path), $Path)) {
    if (-not (Test-Path -LiteralPath $Target)) { continue }
    $IsDirectory = (Get-Item -LiteralPath $Target) -is [System.IO.DirectoryInfo]
    $CurrentGrant = if ($IsDirectory) {
      "*$($CurrentSid):(OI)(CI)F"
    } else {
      "*$($CurrentSid):F"
    }
    $SystemGrant = if ($IsDirectory) {
      "*S-1-5-18:(OI)(CI)F"
    } else {
      "*S-1-5-18:F"
    }
    & $IcaclsPath $Target "/inheritance:r" "/grant:r" $CurrentGrant $SystemGrant | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to restrict NapCat credential ACL: $Target"
    }
  }
}
