$ErrorActionPreference = "Stop"

$installRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$rollbackPath = Join-Path $installRoot "rollback-napcat-mcp.ps1"
$testRoot = Join-Path $env:TEMP ("napcat-legacy-rollback-compatibility-" + [guid]::NewGuid())

function Get-FileHash { throw "Get-FileHash is unavailable in this compatibility test." }

try {
    if (-not (Test-Path -LiteralPath $rollbackPath -PathType Leaf)) {
        throw "Legacy NapCat rollback source is missing: $rollbackPath"
    }

    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($rollbackPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) {
        throw "Legacy NapCat rollback source has PowerShell parse errors."
    }

    $legacyCalls = @($ast.FindAll({
        param($node)
        if ($node -isnot [System.Management.Automation.Language.CommandAst]) { return $false }
        return $node.GetCommandName() -eq "Get-FileHash"
    }, $true))
    if ($legacyCalls.Count -gt 0) {
        throw "Legacy NapCat rollback source still calls Get-FileHash."
    }

    $hashFunction = $ast.Find({
        param($node)
        return $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Get-FileSha256"
    }, $true)
    if ($null -eq $hashFunction) {
        throw "Legacy NapCat rollback source is missing Get-FileSha256."
    }

    Invoke-Expression $hashFunction.Extent.Text
    New-Item -ItemType Directory -Force -Path $testRoot | Out-Null
    $probePath = Join-Path $testRoot "probe.txt"
    [System.IO.File]::WriteAllText($probePath, "portable sha256 probe", (New-Object System.Text.UTF8Encoding($false)))

    $stream = [System.IO.File]::OpenRead($probePath)
    try {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        try {
            $expected = ([System.BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
        } finally {
            $hasher.Dispose()
        }
    } finally {
        $stream.Dispose()
    }

    $actual = Get-FileSha256 -Path $probePath
    if ($actual -ne $expected) {
        throw "Legacy NapCat rollback portable SHA256 helper returned an unexpected hash."
    }

    Write-Output "Legacy NapCat rollback SHA256 compatibility test passed without Get-FileHash."
} finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
