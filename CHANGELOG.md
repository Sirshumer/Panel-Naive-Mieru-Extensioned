# Changelog — Panel Naive + Mieru by RIXXX

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [v1.2.3] — 2026-05-07

### Breaking Changes
- **Architecture**: `caddy-forwardproxy-naive` is **amd64 (x86_64) only**. ARM64 and ARMv7 are explicitly rejected by the installer with a clear error message.
- **NaiveProxy binary replaced**: standalone `naive` binary removed; replaced by `caddy-forwardproxy-naive` (Caddy with embedded forward-proxy module).
  - Binary path: `/usr/local/bin/caddy-naive`
  - Config: `/etc/caddy-naive/Caddyfile` (replaces `/etc/naive/config.json` + `/etc/naive/htpasswd`)
  - Systemd unit: `caddy-naive.service` (replaces `naive.service`)
  - TLS managed automatically by Caddy via TLS-ALPN-01 (no certbot, no port 80 needed)
- **htpasswd removed**: user authentication now lives directly in the Caddyfile as `basicauth` lines; rebuilt atomically after every user CRUD operation via `applyAllConfigs()`.
- **certbot / apache2-utils removed** from installer dependencies — Caddy handles its own TLS.
- **UFW**: port 80/tcp rule removed (Caddy TLS-ALPN-01 does not need HTTP-01); port 443 comment changed from `NaiveProxy HTTPS` → `CaddyNaive HTTPS`.

### Added
- **Fake site** (`/var/www/fake-site/index.html`): Caddy's `file_server` serves this page to unrecognised clients — provides a plausible "normal website" cover.
- **Probe resistance** (`probe_resistance <secret>`): clients must present the probe-secret token in the `Proxy-Authorization` header; unauthenticated scanners see the fake site instead of an error.
- **`--fake-site-url`** and **`--probe-secret`** CLI arguments added to `install.sh`.
- **`install_caddy_naive()`** function in `install.sh`: fetches latest `caddy-forwardproxy-naive.tar.xz` from `klzgrad/forwardproxy` GitHub releases; falls back to pinned `v2.10.0-naive` URL if GitHub API is unreachable; uses `setcap cap_net_bind_service` so caddy-naive can bind port 443 without running as root.
- **`write_caddyfile()`** in `install.sh`: generates Caddyfile with `forward_proxy { basic_auth … hide_ip hide_via probe_resistance <secret> }` + `file_server { root /var/www/fake-site }`.
- **`setup_fake_site()`** in `install.sh`: writes a minimal HTML landing page.
- **`buildCaddyfile(cfg, users)`** in `panel/server/index.js`: server-side Caddyfile builder called on every user change; writes atomically via `.new` + `rename`.
- **`writeCaddyfileAtomic()`**, **`reloadCaddy()`**, **`restartCaddy()`** in `panel/server/index.js`.
- **`applyAllConfigs()`** in `panel/server/index.js`: unified pipeline — build Caddyfile → reload Caddy → rebuild mita state → apply mita config.
- **`/api/services/rebuild-all`** POST endpoint (requires auth): rebuilds Caddyfile + mita-state from DB; used by `update.sh --repair`.
- **`/api/settings/probe-secret`** POST endpoint: updates `probeSecret` in config, rewrites `probe_secret` file, reloads Caddy.
- **`update_caddy_naive()`** in `update.sh`: replaces `update_naiveproxy()`; checks GitHub API for latest release; falls back to pinned v2.10.0 URL.
- **`rebuild_caddyfile_direct()`** and **`rebuild_mita_state_direct()`** in `update.sh` (`--repair`): Node.js one-liners that reconstruct configs from SQLite without needing the panel to be running.
- **`ensure_caddy_service()`** in `update.sh`: creates `caddy-naive.service` if missing, removes legacy `naive.service`.
- **Probe Secret setting card** in Settings page (`index.html` + `app.js`): masked input + "Apply Secret" button.
- **i18n keys** added to `en.json` and `ru.json`: `settings.probeSecretTitle/Desc/Label/Placeholder/Updated/TooShort/applyProbeSecret`.
- **Diagnostics page** (`app.js`): replaced `htpasswd users: N` counter with `Caddyfile users: N | probe_secret: ✓/✗` display.
- **Smoke tests** in `install.sh`: check `caddy-naive.service` active, Caddyfile present, fake-site `index.html` present, `probe_secret` file present.
- **`uninstall.sh` v1.2.3**: removes `caddy-naive.service`, `caddy-naive` binary, `/etc/caddy-naive/`, `/var/www/fake-site`, legacy `naive.service`/`/etc/naive/`, Certbot renewal hook; UFW rules updated for new comment strings.
- **`panel/package.json`** version bumped to `1.2.3`.

