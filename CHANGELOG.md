# Changelog — Panel Naive + Mieru by RIXXX

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v1.1.0] — 2026-05-06

### Added
- **Bilingual UI** — Russian (default) and English, language selector in header, stored in `localStorage`
- **Locale files** `panel/public/locales/ru.json` and `panel/public/locales/en.json`
- **Dark / Light theme toggle** — dark mode default, sun/moon switch persisted in `localStorage`
- **Redesigned CSS palette** — dark gradient `#1a1a1d → #2c2c30`, bronze accent `#c08552`, glassmorphism cards
- **QR-code generation** for Naive links (iOS/Android import via QR)
- **Karing client** added to recommended client lists (iOS / Android / Windows / macOS / Linux)
- **README.ru.md** — primary Russian documentation with architecture diagram, troubleshooting, client tables
- **README.en.md** — English documentation
- Language-switch links at top of both READMEs
- **CHANGELOG.md** — this file
- **LICENSE** — MIT license
- Corrected `/etc/mita/` documentation: internal protobuf store, not edited manually
- `mita-state.json` correctly documented at `/var/lib/rixxx-panel/mita-state.json`
- Troubleshooting section (top-5 fixes) in both READMEs
- Uninstall documentation with `--keep-configs` flag
- Donation / Telegram links prominently placed in READMEs

### Fixed
- Removed incorrect `/etc/mita/server.json` and `/etc/mita/users.json` references from docs
- `buildMitaStateFile()` now correctly uses `/var/lib/rixxx-panel/mita-state.json`
- `reloadMieru()` / `restartMieru()` verified to use correct state file path

### Changed
- `README.md` is now the primary Russian README (language switch link at top)
- CSS accent color changed from blue `#6c8ef5` to bronze `#c08552` per product identity

---

## [v1.0.0] — 2026-05-05

### Added
- **Sprint 1 — Installer** (`install.sh`)
  - Automatic OS detection (Ubuntu 20.04/22.04/24.04, Debian 11/12)
  - Architecture detection (x86_64, aarch64, armv7l)
  - NaiveProxy binary download from GitHub releases API
  - Mieru `.deb` install from enfein/mieru GitHub releases
  - NTP sync enforcement via `timedatectl`
  - Bilingual prompts (Russian default, English option)
  - Interactive setup wizard: domain, TLS email, Naive port (443), Mieru port range (2012-2022)
  - Optional UFW setup
  - Config stored at `/etc/rixxx-panel/config.json`
  - `mita-state.json` built and applied via `mita apply config`
  - Smoke tests (caddy-naive, mita, panel HTTP, time sync)
  - Idempotent reinstall support with backup

- **Sprint 2 — User CRUD**
  - SQLite model: id, email, username, password-hash, plain password (for mita), expiry, protocols, quota, timestamps
  - On create/update: rebuild Caddyfile + reload caddy-naive, rebuild Mieru JSON + `mita apply config` + `mita reload`
  - Expiry cron every 5 minutes
  - UI table with Edit / Config / Delete actions

- **Sprint 3 — Server Settings**
  - NaiveProxy port change: Caddy reload only (no restart)
  - Mieru port range change: UFW update + full `mita stop && mita start`
  - Traffic pattern presets: NOOP, RANDOM_PADDING, RANDOM_PADDING_AGGRESSIVE
  - MTU setting (1280–1400)
  - UI warning after port changes

- **Sprint 4 — Client Configs**
  - Naive link: `naive+https://username:password@domain:443`
  - Mieru sing-box JSON template
  - Universal config: NaiveProxy + Mieru + `urltest` auto-fallback selector
  - Download buttons in UI

- **Sprint 5 — Monitoring Dashboard**
  - Per-user traffic snapshots every 60 s
  - Live WebSocket metrics every 5 s (CPU, RAM, service status)
  - System metrics: CPU, RAM, Disk, uptime, OS, arch, service versions
  - Quota alerts (>80% warn, >95% danger)
  - `mita describe users` parser (handles version differences)

- **Sprint 6 — update.sh**
  - Flags: `--dry-run`, `--force`, `--expose <domain>`, `--ssh-only`, `--status`, `--repair`, `--help`
  - Backups in `/etc/rixxx-panel/backups/YYYY-MM-DD-HHMMSS/` (keeps last 10)
  - Version file at `/etc/rixxx-panel/version`
  - GitHub API version comparison for NaiveProxy and Mieru
  - Health-check commands after install/update
  - `--repair` rebuilds JSON from SQLite

- **uninstall.sh** — full cleanup with `shred`, `--keep-configs` flag
- **panel/server/index.js** — Express backend, REST API, WebSocket, SQLite, cron jobs
- **panel/public/** — SPA HTML + CSS + JS (login, dashboard, users, settings, monitoring, logs, diagnostics)
- **panel/package.json** — Node.js dependencies (Express, better-sqlite3, bcryptjs, ws, node-cron, systeminformation, etc.)
- **panel/scripts/** — standalone `install_naiveproxy.sh`, `install_mieru.sh`, `sysctl_tune.sh`

---

[v1.1.0]: https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/compare/v1.0.0...v1.1.0
[v1.0.0]: https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX/releases/tag/v1.0.0
