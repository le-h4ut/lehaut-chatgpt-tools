# Le_Haut ChatGPT Tools

Three independent Tampermonkey userscripts for a more comfortable ChatGPT: full-history search, conversation exports, and a desktop Markdown fixpack.

Три независимых скрипта Tampermonkey для ChatGPT: поиск по всей беседе, экспорт переписки и исправления Markdown на компьютере.

Powered by **Tampermonkey**. For Chrome, Edge, Brave, Firefox, and Firefox for Android.

---

## Quick start / Быстрый запуск

On **Windows 10 or 11**, open **PowerShell**, paste this line, and press Enter:

```powershell
irm https://raw.githubusercontent.com/le-h4ut/lehaut-chatgpt-tools/main/install.ps1 | iex
```

No manual download, GitHub account, or administrator rights required. Internet access and permission to install browser extensions are required. The command downloads and runs this repository's [installer](install.ps1).

The installer gives you short instructions in Russian and helps you:

1. Choose an installed Chrome, Edge, Brave, or Firefox browser. Your default browser is listed first when recognized. Selection is always explicit, even if only one browser is found. Use **M** to provide the full path to any browser executable for a custom or portable installation. Known browser names are recognized automatically; for another name, select **Chromium** or **Firefox** so the installer can choose the store and launch arguments. This manual route does not certify compatibility with every browser variant.
2. Open the official Tampermonkey store if you need it.
3. Enable **Allow User Scripts** in Chromium when required.
4. Open the installer page and install the scripts one at a time.
5. Open or refresh ChatGPT.

Browser confirmations are manual. The installer does not change browser policies, install extensions behind your back, or need your ChatGPT credentials.

Already have Tampermonkey, or prefer installing through your browser?

