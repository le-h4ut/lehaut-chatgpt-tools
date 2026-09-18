#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$repo = Get-Content -LiteralPath (Join-Path $root 'repo.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$raw = 'https://raw.githubusercontent.com/{0}/{1}/{2}/userscripts/' -f $repo.owner, $repo.repository, $repo.branch
$marker = '// ==/UserScript=='
$node = Get-Command node -ErrorAction SilentlyContinue
$manifestText = [IO.File]::ReadAllText((Join-Path $root 'docs/config.js'))
$manifestJson = $manifestText.Substring($manifestText.IndexOf('=') + 1).Trim().TrimEnd(';')
$manifest = $manifestJson | ConvertFrom-Json
foreach ($original in Get-ChildItem -LiteralPath (Join-Path $root 'archive') -Filter '*.user.js') {
    $name = $original.Name -replace '_v\d+\.\d+\.\d+(?=\.user\.js$)', ''
    $path = Join-Path $root ('userscripts/' + $name)
    $before = [IO.File]::ReadAllText($original.FullName)
    $after = [IO.File]::ReadAllText($path)
    $beforeEnd = $before.IndexOf($marker)
    $afterEnd = $after.IndexOf($marker)
    if ($beforeEnd -lt 0 -or $afterEnd -lt 0) { throw "Missing header: $name" }
    if ($before.Substring($beforeEnd) -cne $after.Substring($afterEnd)) { throw "Original script body changed: $name" }
    $originalHeader = $before.Substring(0, $beforeEnd).Replace("`r`n", "`n")
    $header = $after.Substring(0, $afterEnd)
    $stripped = [regex]::Replace($header, '(?m)^//\s+@(updateURL|downloadURL)\s+[^\r\n]*\r?\n', '').Replace("`r`n", "`n")
    if ($originalHeader -cne $stripped) { throw "Original metadata changed: $name" }
    foreach ($field in @('updateURL','downloadURL')) {
        $matchesFound = [regex]::Matches($header, "(?m)^//\s+@$field\s+(\S+)")
        if ($matchesFound.Count -ne 1 -or $matchesFound[0].Groups[1].Value -cne ($raw + $name)) { throw "Invalid $field in $name" }
    }
    $version = [regex]::Match($header, '(?m)^//\s+@version\s+(\S+)').Groups[1].Value
    $entry = @($manifest.scripts | Where-Object { $_.file -eq $name })
    if ($entry.Count -ne 1 -or $entry[0].version -ne $version -or $entry[0].url -ne ($raw + $name)) { throw "Stale page manifest: $name" }
    if ($node) { & $node.Source --check $path; if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failed: $name" } }
    Write-Host "PASS: $name ($version), body and metadata preserved"
}
foreach ($line in Get-Content -LiteralPath (Join-Path $root 'archive/SHA256SUMS.txt')) {
    if ($line -match '^([a-fA-F0-9]{64})\s+(.+)$') {
        $hash = (Get-FileHash -LiteralPath (Join-Path $root ('archive/' + $Matches[2])) -Algorithm SHA256).Hash
        if ($hash -ne $Matches[1]) { throw "Archive checksum mismatch: $line" }
    }
}
foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -Filter '*.ps1') {
    $tokens = $null; $parseErrors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
}
$html = [IO.File]::ReadAllText((Join-Path $root 'docs/index.html'))
foreach ($match in [regex]::Matches($html, '(?:href|src)="([^"#]+)"')) {
    $link = $match.Groups[1].Value
    if ($link -notmatch '^[a-z]+:' -and -not (Test-Path -LiteralPath (Join-Path $root ('docs/' + $link)))) { throw "Broken local page link: $link" }
}
foreach ($match in [regex]::Matches($html, 'href="#([^"]+)"')) {
    if ($html -notmatch ('id="' + [regex]::Escape($match.Groups[1].Value) + '"')) { throw 'Broken page anchor' }
}
if ($node) {
    foreach ($file in @('docs/app.js','docs/config.js')) {
        & $node.Source --check (Join-Path $root $file)
        if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failed: $file" }
    }
} else { Write-Warning 'Node.js not found: JavaScript syntax checks skipped.' }
$placeholders = Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' -and $_.Name -ne 'verify.ps1' } | Select-String -Pattern '<OWNER>|<REPO>'
if ($placeholders) { throw 'Unconfigured OWNER/REPO placeholders remain.' }
Write-Host 'PASS: archive hashes, manifest, PowerShell parsing, local links and configuration'
