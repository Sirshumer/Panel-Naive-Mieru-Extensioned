# Changelog — Panel Naive + Mieru by RIXXX

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v1.2.1] — 2026-05-07

### Fixed
- **Critical #1**: `detect_arch()` x86_64 mapping corrected — `NAIVE_ARCH` now set to `linux-x64` (was `linux-amd64`) in both `install.sh` and `update.sh`, matching the actual NaiveProxy release asset suffix
- **Minor #6**: jq asset-selection loop now tries fallback aliases `linux-amd64` → `linux-x86_64` after primary `linux-x64` for x86_64 hosts, protecting against future upstream asset-name changes (both scripts)
- **Blocker #3**: `do_status` in `update.sh` no longer fails when `naive --version` returns empty — wrapped with `|| echo 'installed'` fallback
- **Minor #7**: `naive --version` smoke-test wrapped with `timeout 5` in both `install.sh` and `update.sh` to avoid hanging if the binary stalls at startup
- **Minor #4**: Admin password generation replaced `tr -dc` (may produce shell-special chars) with `openssl rand -base64 18 | tr -d '/+='` — 20-char alphanumeric output, no shell quoting issues
- **Blocker #2**: Confirmed `rebuild_mita_state()` reads the `password` column (plaintext) — not `passHash` (bcrypt) — when constructing the JSON passed to `mita apply config`; no regression
- **Minor #5**: README.md / README.en.md — ARM64 and ARMv7 architectures marked *experimental, not tested in production*

---

## [v1.2.0] — 2026-05-07

### Breaking Changes
- **NaiveProxy binary** changed from `caddy-naive` to standalone `naive` binary
  - Binary path: `/usr/local/bin/naive` (was `/usr/local/bin/caddy-naive`)
  - Config: `/etc/naive/config.json` + `/etc/naive/htpasswd` (was Caddyfile)
  - Systemd unit: `naive.service` (was `caddy-naive.service`)
  - Run `bash update.sh --repair` to migrate an existing v1.1.x install

### Added
- **Blocker 1**: Strict architecture asset matching — `endswith("-" + arch + ".tar.xz")` with no Linux fallback
- **Blocker 2**: `NAIVE_BIN=/usr/local/bin/naive`, `NAIVE_CONFIG_DIR=/etc/naive`; searches for `naive`/`naiveproxy` binary in archive
- **Blocker 3**: `/etc/naive/config.json` with `listen`, `name`, `auth` (htpasswd path), `padding`, `log`
- **Blocker 4**: `naive.service` systemd unit; old `caddy-naive.service` removed on install/repair
- **Blocker 5**: Smoke tests — `naive --version`, `systemctl is-active naive`, port-listen check
- **Blocker 6**: `update.sh --repair` rebuilds htpasswd + naive config + mita-state from SQLite; `--status` shows naive version, config, htpasswd user count
- **Blocker 7**: `buildHtpasswd(users)` + `buildNaiveConfig()` in `server/index.js`; all user CRUD rebuilds htpasswd + reloads naive
- **Blocker 8**: Post-start Mieru port-listen check in smoke tests and `/api/diagnostics`
- **Blocker 9**: Installer output captured to `/var/log/rixxx-panel-install.log`
- **Blocker 10**: `--non-interactive`/`--force` flags; `--domain`, `--email`, `--admin-pass` etc. CLI args
- **Blocker 11**: Version file at `/etc/rixxx-panel/version` with key=value format (`panel_version`, `naive_version`, `mieru_version`, `installed_at`)
- **Blocker 12**: Generic listen `"https://:PORT"` in naive config; `"name": "${DOMAIN}"` for logging
- **Blocker 13**: Certbot step in `install.sh`; `cert`/`key` paths in config.json; renewal hook
- **Blocker 14**: `fmtLastSeen(iso)` in `app.js` — shows "X min ago / Xh ago / Xd ago" in tables
- **Blocker 15**: GitHub Actions CI matrix in `.github/workflows/ci.yml` — Ubuntu 24.04, 22.04, Debian 12
- `apache2-utils` and `certbot` added to `install_deps()`
- UFW opens port 80/tcp for Certbot HTTP-01 challenges
- `uninstall.sh` removes naive paths, legacy caddy-naive artifacts, Certbot hook

### Changed
- `install.sh` version bumped to `1.2.0`
- `update.sh` TARGET_VERSION bumped to `1.2.0`
- `panel/package.json` version bumped to `1.2.0`
- `panel/server/index.js` bumped to `v1.2.0`
- `panel/public/app.js` bumped to `v1.2.0`
- `/api/logs/caddy` aliased to `naive` logs for back-compat
- `/api/service/caddy-naive/…` aliased to `naive` for back-compat

### Fixed
- `update.sh --status` shows naive binary version
- `update.sh --repair` rebuilds from live DB without requiring a backup
- `uninstall.sh` cleans all v1.2.0 paths and legacy caddy-naive artifacts

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
