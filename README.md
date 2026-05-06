# Panel Naive + Mieru — by RIXXX

> Web management panel for **NaiveProxy** + **Mieru** on Ubuntu/Debian VPS.  
> Modelled on [Panel-Naive-Hy2 by RIXXX](https://github.com/cwash797-cmd/Panel---Naive-Hy2---by---RIXXX) — Hysteria2 replaced with Mieru.

[![Telegram](https://img.shields.io/badge/Telegram-Support-blue?logo=telegram)](https://t.me/russian_paradice_vpn)
[![GitHub](https://img.shields.io/badge/GitHub-cwash797--cmd-black?logo=github)](https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX)

---

## Features

| Sprint | Feature |
|--------|---------|
| 1 | Auto-installer: arch detection, NaiveProxy binary, Mieru .deb, systemd units, NTP, UFW, config.json |
| 2 | User CRUD: SQLite model, Caddyfile / Mieru config rebuild on change, expiry cron |
| 3 | Server settings: port changes, traffic-pattern presets, MTU, UFW auto-update |
| 4 | Client configs: Naive link, Mieru sing-box JSON, universal auto-fallback config |
| 5 | Monitoring dashboard: WebSocket live metrics, traffic snapshots, quota alerts |
| 6 | `update.sh`: `--dry-run`, `--force`, `--expose`, `--ssh-only`, `--status`, `--repair`, `--help` |

## Supported OS

| Distro | Versions |
|--------|----------|
| Ubuntu | 20.04, 22.04, 24.04 |
| Debian | 11, 12 |

**Architectures:** `x86_64` (amd64), `aarch64` (arm64), `armv7l` (armhf)

---

## Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX.git
cd Panel-Naive-Mieru-by-RIXXX

# 2. Run the installer as root
sudo bash install.sh
```

The wizard will prompt you for:
- Domain / hostname
- TLS email
- NaiveProxy port (default: `443`)
- Mieru port range (default: `2012–2022`)
- Panel admin credentials
- UFW firewall setup (optional)
- Panel expose mode (SSH-only vs public)

---

## Accessing the Panel

### SSH-only (default, most secure)
```bash
# From your local machine:
ssh -L 3000:127.0.0.1:3000 root@<your-server-ip>
# Then open: http://localhost:3000/
```

### Public mode
```bash
sudo bash update.sh --expose vpn.example.com
# Panel available at http://vpn.example.com:8080/
```

---

## update.sh Reference

```
bash update.sh                   # Interactive update
bash update.sh --dry-run         # Preview changes (no writes)
bash update.sh --force -y        # Force update, non-interactive
bash update.sh --status          # Full health report
bash update.sh --repair          # Restore broken configs from backup
bash update.sh --expose <domain> # Switch to public panel mode
bash update.sh --ssh-only        # Revert to SSH-only mode
```

---

## Important Paths

| Path | Purpose |
|------|---------|
| `/etc/rixxx-panel/config.json` | Panel configuration |
| `/etc/rixxx-panel/version` | Installed version |
| `/etc/rixxx-panel/backups/` | Timestamped backups (last 10 kept) |
| `/etc/caddy-naive/Caddyfile` | Caddy NaiveProxy config |
| `/etc/mita/server.json` | Mieru server config |
| `/etc/mita/users.json` | Mieru users |
| `/var/lib/rixxx-panel/db.sqlite` | SQLite user database |
| `/opt/panel-naive-mieru/` | Panel application files |
| `/usr/local/bin/caddy-naive` | Caddy with naive plugin binary |

---

## Key Commands

```bash
# Service management
systemctl status caddy-naive mita
systemctl restart caddy-naive
systemctl restart mita

# Panel (PM2)
pm2 logs panel-naive-mieru
pm2 restart panel-naive-mieru
pm2 status

# Mieru
mita status
mita describe users
mita describe config
mita apply config /etc/mita/server.json
mita reload

# Caddy
caddy-naive validate --config /etc/caddy-naive/Caddyfile --adapter caddyfile
caddy-naive reload  --config /etc/caddy-naive/Caddyfile --adapter caddyfile

# Panel management
bash update.sh --status          # Health check
bash update.sh --repair          # Fix broken install
bash uninstall.sh                # Full removal
```

---

## Client Configuration

### NaiveProxy
Link format: `naive+https://username:password@domain:443`

Compatible clients:
- [ShadowRocket](https://apps.apple.com/app/shadowrocket/id932747118) (iOS)
- [NekoBox](https://github.com/MatsuriDayo/NekoBoxForAndroid) (Android)
- [naiveproxy](https://github.com/klzgrad/naiveproxy/releases) (CLI)

### Mieru (sing-box)
Download the **Mieru sing-box JSON** or **Universal Config** from the Users page.

Compatible clients:
- [Sing-box](https://apps.apple.com/app/sing-box/id6451272673) (iOS)
- [Sing-box](https://github.com/SagerNet/sing-box/releases) (Android / Windows / Linux / macOS)

### Universal Config (urltest auto-fallback)
Contains both NaiveProxy and Mieru outbounds with `urltest` selector — automatically uses the faster connection.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                   VPS                        │
│                                              │
│  ┌──────────┐  port 443   ┌───────────────┐ │
│  │  Client  │ ──HTTPS──▶  │  caddy-naive  │ │
│  └──────────┘             │  (NaiveProxy) │ │
│                           └───────────────┘ │
│  ┌──────────┐  port 2012- ┌───────────────┐ │
│  │  Client  │ ──TCP/UDP─▶ │     mita      │ │
│  └──────────┘  2022       │    (Mieru)    │ │
│                           └───────────────┘ │
│                                              │
│  ┌──────────────────────────────────────┐   │
│  │    Panel (Node.js + PM2)             │   │
│  │    127.0.0.1:3000  (SSH-only)        │   │
│  │    SQLite DB  │  REST API  │  WS     │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

---

## Security Notes

- Panel runs on `127.0.0.1:3000` by default — not exposed to the internet
- Admin password is bcrypt-hashed in `config.json` (chmod 600)
- SQLite DB is in `/var/lib/rixxx-panel/` (root access only)
- Temporary config files are deleted with `shred -u`
- Rate limiting on login endpoint (20 req/15 min)
- Session cookies are `httpOnly`

---

## Credits

- **Author:** RIXXX
- **Telegram:** [@russian_paradice_vpn](https://t.me/russian_paradice_vpn)
- **Donate:** [lava.top](https://app.lava.top/2107724612?tabId=donate)
- **NaiveProxy:** [klzgrad/naiveproxy](https://github.com/klzgrad/naiveproxy)
- **Mieru:** [enfein/mieru](https://github.com/enfein/mieru)
- **Caddy:** [caddyserver.com](https://caddyserver.com)