### Changed
- `install.sh` version → `1.2.3`; `update.sh` TARGET_VERSION → `1.2.3`; `panel/server/index.js` → `v1.2.3`; `panel/public/app.js` → `v1.2.3`; `panel/public/index.html` title/sidebar → `v1.2.3`.
- `config.json` now stores `caddyBin`, `caddyFile`, `caddyConfigDir`, `fakeSiteDir`, `fakeSiteUrl`, `probeSecret` fields.
- `/api/status` still returns `services.naive` key (front-end compat) but now reflects `caddy-naive.service` state and caddy binary version.
- `/api/logs/naive` and `/api/logs/caddy` now tail `journalctl -u caddy-naive` (back-compat aliases preserved).
- `/api/service/naive/…` maps to `caddy-naive` via `svcMap` (back-compat).
- `update.sh --status`: shows `caddy-naive` version, Caddyfile user count, fake-site presence, probe-resistance config.
- `update.sh --repair`: calls `/api/services/rebuild-all` first; falls back to direct Node.js DB rebuild.
- Final install banner shows `Probe secret` and `Fake site` values.

### Removed
- `install_naiveproxy()` function (replaced by `install_caddy_naive()`).
- `update_naiveproxy()` function in `update.sh` (replaced by `update_caddy_naive()`).
- `rebuild_htpasswd_from_db()`, `rebuild_naive_config()` functions in `update.sh`.
- `ensure_naive_service()` function (replaced by `ensure_caddy_service()`).
- `certbot`, `apache2-utils` from installer dependencies.
- UFW rule for port 80/tcp (HTTP-01 challenge no longer needed).
- `naive.service` systemd unit (replaced by `caddy-naive.service`).
- `/usr/local/bin/naive` binary (replaced by `/usr/local/bin/caddy-naive`).
- `/etc/naive/config.json` and `/etc/naive/htpasswd` (replaced by `/etc/caddy-naive/Caddyfile`).
- Certbot renewal hook `/etc/letsencrypt/renewal-hooks/deploy/restart-naive.sh` (no longer needed; Caddy auto-renews).

---

## [v1.2.2] — 2026-05-07

### Fixed
- **Bug 1 (P0, frontend)**: Confirmed no inline handlers remain in `index.html`; CSP in `server/index.js` already has `'unsafe-inline'` in `scriptSrc` so dynamically rendered buttons work. Log tab renamed from "Caddy" → "Naive"; `logs.naive` key added to both locale files.
- **Bug 2 (P0, install.sh)**: `certbot certonly` does **not** accept `--cert-path` / `--key-path` flags — they are invalid and cause a non-zero exit even on success. Removed those flags; certs now land in the standard LE path `/etc/letsencrypt/live/<domain>/` which is read directly.
- **Bug 3 (P1, install.sh + index.js)**: UFW rejects `N:N/proto` range syntax when start port equals end port (e.g. `--mieru-start 2015 --mieru-end 2015`), crashing the installer. Added `_ufw_mieru_rule()` helper in `install.sh` that emits a single-port rule (`N/proto`) when start==end, or a range rule otherwise. Same fix applied in `panel/server/index.js` (`ufwMieruRule()` helper used in `/api/settings/mieru-ports` and `/api/settings/udp-toggle`).
- **Bug 4 (P1, install.sh)**: `mita` crashes on start when `users[]` is empty (fresh install has no users). `start_services()` now applies the config (so mita knows the port range) but only actually starts the `mita.service` when at least one user is present in `mita-state.json`. The panel's `rebuildServices()` starts mita automatically after the first user is created.
- **Bug 5 (P2, install.sh)**: TLS cert/key paths now point directly to `/etc/letsencrypt/live/<domain>/fullchain.pem` and `privkey.pem`. Added `chmod o+x` on `/etc/letsencrypt`, `live/`, and `archive/<domain>/` so the naive process (running as root) can traverse the symlink chain. Added `chmod o+r` on `*.pem` files. Renewal hook re-applies these permissions after every `certbot renew`.
- **i18n**: Added `logs.naive`, `diagnostics.naiveValid`, `diagnostics.naiveInvalid`, `login.sessionExpired` keys to `en.json` and `ru.json`.

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
