#requires -Version 5.1
# Works both as a file and through: irm <raw URL>/install.ps1 | iex
# Deliberately self-contained: no sibling files, profile parsing or policy edits.
& {
    $ErrorActionPreference = 'Stop'
    $pagesUrl = 'https://le-h4ut.github.io/lehaut-chatgpt-tools/'
    $browserDefinitions = @(
        [pscustomobject]@{
            Family = 'Chromium'; Name = 'Google Chrome'; Exe = 'chrome.exe'; ProgId = 'ChromeHTML'
            RelativePath = 'Google\Chrome\Application\chrome.exe'
            Store = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo'
            Settings = 'chrome://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo'
        },
        [pscustomobject]@{
            Family = 'Chromium'; Name = 'Microsoft Edge'; Exe = 'msedge.exe'; ProgId = 'MSEdgeHTM'
            RelativePath = 'Microsoft\Edge\Application\msedge.exe'
            Store = 'https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd'
            Settings = 'edge://extensions/?id=iikmkjmpaadaobahmlepeloendndfphd'
        },
        [pscustomobject]@{
            Family = 'Chromium'; Name = 'Brave'; Exe = 'brave.exe'; ProgId = 'BraveHTML'
            RelativePath = 'BraveSoftware\Brave-Browser\Application\brave.exe'
            Store = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo'
            Settings = 'brave://extensions/?id=dhdgffkkebhmkfjojejmpbldmpobfkfo'
        },
        [pscustomobject]@{
            Family = 'Firefox'; Name = 'Mozilla Firefox'; Exe = 'firefox.exe'; ProgId = 'FirefoxURL'
            RelativePath = 'Mozilla Firefox\firefox.exe'
            Store = 'https://addons.mozilla.org/firefox/addon/tampermonkey/'
            Settings = ''
        }
    )

    function Find-BrowserPath($Definition) {
        # Registered installs first. Do not scan disks or inspect browser profiles.
        foreach ($hive in @('HKCU:', 'HKLM:')) {
            foreach ($key in @('SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths')) {
                $reg = Get-Item -LiteralPath "$hive\$key\$($Definition.Exe)" -ErrorAction SilentlyContinue
                if ($null -ne $reg) {
                    $path = [Environment]::ExpandEnvironmentVariables([string]$reg.GetValue('')).Trim('"')
                    if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
                }
            }
        }
        foreach ($base in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
            if ($base) {
                $path = Join-Path $base $Definition.RelativePath
                if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
            }
        }
        return $null
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
        $available = @(
            foreach ($definition in $browserDefinitions) {
                $path = Find-BrowserPath $definition
                if ($path) {
                    [pscustomobject]@{
                        Family = $definition.Family; Name = $definition.Name; Path = $path; Store = $definition.Store; Settings = $definition.Settings
                        IsDefault = ([string]$defaultId -like "$($definition.ProgId)*")
                    }
                }
            }
        )
        $available = @($available | Sort-Object -Property @{ Expression = 'IsDefault'; Descending = $true })
        Write-Host 'Автопоиск: Chrome, Edge, Brave и Firefox. Другой браузер можно указать вручную.'
        if ($available.Count -eq 0) {
            Write-Host 'Автоматически не найден ни один из поддерживаемых браузеров.' -ForegroundColor Yellow
        } elseif ($available.Count -eq 1) {
            Write-Host 'Автоматически найден только один поддерживаемый браузер:'
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
                if (-not [IO.Path]::IsPathRooted($manualPath) -or
                    [IO.Path]::GetExtension($manualPath) -ine '.exe' -or
                    -not (Test-Path -LiteralPath $manualPath -PathType Leaf)) {
                    Write-Host 'Укажите полный путь к существующему EXE-файлу браузера.' -ForegroundColor Yellow
                    continue
                }
                $definition = $browserDefinitions | Where-Object { $_.Exe -eq [IO.Path]::GetFileName($manualPath) } | Select-Object -First 1
                if (-not $definition) {
                    Write-Host 'Имя браузера не распознано. Укажите его семейство для выбора магазина и параметров запуска.'
                    Write-Host '1. Chromium (Chrome Web Store)'
                    Write-Host '2. Firefox (Firefox Add-ons)'
                    while ($true) {
                        $familyChoice = Read-Host 'Семейство браузера [1/2/Q — назад]'
                        if ($familyChoice -match '^\s*[QqЙй]\s*$') { break }
                        if ($familyChoice.Trim() -eq '1') { $definition = $browserDefinitions[0]; break }
                        if ($familyChoice.Trim() -eq '2') { $definition = $browserDefinitions | Where-Object { $_.Family -eq 'Firefox' } | Select-Object -First 1; break }
                        Write-Host 'Введите 1, 2 или Q.'
                    }
                    if (-not $definition) { continue }
                    $browserName = [IO.Path]::GetFileNameWithoutExtension($manualPath)
                    Write-Host 'Используется стандартный маршрут выбранного семейства; совместимость конкретного браузера не проверена.'
                } else {
                    $browserName = $definition.Name
                }
                $selected = [pscustomobject]@{
                    Family = $definition.Family; Name = $browserName; Path = $manualPath; Store = $definition.Store; Settings = $definition.Settings
                    IsDefault = $false
                }
                continue
            }
            $number = 0
            if ([int]::TryParse($choice, [ref]$number) -and $number -ge 1 -and $number -le $available.Count) {
                $selected = $available[$number - 1]
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
