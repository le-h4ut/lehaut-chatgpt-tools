param([string]$Installer = (Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1'), [string]$Uri)
$ErrorActionPreference = 'Stop'
# Decode the actual bytes, preserving BOM if present, as irm can do.
if ($Uri) { $source = Invoke-RestMethod -Uri $Uri }
else { $source = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Installer)) }
if ([int][char]$source[0] -eq 0xFEFF) { throw 'Installer has a BOM: irm | iex may execute it as part of the first command.' }
$cases = @(
    @{ Name='Chrome installed'; Installed=@('chrome.exe'); Default='ChromeHTML'; Input=@('1','Y',''); Expected=2; Browser='chrome.exe'; Store=$false },
    @{ Name='Firefox setup'; Installed=@('firefox.exe'); Default='FirefoxURL'; Input=@('1','N',''); Expected=2; Browser='firefox.exe'; Store=$true },
    @{ Name='Edge default with invalid selection'; Installed=@('chrome.exe','msedge.exe','firefox.exe'); Default='MSEdgeHTM'; Input=@('8','','1','bad','yes',''); Expected=2; Browser='msedge.exe'; Store=$false },
    @{ Name='Cancel browser choice'; Installed=@('chrome.exe','firefox.exe'); Default=''; Input=@('Q'); Expected=0 },
    @{ Name='Cancel extension question'; Installed=@('firefox.exe'); Default=''; Input=@('1','Q'); Expected=0 },
    @{ Name='Cancel after opening store'; Installed=@('chrome.exe'); Default=''; Input=@('1','N','Q'); Expected=1; Store=$true },
    @{ Name='No supported browsers'; Installed=@(); Default=''; Input=@('Q'); Expected=0 },
    @{ Name='Blocked browser launch'; Installed=@('firefox.exe'); Default=''; Input=@('1','Y'); Expected=1; FailLaunch=$true },
    @{ Name='Manual Firefox path'; Installed=@(); Default=''; Input=@('M','C:\Тест пользователя\Browser Folder\firefox.exe','Y'); Expected=1; Browser='firefox.exe'; Store=$false },
    @{ Name='Brave registered default'; Installed=@('chrome.exe','brave.exe'); Default='BraveHTML'; Input=@('1','Y',''); Expected=2; Browser='brave.exe'; Store=$false; Settings='brave://extensions/' },
    @{ Name='Brave standard local path'; Installed=@(); LocalBrave=$true; Default=''; Input=@('1','Y',''); Expected=2; Browser='brave.exe'; Store=$false; Settings='brave://extensions/' },
    @{ Name='Manual Brave path'; Installed=@(); Default=''; Input=@('M','C:\Тест пользователя\Browser Folder\brave.exe','N','',''); Expected=3; Browser='brave.exe'; Store=$true; Settings='brave://extensions/' },
    @{ Name='Other Chromium'; Installed=@(); Default=''; Input=@('M','C:\Тест пользователя\Browser Folder\vivaldi.exe','1','Y',''); Expected=2; Browser='vivaldi.exe'; Store=$false; Settings='chrome://extensions/' },
    @{ Name='Other Firefox'; Installed=@(); Default=''; Input=@('M','C:\Тест пользователя\Browser Folder\floorp.exe','2','Y'); Expected=1; Browser='floorp.exe'; Store=$false; Firefox=$true },
    @{ Name='Invalid path and cancel family'; Installed=@(); Default=''; Input=@('M','C:\missing\browser.exe','M','C:\Тест пользователя\Browser Folder\other.exe','bad','Q','Q'); Expected=0 },
    @{ Name='Reject non-executable'; Installed=@(); Default=''; Input=@('M','C:\Тест пользователя\Browser Folder\script.ps1','Q'); Expected=0 },
    @{ Name='Cyrillic answer'; Installed=@('chrome.exe'); Default=''; Input=@('1','да',''); Expected=2; Browser='chrome.exe'; Store=$false }
)
foreach ($case in $cases) {
    & {
        param($case,$source)
        $script:answers = New-Object 'System.Collections.Generic.Queue[string]'
        foreach ($answer in $case.Input) { $script:answers.Enqueue($answer) }
        $script:launches = New-Object 'System.Collections.Generic.List[object]'
        $script:messages = New-Object 'System.Collections.Generic.List[string]'
        function Get-Item {
            param($LiteralPath,$ErrorAction)
            $exe = Split-Path $LiteralPath -Leaf
            if ($case.Installed -contains $exe) {
                $item = [pscustomobject]@{ Path = "C:\Тест пользователя\Browser Folder\$exe" }
                $item | Add-Member ScriptMethod GetValue { param($name) return $this.Path }
                return $item
            }
        }
        function Get-ItemProperty { param($LiteralPath,$ErrorAction) return [pscustomobject]@{ ProgId=$case.Default } }
        function Test-Path { param($LiteralPath,$PathType) return (($LiteralPath -like 'C:\Тест пользователя\Browser Folder\*') -or ($case.LocalBrave -and $LiteralPath -eq (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\Application\brave.exe'))) }
        function Read-Host { param($Prompt) if ($script:answers.Count -eq 0) { throw "Unexpected input: $Prompt" }; return $script:answers.Dequeue() }
        function Start-Process {
            param($FilePath,$ArgumentList,$ErrorAction)
            $script:launches.Add([pscustomobject]@{ Path=$FilePath; Args=@($ArgumentList) })
            if ($case.FailLaunch) { throw 'Mock blocked launch' }
        }
        function Write-Host { param($Object,$ForegroundColor) $script:messages.Add([string]$Object) }
        Invoke-Expression -Command $source -ErrorAction Stop
        if ($script:launches.Count -ne $case.Expected) { throw "$($case.Name): expected $($case.Expected) launches, got $($script:launches.Count). $($script:messages -join ' | ')" }
        if ($script:answers.Count) { throw "$($case.Name): input was not consumed" }
        if ($case.Browser -and @($script:launches | Where-Object { $_.Path -notlike "*\$($case.Browser)" }).Count) { throw 'Wrong browser' }
        $storeCount = @($script:launches | Where-Object { ($_.Args -join ' ') -match 'chromewebstore|microsoftedge.microsoft.com|addons.mozilla.org' }).Count
        if ($case.ContainsKey('Store') -and ($storeCount -gt 0) -ne $case.Store) { throw 'Wrong store handling' }
        if ($case.Expected -ge 2 -and ($script:launches[$script:launches.Count - 1].Args -join '') -notmatch 'github.io') { throw 'Installer page was not last' }
        if (($case.Browser -eq 'firefox.exe' -or $case.Firefox) -and $script:launches[0].Args[0] -ne '-new-tab') { throw 'Missing Firefox flag' }
        if ($case.Browser -eq 'chrome.exe' -and $script:launches[0].Args.Count -ne 1) { throw 'Unexpected Chromium flag' }
        if ($case.Settings -and -not @($script:launches | Where-Object { ($_.Args -join '') -like ('*' + $case.Settings + '*') }).Count) { throw 'Wrong browser settings URL' }
        if ($case.FailLaunch -and ($script:messages -join '') -notmatch 'https://le-h4ut.github.io/') { throw 'Missing manual fallback' }
        Microsoft.PowerShell.Utility\Write-Host "PASS: $($case.Name)"
    } $case $source
}
