function Set-CodexProjectDocMaxBytes {
    [CmdletBinding()]
    param(
        [AllowEmptyString()]
        [string]$Content = "",
        [long]$MinimumBytes = 65536
    )

    if ($MinimumBytes -lt 32768) {
        throw "MinimumBytes must be at least 32768."
    }

    $normalized = $Content -replace "\r?\n", "`r`n"
    $firstTable = [regex]::Match($normalized, "(?m)^\s*\[")
    $root = if ($firstTable.Success) { $normalized.Substring(0, $firstTable.Index) } else { $normalized }
    $tables = if ($firstTable.Success) { $normalized.Substring($firstTable.Index) } else { "" }
    $namedMatches = [regex]::Matches($root, "(?m)^\s*project_doc_max_bytes\s*=.*$")

    if ($namedMatches.Count -gt 1) {
        throw "Codex config contains multiple top-level project_doc_max_bytes settings."
    }

    if ($namedMatches.Count -eq 1) {
        $numericMatch = [regex]::Match(
            $namedMatches[0].Value,
            "^(\s*)project_doc_max_bytes\s*=\s*([+-]?[0-9](?:_?[0-9])*)(\s*(?:#.*)?)$"
        )
        if (-not $numericMatch.Success) {
            throw "Top-level project_doc_max_bytes must be an integer."
        }

        $currentBytes = [long]($numericMatch.Groups[2].Value.Replace("_", ""))
        if ($currentBytes -lt $MinimumBytes) {
            $replacement = (
                $numericMatch.Groups[1].Value +
                "project_doc_max_bytes = $MinimumBytes" +
                $numericMatch.Groups[3].Value
            )
            $match = $namedMatches[0]
            $root = $root.Remove($match.Index, $match.Length).Insert($match.Index, $replacement)
        }
    } else {
        $trimmedRoot = $root.TrimEnd()
        $root = if ($trimmedRoot.Length -gt 0) {
            "$trimmedRoot`r`nproject_doc_max_bytes = $MinimumBytes`r`n"
        } else {
            "project_doc_max_bytes = $MinimumBytes`r`n"
        }
        if ($tables.Length -gt 0) {
            $root += "`r`n"
        }
    }

    return ($root + $tables).TrimEnd() + "`r`n"
}