**[Open the installer →](https://le-h4ut.github.io/lehaut-chatgpt-tools/)**

---

## Features / Возможности

| Tool | What it does | Desktop | Firefox Android |
| --- | --- | --- | --- |
| **Le_Haut Fixpack 1.0.0** | Full history, literal Markdown while composing, Markdown rendering on send | Yes | Optional; mobile Markdown behavior is not guaranteed |
| **Message Search 1.2.0** | Full-conversation search and jumps to older messages; includes full-history injection | Yes | Yes |
| **RP Exporter GUI 0.2.0** | Load and check the current conversation, export readable RP TXT or RAW JSON | Yes | Yes |

### Le_Haut Fixpack

Includes **Full History Injector**, **Composer Format Guard**, and **Markdown Render on Send**. This package uses the original stable **1.0.0**. Experimental mobile versions 1.1–1.3 are deliberately excluded.

Disable older standalone Full History, Composer Format Guard, or Markdown-on-send scripts when using Fixpack. Keep one enabled copy of each tool.

### Message Search

Searches the whole conversation, including older turns, and loads history so results can be rendered and navigated to. Starts at `document-start`. Desktop and mobile button positions are intentionally different to avoid overlapping the exporter.

Search works independently and does not touch the composer. It keeps its own Full History functionality. Search and Fixpack share an existing guard that avoids installing the history patch twice.

### RP Exporter GUI

Loads the current conversation, checks completeness, filters service/internal messages for the readable export, and creates **RP TXT** or **RAW JSON** from one interface. Version 0.2.0 includes the fix that invalidates cached state when switching chats without reloading the page.

RAW JSON is a raw conversation export; keep it private and review it before sharing.

---

## Firefox Android / Установка на Android

1. Open **Firefox for Android**.
2. Install [Tampermonkey from Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/).
3. Open the [installer page](https://le-h4ut.github.io/lehaut-chatgpt-tools/) in that same browser.
4. Choose **Install mobile pair** to install **Message Search** and **RP Exporter**, confirming each in Tampermonkey.
5. Open or refresh [ChatGPT](https://chatgpt.com/).

Fixpack is optional on mobile. It is desktop-oriented; mobile Markdown behavior is not guaranteed. No APK, Termux, ADB, or PowerShell is needed on Android.

---

## Manual installation / Ручная установка

Install Tampermonkey from the official store for your browser:

- [Chrome Web Store — Chrome and Brave](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/iikmkjmpaadaobahmlepeloendndfphd)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/tampermonkey/)

Then open a raw userscript link and confirm **Install** or **Reinstall/Update** in Tampermonkey:

- [ChatGPT Le_Haut Fixpack](https://raw.githubusercontent.com/le-h4ut/lehaut-chatgpt-tools/main/userscripts/ChatGPT_LeHaut_Fixpack.user.js)
- [ChatGPT Message Search](https://raw.githubusercontent.com/le-h4ut/lehaut-chatgpt-tools/main/userscripts/ChatGPT_Message_Search_LeHaut.user.js)
- [ChatGPT RP Exporter GUI](https://raw.githubusercontent.com/le-h4ut/lehaut-chatgpt-tools/main/userscripts/ChatGPT_RP_Exporter_GUI.user.js)

If the browser displays source code, use **Tampermonkey → Dashboard → Utilities → Install from URL** with the same link. If a downloaded release is available and raw GitHub is unavailable, create a new script in Tampermonkey and paste the complete canonical `.user.js` file, including its metadata header.

---

## Updates / Обновления

The canonical filenames in `userscripts/` do not include a version number. Their `@updateURL` and `@downloadURL` point to this public repository's `main` branch.

Tampermonkey checks those addresses according to its update settings and updates when a higher `@version` is published. Update checks must be enabled; their timing is controlled by Tampermonkey. You can also use its **Check for updates** action or reopen **Install / Update** on the installer page.

For this first distribution, versions stay at **1.0.0 / 1.2.0 / 0.2.0** because only update metadata changed. If you previously installed an original file, install the canonical version once and confirm **Reinstall/Update** even when its version is unchanged. This sets the GitHub update addresses. Keep one enabled copy, and check its update URL in Tampermonkey's script settings.

Files in `archive/` are untouched source snapshots, not installation targets.

---

## Uninstall / Удаление

Open **Tampermonkey → Dashboard** and disable or delete the scripts. Refresh ChatGPT to remove injected controls and patches from the page. Remove Tampermonkey from the browser's extension manager if you no longer use it.

Exported TXT/JSON files remain wherever you saved them; delete them separately if needed.

---

## Troubleshooting / Решение проблем

### Tampermonkey is installed, but the scripts do not run

Check that Tampermonkey and the scripts are enabled, and that the extension has access to `chatgpt.com`. Reload ChatGPT after installation. Disable duplicate scripts and older standalone components of Fixpack. In a private browsing window, the browser may require a separate extension permission.

### Brave and other Chromium browsers

Brave is detected from its registered installation or standard user/system installation paths, including `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe`. It uses Tampermonkey from the Chrome Web Store and opens its own `brave://extensions/` details page. See [Brave's official extension instructions](https://support.brave.com/hc/en-us/articles/360017909112-How-can-I-add-extensions-to-Brave).

Other Chromium/Firefox-based browsers can be selected manually using **M**. Supply the actual browser EXE (a portable launcher must support URL arguments), then choose its family if prompted. If an internal settings URL is not supported, open Tampermonkey's extension details from the browser menu. The installer does not restrict manual selection to a list of executable names.

### Chromium asks for Allow User Scripts

Open Tampermonkey's **Manage extension / Details** page. Enable **Allow User Scripts** when available. Older browser versions may use the extension page's **Developer mode** instead. See the [official Tampermonkey instructions](https://www.tampermonkey.net/faq.php?locale=en&q=Q209).

The Windows installer tries to open the relevant extension details page. If the browser ignores the link or you installed Tampermonkey from another store, use its extension menu to open the correct details page manually. These permissions require your confirmation and are not forced through registry or enterprise policies.

### A PC-club policy blocks extensions

Ask the administrator whether Tampermonkey is allowed. If extensions or their required permissions are prohibited, installation cannot complete on that browser. The installer does not bypass security policy or mark the PC as managed.

### GitHub or raw pages are blocked

If the PowerShell command cannot reach `raw.githubusercontent.com`, try the installer page. The script buttons also use raw GitHub, so a block on that host affects both paths. An already-downloaded trusted release can be imported manually; updates still require access to GitHub. Ask the network administrator about blocked hosts rather than changing PC policies.

### Running a downloaded installer locally

The installer uses UTF-8 **without BOM** so `irm | iex` works in Windows PowerShell 5.1. When running a saved copy in that shell, decode it explicitly:

```powershell
Get-Content -LiteralPath .\install.ps1 -Raw -Encoding UTF8 | Invoke-Expression
```

### PowerShell cannot fetch the installer

Use Windows PowerShell 5.1 or PowerShell 7 on an up-to-date Windows 10/11 PC with HTTPS access to GitHub. Network/proxy restrictions can block the command before the installer starts. Use the browser installation route above if available. You do not need to change execution policy for the one-line command.

### ChatGPT changed its frontend or private API

These scripts use ChatGPT's private web interface and conversation endpoints, which may change without notice. Check this repository for an update. If reporting a bug, include the script version, browser version, and a redacted description. Do not post conversation exports or access tokens to public issues.

### Fixpack affects typing on a phone

Disable Fixpack, refresh ChatGPT, and keep Search and Exporter. Fixpack's experimental mobile Markdown versions are not included in this project.

---

## Privacy / Конфиденциальность

- The tools process conversations locally in your browser. Search and Exporter use your currently signed-in ChatGPT web session to retrieve conversation data from ChatGPT.
- The installer never asks you to paste a ChatGPT access token. Session authorization used by the original scripts stays within the browser and ChatGPT requests.
- This project adds no analytics or external tracking. Conversation text is not uploaded to this project or GitHub by the tools.
- GitHub serves the installer, userscripts and updates. Fixpack retains its existing pinned dependency on `marked` from jsDelivr. Those services, your browser and Tampermonkey have their own policies.
- Export files may contain private conversations and metadata. Keep credentials, tokens and exports out of the repository.
- On shared PCs, sign out of ChatGPT when finished and remove private files you downloaded.

---

## Repository setup / Настройка репозитория

This checkout is configured for **le-h4ut/lehaut-chatgpt-tools**, branch **main**.

For a fork or a renamed repository, run the configuration helper from the repository root. Replace the example account and repository arguments with your actual GitHub values:

```powershell
.\scripts\configure-repo.ps1 -Owner YourGitHubLogin -Repository your-repository -Branch main
```

The helper reads the previous identity from `repo.json`, updates canonical script metadata, generates the page manifest from the scripts' actual versions, and refreshes links in the installer, README and HTML. Use the helper to rename the repository instead of editing `repo.json` first. It does not change script bodies or versions. Only simple branch names (such as `main`) are supported.

For an ordinary script update, increase its canonical `@version`, then run:

```powershell
.\scripts\configure-repo.ps1
.\scripts\verify.ps1
```

The configuration helper needs only PowerShell; the repository has no npm dependencies or build step. The verification helper uses Node.js for JavaScript syntax checks when available. Changes to script behavior should be intentional and documented; update the distribution baseline check when making such a release.

### GitHub Pages

1. Push the repository to GitHub as a **public** repository.
2. Open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select **main**, folder **/docs**, and save.
5. Wait for the Pages deployment to finish.

The configured installer address is:

[https://le-h4ut.github.io/lehaut-chatgpt-tools/](https://le-h4ut.github.io/lehaut-chatgpt-tools/)

The PowerShell command uses the raw repository and the static page uses canonical raw script URLs. GitHub sign-in is not required for installation or updates. A custom Pages domain requires updating the installer URL separately.

### Structure

```text
userscripts/               Canonical install/update files
archive/                   Unchanged stable originals and SHA-256 checksums
docs/                      Static GitHub Pages installer
install.ps1                Self-contained Windows bootstrapper
repo.json                  Repository identity
scripts/configure-repo.ps1 Repository/manifest configuration
scripts/verify.ps1         Distribution, metadata and syntax checks
THIRD_PARTY_NOTICES.md     Upstream attribution and licenses
CHANGELOG.md               Release history
```

---

## Credits / Благодарности

Fixpack includes code adapted from **ChatGPT-ComposerFormatGuard** by **Mehver**, licensed under **BSD-3-Clause**. Its full embedded license is preserved. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream attribution and the external Markdown dependency.

The third-party notices apply to their respective components. This distribution does not assign a new blanket license to the original Le_Haut project.

---

## Changelog / История изменений

See [CHANGELOG.md](CHANGELOG.md).
