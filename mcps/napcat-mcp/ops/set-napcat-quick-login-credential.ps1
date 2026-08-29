[CmdletBinding()]
param(
  [string]$DataRoot = "",
  [string]$BrokerRoot = "",
  [string]$CodexHome = "",
  [SecureString]$Password,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "resolve-napcat-data-root.ps1")
. (Join-Path $PSScriptRoot "napcat-quick-login-credential.ps1")
if ([string]::IsNullOrWhiteSpace($CodexHome)) { $CodexHome = Join-Path $env:USERPROFILE ".codex" }
if ([string]::IsNullOrWhiteSpace($BrokerRoot)) {
  $BrokerRoot = if (-not [string]::IsNullOrWhiteSpace($env:CODEX_TOOLKIT_BROKER_ROOT)) {
    $env:CODEX_TOOLKIT_BROKER_ROOT
  } else {
    Join-Path $CodexHome "mcp-http-broker"
  }
}
$DataRoot = Resolve-NapCatDataRoot -ExplicitDataRoot $DataRoot -BrokerRoot $BrokerRoot
$BindingPath = Join-Path $DataRoot "binding.json"
$CredentialPath = Join-Path $DataRoot "private\napcat-login\credential.json"
if ($Remove) {
  if (Test-Path -LiteralPath $CredentialPath) { Remove-Item -LiteralPath $CredentialPath -Force }
  [pscustomobject]@{ state = "removed"; credentialPath = $CredentialPath } | ConvertTo-Json
  exit 0
}
if (-not (Test-Path -LiteralPath $BindingPath -PathType Leaf)) { throw "NapCat binding not found: $BindingPath" }
$Binding = Get-Content -LiteralPath $BindingPath -Raw -Encoding UTF8 | ConvertFrom-Json
$Account = [string]$Binding.expectedSelfId
if ([string]::IsNullOrWhiteSpace($Account)) { throw "binding.json is missing expectedSelfId" }

$ResolvedMd5 = ""
if ($null -eq $Password) { $Password = Read-Host "Enter the NapCat account password (MD5 is computed only in memory)" -AsSecureString }
$Bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
try {
  $PlainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
  $Hasher = [System.Security.Cryptography.MD5]::Create()
  try {
    $ResolvedMd5 = ([BitConverter]::ToString($Hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($PlainPassword)))).Replace("-", "").ToLowerInvariant()
  } finally {
    $Hasher.Dispose()
    $PlainPassword = $null
  }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
}
if ($ResolvedMd5 -notmatch '^[a-f0-9]{32}$') { throw "Invalid password MD5 format" }
$Protected = Protect-NapCatQuickLoginPasswordMd5 -Account $Account -PasswordMd5 $ResolvedMd5
$CredentialDirectory = Split-Path -Parent $CredentialPath
New-Item -ItemType Directory -Path $CredentialDirectory -Force | Out-Null
Protect-NapCatCredentialPath -Path $CredentialDirectory
$Payload = [ordered]@{
  schemaVersion = 1
  protectedPasswordMd5 = $Protected
  createdAt = [DateTime]::UtcNow.ToString("o")
}
$TemporaryPath = "$CredentialPath.tmp-$PID"
[System.IO.File]::WriteAllText($TemporaryPath, ($Payload | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
Move-Item -LiteralPath $TemporaryPath -Destination $CredentialPath -Force
Protect-NapCatCredentialPath -Path $CredentialPath
$RoundTrip = Read-NapCatQuickLoginCredential -CredentialPath $CredentialPath -ExpectedAccount $Account
if ($RoundTrip -ne $ResolvedMd5) { throw "NapCat quick-login credential round-trip verification failed" }
$ResolvedMd5 = $null
$RoundTrip = $null
[pscustomobject]@{
  state = "configured"
  credentialPath = $CredentialPath
  protection = "Windows-DPAPI-CurrentUser"
} | ConvertTo-Json -Depth 4
