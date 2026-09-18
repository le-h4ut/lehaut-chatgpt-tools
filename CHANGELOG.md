# Changelog

## [v1.0.1] - 2026-09-18

### Fixed

- Removed the UTF-8 BOM from the bootstrapper: Windows PowerShell 5.1 could interpret it as part of the first command when using `irm | iex`.
- Always ask which browser to use, even when only Edge is detected. Explain the detection result and support a manual executable path for custom browser installations.
- Check execution of downloaded installer text, not just parsing. Userscript code and versions are unchanged.

## [v1.0.0] - 2026-09-18

Initial distribution release. This is the repository release version; individual userscript versions remain unchanged.

### Added

- Public GitHub distribution with stable raw installation and update URLs.
- Responsive dark installer with individual installs, a guided three-script setup, and a Firefox Android two-script setup.
- Windows PowerShell bootstrapper for Chrome, Edge and Firefox, with Russian instructions and official extension store links.
- Copyable PowerShell quick-start command, repository configuration helper and integrity checks.
- Documentation, upstream notices and untouched original snapshots with SHA-256 checksums.

### Preserved

- Fixpack **1.0.0**, Search **1.2.0**, and RP Exporter **0.2.0**.
- Original userscript bodies, metadata permissions, namespaces, run timing and attribution.
- Full History injection in Search, the exporter chat-switch fix, and existing desktop/mobile button placement.

Only `@updateURL` and `@downloadURL` were added to the canonical script headers. Experimental mobile Fixpack versions 1.1–1.3 remain excluded.
