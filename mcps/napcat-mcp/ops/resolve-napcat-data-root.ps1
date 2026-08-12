function Resolve-NapCatBrokerRoot {
  [CmdletBinding()]
  param(
    [string]$ExplicitBrokerRoot = "",
    [string]$UserProfile = $env:USERPROFILE
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitBrokerRoot)) {
    return [System.IO.Path]::GetFullPath($ExplicitBrokerRoot).TrimEnd('\')
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_BROKER_ROOT)) {
    return [System.IO.Path]::GetFullPath([string]$env:CODEX_TOOLKIT_BROKER_ROOT).TrimEnd('\')
  }

  $ManifestPath = Join-Path $UserProfile ".codex-toolkit\services\infrastructure\service-manifest.json"
  if (Test-Path -LiteralPath $ManifestPath -PathType Leaf) {
    try {
      $Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $BrokerScript = [string]$Manifest.broker.brokerScript
      if (-not [string]::IsNullOrWhiteSpace($BrokerScript)) {
        return [System.IO.Path]::GetFullPath((Split-Path -Parent $BrokerScript)).TrimEnd('\')
      }
    } catch {}
  }

  return [System.IO.Path]::GetFullPath((Join-Path $UserProfile ".codex\mcp-http-broker")).TrimEnd('\')
}

function Resolve-NapCatDataRoot {
  [CmdletBinding()]
  param(
    [string]$ExplicitDataRoot = "",
    [string]$BrokerRoot = "",
    [string]$UserProfile = $env:USERPROFILE
  )

  if (-not [string]::IsNullOrWhiteSpace($ExplicitDataRoot)) {
    return [System.IO.Path]::GetFullPath($ExplicitDataRoot).TrimEnd('\')
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT)) {
    return [System.IO.Path]::GetFullPath([string]$env:CODEX_TOOLKIT_NAPCAT_DATA_ROOT).TrimEnd('\')
  }

  $ResolvedBrokerRoot = Resolve-NapCatBrokerRoot -ExplicitBrokerRoot $BrokerRoot -UserProfile $UserProfile
  $PrivateEnvPath = Join-Path $ResolvedBrokerRoot "broker-private.env.json"
  if (Test-Path -LiteralPath $PrivateEnvPath -PathType Leaf) {
    try {
      $PrivateEnv = Get-Content -LiteralPath $PrivateEnvPath -Raw -Encoding UTF8 | ConvertFrom-Json
      $ConfiguredDataRoot = [string]$PrivateEnv.CODEX_TOOLKIT_NAPCAT_DATA_ROOT
      if (-not [string]::IsNullOrWhiteSpace($ConfiguredDataRoot)) {
        return [System.IO.Path]::GetFullPath($ConfiguredDataRoot).TrimEnd('\')
      }
    } catch {
      throw "Unable to read broker-private NapCat DataRoot: $PrivateEnvPath"
    }
  }

  $LegacyDataRoot = [System.IO.Path]::GetFullPath((Join-Path $ResolvedBrokerRoot "napcat-mcp")).TrimEnd('\')
  $CanonicalDataRoot = [System.IO.Path]::GetFullPath((Join-Path $UserProfile ".codex-toolkit\napcat-mcp")).TrimEnd('\')
  $RegistryRoots = @(
    @($LegacyDataRoot, $CanonicalDataRoot) |
      Where-Object { Test-Path -LiteralPath (Join-Path $_ "state\task-registry.json") -PathType Leaf } |
      Select-Object -Unique
  )

  if ($RegistryRoots.Count -gt 1) {
    throw "Multiple NapCat task registries were found; specify DataRoot explicitly: $($RegistryRoots -join ', ')"
  }
  if ($RegistryRoots.Count -eq 1) {
    return $RegistryRoots[0]
  }

  return $CanonicalDataRoot
}
