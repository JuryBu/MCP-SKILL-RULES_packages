$ErrorActionPreference = "Stop"

$toolkitRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$mcpRoot = Join-Path $toolkitRoot "mcps"
$components = @("memory-store", "web-fetcher", "sandbox", "broker")

function Require-Command($name) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Required command not found: $name"
    }
    return $cmd
}

Require-Command "node" | Out-Null
Require-Command "npm" | Out-Null

function Invoke-NpmChecked {
    param([string[]]$Arguments)
    & npm @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

$nodeVersionText = (& node -v).Trim()
$major = [int]($nodeVersionText.TrimStart("v").Split(".")[0])
if ($major -lt 18) {
    throw "Node.js 18 or newer is required. Current: $nodeVersionText"
}

foreach ($name in $components) {
    $dir = Join-Path $mcpRoot $name
    if (-not (Test-Path -LiteralPath (Join-Path $dir "package.json"))) {
        throw "Missing package.json for component: $name"
    }

    Write-Output "Installing dependencies: $name"
    Push-Location $dir
    try {
        if (Test-Path -LiteralPath (Join-Path $dir "package-lock.json")) {
            Invoke-NpmChecked @("ci")
        } else {
            Invoke-NpmChecked @("install")
        }
        if ($name -eq "broker") {
            Invoke-NpmChecked @("run", "check")
        } else {
            Invoke-NpmChecked @("run", "build")
        }
    } finally {
        Pop-Location
    }
}

Write-Output "Portable Codex toolkit install/build completed."
