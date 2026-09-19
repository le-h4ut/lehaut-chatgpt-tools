#requires -Version 5.1
# Works both as a file and through: irm <raw URL>/install.ps1 | iex
# Deliberately self-contained: no sibling files, profile parsing or policy edits.
& {
    $ErrorActionPreference = 'Stop'
    $pagesUrl = 'https://le-h4ut.github.io/lehaut-chatgpt-tools/'
    function Read-RegistryValue([string]$Path, [string]$Name = '') {
        $key = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
        if ($null -ne $key) { return [string]$key.GetValue($Name) }
        return ''
    }

    function Get-ExecutablePath([string]$Command) {
        # Parse the executable only. Never evaluate a registry command or replay its flags.
        $commandText = [Environment]::ExpandEnvironmentVariables($Command).Trim()
        $path = ''
        if ($commandText -match '^"([^"\r\n]+\.exe)"(?:\s|$)') { $path = $Matches[1] }
        elseif ($commandText -match '^([^"\r\n]+?\.exe)(?:\s|$)') { $path = $Matches[1].Trim() }
        if ($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or
            -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
        return [IO.Path]::GetFullPath($path)
    }

    function Set-BrowserFamily($Browser, [string]$Family) {
        $Browser.Family = $Family
        $Browser.Store = ''
        $Browser.Settings = ''
        if ($Family -eq 'Firefox') {
            $Browser.Store = 'https://addons.mozilla.org/firefox/addon/tampermonkey/'
        } elseif ($Family -eq 'Chromium') {
            $Browser.Store = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo'
            $Browser.Settings = 'chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo'
        }
    }

    function New-BrowserCandidate([string]$Name, [string]$Command, [string[]]$ProgIds, [string]$DefaultId) {
        $path = Get-ExecutablePath $Command
        if (-not $path) { return $null }
        $file = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        $product = [string]$file.VersionInfo.ProductName
        if (-not $Name -or $Name.StartsWith('@')) {
            $Name = $product
            if (-not $Name) { $Name = [IO.Path]::GetFileNameWithoutExtension($path) }
        }
        $browser = [pscustomobject]@{
            Name = $Name; Path = $path; Family = ''; Store = ''; Settings = ''
            IsDefault = (-not [string]::IsNullOrEmpty($DefaultId) -and $ProgIds -contains $DefaultId)
        }
        # Recognition chooses setup instructions; it never controls which registered browsers are discovered.
        $identity = "$Name $product $([IO.Path]::GetFileName($path))"
        if ($identity -match 'iexplore\.exe|Internet Explorer') {
            $browser.Family = 'Unsupported'
        } elseif ($identity -match 'Firefox|Waterfox|LibreWolf|Floorp|\bZen\b') {
            Set-BrowserFamily $browser 'Firefox'
        } elseif ($identity -match 'Chrome|Chromium|Brave|Opera|Vivaldi|Yandex|Microsoft Edge|msedge\.exe') {
            Set-BrowserFamily $browser 'Chromium'
            if ($identity -match 'Microsoft Edge|msedge\.exe') {
                $browser.Store = 'https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd'
                $browser.Settings = 'edge://extensions/?id=iikmkjmpaadaobahmlepeloendndfphd'
            } elseif ($identity -match 'Brave') {
                $browser.Settings = 'brave://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo'
            } elseif ($identity -match 'Opera') {
                $browser.Settings = 'opera://extensions/'
            }
        }
        return $browser
    }

    function Get-ProgIdCommand([string]$ProgId) {
        if (-not $ProgId) { return '' }
        foreach ($hive in @('HKCU:', 'HKLM:')) {
            $command = Read-RegistryValue "$hive\SOFTWARE\Classes\$ProgId\shell\open\command"
            if ($command) { return $command }
        }
        return ''
    }

    function Get-RegisteredBrowsers([string]$DefaultId) {
        $candidates = @(
            foreach ($hive in @('HKCU:', 'HKLM:')) {
                foreach ($base in @('SOFTWARE\Clients\StartMenuInternet', 'SOFTWARE\WOW6432Node\Clients\StartMenuInternet')) {
                    foreach ($client in Get-ChildItem -LiteralPath "$hive\$base" -ErrorAction SilentlyContinue) {
                        $command = Read-RegistryValue "$($client.PSPath)\shell\open\command"
                        $associations = Get-ItemProperty -LiteralPath "$($client.PSPath)\Capabilities\URLAssociations" -ErrorAction SilentlyContinue
                        New-BrowserCandidate -Name ([string]$client.GetValue('')) -Command $command -ProgIds @($associations.http, $associations.https) -DefaultId $DefaultId
                    }
                }
                foreach ($base in @('SOFTWARE\RegisteredApplications', 'SOFTWARE\WOW6432Node\RegisteredApplications')) {
                    $registered = Get-Item -LiteralPath "$hive\$base" -ErrorAction SilentlyContinue
                    if ($null -eq $registered) { continue }
                    foreach ($appName in $registered.GetValueNames()) {
                        $capabilityPath = [string]$registered.GetValue($appName)
                        if (-not $capabilityPath) { continue }
                        $capabilities = "$hive\$capabilityPath"
                        $associations = Get-ItemProperty -LiteralPath "$capabilities\URLAssociations" -ErrorAction SilentlyContinue
                        # Include applications registered as HTTP(S) handlers, not unrelated registered apps.
                        $ids = @($associations.https, $associations.http) | Where-Object { $_ }
                        if (-not $ids) { continue }
                        $name = Read-RegistryValue $capabilities 'ApplicationName'
                        if (-not $name) { $name = $appName }
                        foreach ($id in $ids) {
                            New-BrowserCandidate -Name $name -Command (Get-ProgIdCommand $id) -ProgIds $ids -DefaultId $DefaultId
                        }
                    }
                }
            }
            # Covers a default HTTP browser without a StartMenuInternet/RegisteredApplications entry.
            if ($DefaultId) {
                New-BrowserCandidate -Name '' -Command (Get-ProgIdCommand $DefaultId) -ProgIds @($DefaultId) -DefaultId $DefaultId
            }
        )
        $unique = @{}
        foreach ($candidate in $candidates) {
            if ($null -eq $candidate) { continue }
            $key = $candidate.Path.ToLowerInvariant()
            if ($unique.ContainsKey($key)) {
                if ($candidate.IsDefault) { $unique[$key].IsDefault = $true }
            } else { $unique[$key] = $candidate }
        }
        return @($unique.Values | Sort-Object -Property @{ Expression = 'IsDefault'; Descending = $true }, Name, Path)
    }

    function Confirm-BrowserFamily($Browser) {
        if ($Browser.Family -eq 'Unsupported') {
            Write-Host 'Этот устаревший браузер не поддерживает необходимый вариант Tampermonkey.' -ForegroundColor Yellow
            return $false
        }
        if ($Browser.Family) { return $true }
        Write-Host "Браузер найден: $($Browser.Name). Выберите его семейство для установки расширения."
        Write-Host '1. Chromium (Chrome Web Store)'
        Write-Host '2. Firefox (Firefox Add-ons)'
        while ($true) {
            $choice = Read-Host 'Семейство браузера [1/2/Q — назад]'
            if ($choice -match '^\s*[QqЙй]\s*$') { return $false }
            if ($choice.Trim() -eq '1') { Set-BrowserFamily $Browser 'Chromium'; return $true }
            if ($choice.Trim() -eq '2') { Set-BrowserFamily $Browser 'Firefox'; return $true }
            Write-Host 'Введите 1, 2 или Q.'
        }
    }


    function Open-BrowserPage($Browser, [string]$Url) {
        try {
            # FilePath is separate from arguments, so spaces and Cyrillic paths work.
            # This is the interactive browser the user selected, not a hidden helper.
            $arguments = @('"' + $Url + '"')
            if ($Browser.Family -eq 'Firefox') { $arguments = @('-new-tab') + $arguments }
            Start-Process -FilePath $Browser.Path -ArgumentList $arguments -ErrorAction Stop | Out-Null
            return $true
        } catch {
            Write-Host 'Не удалось открыть страницу автоматически. Откройте её в выбранном браузере:' -ForegroundColor Yellow
            Write-Host $Url
            return $false
        }
    }

    function Confirm-Step([string]$Message) {
        $answer = Read-Host "$Message [Enter — продолжить / Q — выйти]"
        return ($answer -notmatch '^\s*[QqЙй]\s*$')
    }

    try {
        if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
            Write-Host "Этот помощник предназначен для Windows. Откройте $pagesUrl в браузере."
            return
        }
        Write-Host ''
        Write-Host 'Le_Haut ChatGPT Tools' -ForegroundColor Cyan
        Write-Host 'Установка через Tampermonkey. Права администратора не нужны.'
        Write-Host 'Q — отмена на любом шаге.'
        $defaultId = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue).ProgId
        $discovered = @(Get-RegisteredBrowsers $defaultId)
        $available = @($discovered | Where-Object { $_.Family -ne 'Unsupported' })
        Write-Host 'Браузеры, зарегистрированные в Windows:'
        foreach ($unsupported in $discovered | Where-Object { $_.Family -eq 'Unsupported' }) {
            Write-Host ("Пропущен: " + $unsupported.Name + ' — не поддерживает необходимое расширение.')
        }
        if ($available.Count -eq 0) {
            Write-Host 'Регистрации подходящих браузеров не найдены. Для незарегистрированной или portable-версии используйте M.' -ForegroundColor Yellow
        }
        for ($i = 0; $i -lt $available.Count; $i++) {
            $suffix = ''
            if ($available[$i].IsDefault) { $suffix = ' (по умолчанию)' }
            Write-Host ('{0}. {1}{2}' -f ($i + 1), $available[$i].Name, $suffix)
        }
        Write-Host 'M. Указать EXE другого или portable-браузера вручную'
        Write-Host 'Q. Выйти'
        $selected = $null
        while ($null -eq $selected) {
            $choice = Read-Host 'Введите номер, M или Q'
            if ($choice -match '^\s*[QqЙй]\s*$') { return }
            if ($choice -match '^\s*[MmЬь]\s*$') {
                $manualPath = (Read-Host 'Полный путь к EXE браузера (Q — назад)').Trim().Trim('"')
                if ($manualPath -match '^\s*[QqЙй]\s*$') { continue }
                $manualPath = [Environment]::ExpandEnvironmentVariables($manualPath)
                $candidate = New-BrowserCandidate -Name '' -Command ('"' + $manualPath + '"') -ProgIds @() -DefaultId ''
                if (-not $candidate) {
                    Write-Host 'Укажите полный путь к существующему EXE-файлу браузера.' -ForegroundColor Yellow
                    continue
                }
                if (Confirm-BrowserFamily $candidate) { $selected = $candidate }
                continue
            }
            $number = 0
            if ([int]::TryParse($choice, [ref]$number) -and $number -ge 1 -and $number -le $available.Count) {
                $candidate = $available[$number - 1]
                if (Confirm-BrowserFamily $candidate) { $selected = $candidate }
            } else {
                Write-Host 'Введите номер из списка, M для ручного выбора или Q для выхода.'
            }
        }
        Write-Host ("Браузер: " + $selected.Name)
        while ($true) {
            $answer = Read-Host 'Tampermonkey уже установлен и включён в этом браузере? [Y/N/Q]'
            if ($answer -match '^\s*[QqЙй]\s*$') { return }
            if ($answer -match '^\s*(y|yes|д|да)\s*$') { break }
            if ($answer -match '^\s*(n|no|н|нет)\s*$') {
                $null = Open-BrowserPage $selected $selected.Store
                Write-Host 'Установите Tampermonkey из официального магазина и подтвердите запрос браузера.'
                Write-Host 'Если установка запрещена правилами этого ПК, обратитесь к администратору или нажмите Q.'
                if (-not (Confirm-Step 'После установки вернитесь сюда.')) { return }
                break
            }
            Write-Host 'Введите Y (да), N (нет) или Q (выход).'
        }
        if ($selected.Settings) {
            $null = Open-BrowserPage $selected $selected.Settings
            Write-Host 'В настройках Tampermonkey включите «Разрешить пользовательские скрипты» / Allow User Scripts.'
            Write-Host 'Если переключателя нет, откройте список расширений и включите «Режим разработчика» / Developer mode.'
            Write-Host 'Если открылась пустая вкладка: меню Tampermonkey → Управление расширением → разрешение скриптов.'
            Write-Host 'Если Tampermonkey установлен из другого магазина, выберите его вручную в списке расширений.'
            if (-not (Confirm-Step 'После настройки вернитесь сюда.')) { return }
        }
        $null = Open-BrowserPage $selected $pagesUrl
        Write-Host 'На странице нажмите Install all и подтвердите установку каждого скрипта в Tampermonkey.'
        Write-Host 'Затем откройте или обновите ChatGPT. Вход в GitHub не нужен.'
        Write-Host "Страница установки: $pagesUrl"
    } catch {
        Write-Host 'Установка не завершена. Можно продолжить через страницу в браузере:' -ForegroundColor Yellow
        Write-Host $pagesUrl
        Write-Host 'Если доступ ограничен политикой ПК или сети, обратитесь к администратору.'
    }
}
