param([string]$Installer = (Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1'), [string]$Uri)
$ErrorActionPreference = 'Stop'
if ($Uri) { $source = Invoke-RestMethod -Uri $Uri }
else { $source = [Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes($Installer)) }
if ([int][char]$source[0] -eq 0xFEFF) { throw 'Installer has a BOM.' }
# Fixture browser names are data. None of these registrations exist on the test host.
$cases = @(
    @{ Name='Chrome existing extension'; Clients=@(@{Name='Google Chrome';Exe='chrome.exe'}); Input=@('1','Y',''); Opens=2; Browser='chrome.exe' },
    @{ Name='Firefox store'; Clients=@(@{Name='Mozilla Firefox';Exe='firefox.exe'}); Input=@('1','N',''); Opens=2; Browser='firefox.exe'; Store='addons.mozilla.org'; Firefox=$true },
    @{ Name='Brave default sorted first'; Clients=@(@{Name='Google Chrome';Exe='chrome.exe'},@{Name='Brave';Exe='brave.exe';Id='BraveHTML'}); Default='BraveHTML'; Input=@('1','Y',''); Opens=2; Browser='brave.exe'; Settings='brave://extensions/'; Count=2 },
    @{ Name='Opera GX user registration'; Clients=@(@{Name='Opera GX Stable';Exe='opera.exe';Hive='HKCU:';Id='Opera GXStable'}); Input=@('1','N','',''); Opens=3; Browser='opera.exe'; Store='chromewebstore.google.com'; Settings='opera://extensions/' },
    @{ Name='Unknown browser discovered'; Clients=@(@{Name='Nimbus Browser';Exe='nimbus.exe'}); Input=@('1','1','Y',''); Opens=2; Browser='nimbus.exe'; Count=1; Menu='Nimbus Browser' },
    @{ Name='Unknown Gecko family'; Clients=@(@{Name='Aurora Custom';Exe='custom.exe'}); Input=@('1','2','Y'); Opens=1; Browser='custom.exe'; Firefox=$true },
    @{ Name='32-bit registration'; Clients=@(@{Name='Unlisted Browser';Exe='unlisted.exe';Wow=$true;Hive='HKLM:'}); Input=@('1','Q','Q'); Opens=0; Count=1; Menu='Unlisted Browser' },
    @{ Name='Duplicate registrations'; Clients=@(@{Name='Brave';Exe='brave.exe'},@{Name='Brave';Exe='brave.exe';Hive='HKLM:';Wow=$true}); Input=@('Q'); Opens=0; Count=1 },
    @{ Name='Stale browser path'; Clients=@(@{Name='Removed Browser';Exe='gone.exe';Missing=$true}); Input=@('Q'); Opens=0; Count=0 },
    @{ Name='RegisteredApplications only'; Capabilities=@(@{Name='Independent Browser';Exe='independent.exe';Id='IndependentHTML'}); Input=@('1','1','Y',''); Opens=2; Browser='independent.exe'; Menu='Independent Browser' },
    @{ Name='Default handler only'; Handler=@{Exe='brave.exe';Id='DefaultBrowserHTML';Name='Brave'}; Default='DefaultBrowserHTML'; Input=@('1','Y',''); Opens=2; Browser='brave.exe'; Count=1 },
    @{ Name='Quoted command arguments discarded'; Clients=@(@{Name='Brave';Exe='brave.exe';Flags=' --profile-directory="Other" "%1"'}); Input=@('1','Y',''); Opens=2; Browser='brave.exe' },
    @{ Name='Unquoted command with spaces'; Clients=@(@{Name='Brave';Exe='brave.exe';Unquoted=$true;Flags=' %1'}); Input=@('1','Y',''); Opens=2; Browser='brave.exe' },
    @{ Name='Invalid relative command'; Clients=@(@{Name='Bad Browser';Exe='bad.exe';Command='bad.exe --argument'}); Input=@('Q'); Opens=0; Count=0 },
    @{ Name='Internet Explorer explained'; Clients=@(@{Name='Internet Explorer';Exe='iexplore.exe'}); Input=@('Q'); Opens=0; Count=0; Message='Internet Explorer' },
    @{ Name='Non-web registered application excluded'; Capabilities=@(@{Name='Mail Tool';Exe='mail.exe';Id='Mail';NonWeb=$true}); Input=@('Q'); Opens=0; Count=0 },
    @{ Name='Manual Brave'; Input=@('M','C:\Тест пользователя\Browser Folder\brave.exe','Y',''); Opens=2; Browser='brave.exe'; Settings='brave://extensions/' },
    @{ Name='Manual unfamiliar Chromium'; Input=@('M','C:\Тест пользователя\Browser Folder\mystery.exe','1','Y',''); Opens=2; Browser='mystery.exe' },
    @{ Name='Manual unfamiliar Firefox'; Input=@('M','C:\Тест пользователя\Browser Folder\mystery.exe','2','Y'); Opens=1; Browser='mystery.exe'; Firefox=$true },
    @{ Name='Invalid path and family cancel'; Input=@('M','C:\missing\browser.exe','M','C:\Тест пользователя\Browser Folder\mystery.exe','bad','Q','Q'); Opens=0 },
    @{ Name='Non-EXE rejected'; Input=@('M','C:\Тест пользователя\Browser Folder\script.ps1','Q'); Opens=0 },
    @{ Name='Invalid menu and Cyrillic answer'; Clients=@(@{Name='Brave';Exe='brave.exe'}); Input=@('8','','1','да',''); Opens=2; Browser='brave.exe' },
    @{ Name='Cancel browser'; Clients=@(@{Name='Brave';Exe='brave.exe'}); Input=@('Q'); Opens=0 },
    @{ Name='Cancel extension'; Clients=@(@{Name='Brave';Exe='brave.exe'}); Input=@('1','Q'); Opens=0 },
    @{ Name='Cancel after store'; Clients=@(@{Name='Brave';Exe='brave.exe'}); Input=@('1','N','Q'); Opens=1; Store='chromewebstore.google.com' },
    @{ Name='Blocked launch fallback'; Clients=@(@{Name='Mozilla Firefox';Exe='firefox.exe'}); Input=@('1','Y'); Opens=1; FailLaunch=$true },
    @{ Name='No browsers'; Input=@('Q'); Opens=0; Count=0 }
)
foreach ($case in $cases) {
    & {
        param($case, $source)
        $script:registry = @{}
        $script:files = @{}
        $script:answers = New-Object 'System.Collections.Generic.Queue[string]'
        foreach ($answer in $case.Input) { $script:answers.Enqueue($answer) }
        $script:launches = New-Object 'System.Collections.Generic.List[object]'
        $script:messages = New-Object 'System.Collections.Generic.List[string]'
        $script:menu = $null
        function Add-Value($Path,$Name,$Value) {
            if (-not $script:registry.ContainsKey($Path)) { $script:registry[$Path] = @{} }
            $script:registry[$Path][$Name] = $Value
        }
        function Get-FixturePath($Entry) {
            $path = 'C:\Тест пользователя\Browser Folder\' + $Entry.Exe
            if (-not $Entry.Missing) { $script:files[$path] = [string]$Entry.Name }
            return $path
        }
        foreach ($exe in @('brave.exe','firefox.exe','mystery.exe','script.ps1')) { $script:files['C:\Тест пользователя\Browser Folder\' + $exe] = '' }
        $index = 0
        foreach ($client in $case.Clients) {
            $index++
            $hive = 'HKCU:'; if ($client.Hive) { $hive = $client.Hive }
            $base = 'SOFTWARE\Clients\StartMenuInternet'
            if ($client.Wow) { $base = 'SOFTWARE\WOW6432Node\Clients\StartMenuInternet' }
            $key = "$hive\$base\Browser-$index"
            $path = Get-FixturePath $client
            $command = '"' + $path + '"' + $client.Flags
            if ($client.Unquoted) { $command = $path + $client.Flags }
            if ($client.Command) { $command = $client.Command }
            Add-Value $key '' $client.Name
            Add-Value "$key\shell\open\command" '' $command
            Add-Value "$key\Capabilities\URLAssociations" 'https' $client.Id
        }
        foreach ($entry in $case.Capabilities) {
            $path = Get-FixturePath $entry
            $capability = 'SOFTWARE\FixtureApps\' + $entry.Id + '\Capabilities'
            Add-Value 'HKCU:\SOFTWARE\RegisteredApplications' $entry.Name $capability
            Add-Value "HKCU:\$capability" 'ApplicationName' $entry.Name
            $protocol = 'https'; if ($entry.NonWeb) { $protocol = 'mailto' }
            Add-Value "HKCU:\$capability\URLAssociations" $protocol $entry.Id
            Add-Value "HKCU:\SOFTWARE\Classes\$($entry.Id)\shell\open\command" '' ('"' + $path + '" "%1"')
        }
        if ($case.Handler) {
            $path = Get-FixturePath $case.Handler
            Add-Value "HKCU:\SOFTWARE\Classes\$($case.Handler.Id)\shell\open\command" '' ('"' + $path + '" "%1"')
        }
        Add-Value 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' 'ProgId' $case.Default
        function Get-Item {
            param($LiteralPath,$ErrorAction)
            if ($script:registry.ContainsKey($LiteralPath)) {
                $item = [pscustomobject]@{PSPath=$LiteralPath;Values=$script:registry[$LiteralPath]}
                $item | Add-Member ScriptMethod GetValue { param($Name) return $this.Values[$Name] }
                $item | Add-Member ScriptMethod GetValueNames { return @($this.Values.Keys) }
                return $item
            }
            if ($script:files.ContainsKey($LiteralPath)) { return [pscustomobject]@{VersionInfo=[pscustomobject]@{ProductName=$script:files[$LiteralPath]}} }
        }
        function Get-ChildItem {
            param($LiteralPath,$ErrorAction)
            $prefix = $LiteralPath + '\'
            foreach ($key in $script:registry.Keys) {
                if ($key.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -and -not $key.Substring($prefix.Length).Contains('\')) { Get-Item -LiteralPath $key }
            }
        }
        function Get-ItemProperty {
            param($LiteralPath,$ErrorAction)
            if ($script:registry.ContainsKey($LiteralPath)) { return [pscustomobject]$script:registry[$LiteralPath] }
        }
        function Test-Path { param($LiteralPath,$PathType) return $script:files.ContainsKey($LiteralPath) }
        function Read-Host {
            param($Prompt)
            if ($null -eq $script:menu) { $script:menu = @($script:messages | Where-Object { $_ -match '^\d+\. ' }) }
            if (-not $script:answers.Count) { throw "Unexpected input: $Prompt" }
            return $script:answers.Dequeue()
        }
        function Start-Process {
            param($FilePath,$ArgumentList,$ErrorAction)
            $script:launches.Add([pscustomobject]@{Path=$FilePath;Args=@($ArgumentList)})
            if ($case.FailLaunch) { throw 'Mock blocked launch' }
        }
        function Write-Host { param($Object,$ForegroundColor) $script:messages.Add([string]$Object) }
        Invoke-Expression -Command $source -ErrorAction Stop
        if ($script:launches.Count -ne $case.Opens -or $script:answers.Count) { throw "$($case.Name): wrong flow. Launches=$($script:launches.Count); remaining inputs=$($script:answers.Count); $($script:messages -join ' | ')" }
        $menu = $script:menu
        if ($case.ContainsKey('Count') -and $menu.Count -ne $case.Count) { throw "$($case.Name): wrong discovery count" }
        if ($case.Menu -and ($menu -join '') -notmatch [regex]::Escape($case.Menu)) { throw 'Unfamiliar browser missing from menu' }
        if ($case.Message -and ($script:messages -join '') -notmatch [regex]::Escape($case.Message)) { throw 'Missing explanation' }
        if ($case.Browser -and @($script:launches | Where-Object { [IO.Path]::GetFileName($_.Path) -ne $case.Browser }).Count) { throw 'Wrong browser selected' }
        if ($case.Store -and ($script:launches[0].Args -join '') -notmatch [regex]::Escape($case.Store)) { throw 'Wrong official store' }
        if ($case.Settings -and -not @($script:launches | Where-Object { ($_.Args -join '') -like ('*'+$case.Settings+'*') }).Count) { throw 'Wrong browser settings URL' }
        if ($case.Firefox -and $script:launches[0].Args[0] -ne '-new-tab') { throw 'Missing Firefox argument' }
        if ($case.Opens -ge 2 -and ($script:launches[$script:launches.Count-1].Args -join '') -notmatch 'github.io') { throw 'Installer page was not last' }
        if (@($script:launches | Where-Object { ($_.Args -join '') -match 'profile-directory|%1' }).Count) { throw 'Registry arguments leaked into browser invocation' }
        if ($case.FailLaunch -and ($script:messages -join '') -notmatch 'https://le-h4ut.github.io/') { throw 'Missing fallback URL' }
        Microsoft.PowerShell.Utility\Write-Host "PASS: $($case.Name)"
    } $case $source
}
