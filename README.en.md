[🇷🇺 Русский](README.md) | [🇬🇧 English](README.en.md)

---

<div align="center">

# 🛡 Panel Naive + Mieru by RIXXX

**v1.0.0** — Web management panel for NaiveProxy + Mieru on Ubuntu/Debian VPS

[![Telegram](https://img.shields.io/badge/Telegram-@russian__paradice__vpn-2CA5E0?logo=telegram&logoColor=white)](https://t.me/russian_paradice_vpn)
[![GitHub](https://img.shields.io/badge/GitHub-cwash797--cmd-181717?logo=github)](https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX)
[![License](https://img.shields.io/badge/License-MIT-bronze?color=c08552)](LICENSE)

> 💬 **Support & updates:** [t.me/russian_paradice_vpn](https://t.me/russian_paradice_vpn)  
> ☕ **Support the project:** [app.lava.top/2107724612](https://app.lava.top/2107724612?tabId=donate)

</div>

---

## ✨ Features

| Sprint | Feature |
|--------|---------|
| 1 | Auto-installer: arch detection, NaiveProxy binary, Mieru .deb, systemd units, NTP, UFW, config.json |
| 2 | User CRUD: SQLite model, Caddyfile / Mieru config rebuild on change, expiry cron |
| 3 | Server settings: port changes, traffic-pattern presets, MTU, UFW auto-update |
| 4 | Client configs: Naive link, Mieru sing-box JSON, universal auto-fallback config, QR codes |
| 5 | Monitoring dashboard: WebSocket live metrics, traffic snapshots, quota alerts |
| 6 | `update.sh`: `--dry-run`, `--force`, `--expose`, `--ssh-only`, `--status`, `--repair`, `--help` |

---

## 🖥 Supported OS

| Distro | Versions |
|--------|----------|
| Ubuntu | 20.04, 22.04, 24.04 |
| Debian | 11, 12 |

**Architectures:** `x86_64` (amd64) · `aarch64` (arm64) *(experimental, not tested in production)* · `armv7l` (armhf) *(experimental, not tested in production)*

---

## 🚀 Quick Start

```bash
# 1. Clone the repository
git clone https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX.git
cd Panel-Naive-Mieru-by-RIXXX

# 2. Run the installer as root
sudo bash install.sh
```

The wizard will prompt you for:
- Language (Russian / English) — **first question**
- Domain / hostname
- TLS email
- NaiveProxy port (default: `443`)
- Mieru port range (default: `2012-2022`)
- Panel admin credentials
- UFW firewall setup (optional)
- Panel expose mode (SSH-only vs public)

---

## 🔒 Accessing the Panel

### SSH-only (default, most secure)
```bash
# From your local machine:
ssh -L 3000:127.0.0.1:3000 root@<your-server-ip>
# Then open: http://localhost:3000/
```

### Public mode
```bash
sudo bash update.sh --expose vpn.example.com
# Panel available at: http://vpn.example.com:8080/
```

---

## 📁 Important Paths

| Path | Purpose |
|------|---------|
| `/etc/rixxx-panel/config.json` | Panel configuration |
| `/etc/rixxx-panel/version` | Installed version |
| `/etc/rixxx-panel/backups/` | Timestamped backups (last 10 kept) |
| `/etc/caddy-naive/Caddyfile` | Caddy NaiveProxy config |
| `/var/lib/rixxx-panel/mita-state.json` | Mieru JSON state (applied via `mita apply config`) |
| `/var/lib/rixxx-panel/db.sqlite` | SQLite user database |
| `/opt/panel-naive-mieru/` | Panel application files |
| `/usr/local/bin/caddy-naive` | Caddy with naive plugin binary |

> ⚠️ **Note:** `/etc/mita/` is Mieru's internal protobuf store — **never edit manually**.  
> The panel uses `/var/lib/rixxx-panel/mita-state.json` and applies it via `mita apply config <file>`.

---

## 🔧 Key Commands

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
mita apply config /var/lib/rixxx-panel/mita-state.json
mita reload

# Caddy
caddy-naive validate --config /etc/caddy-naive/Caddyfile --adapter caddyfile
caddy-naive reload  --config /etc/caddy-naive/Caddyfile --adapter caddyfile

# Panel management
bash update.sh --status    # Health check
bash update.sh --repair    # Fix broken install
sudo bash uninstall.sh     # Full removal
sudo bash uninstall.sh --keep-configs  # Remove without configs
```

---

## 📱 Client Applications

### NaiveProxy
Link format: `naive+https://username:password@domain:443`

| Client | Platform |
|--------|----------|
| [ShadowRocket](https://apps.apple.com/app/shadowrocket/id932747118) | iOS |
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [NekoBox](https://github.com/MatsuriDayo/NekoBoxForAndroid) | Android |
| [naiveproxy](https://github.com/klzgrad/naiveproxy/releases) | CLI |

### Mieru (sing-box)
Download the **Mieru JSON** or **Universal Config** from the Users page.

| Client | Platform |
|--------|----------|
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [Sing-box](https://apps.apple.com/app/sing-box/id6451272673) | iOS |
| [Sing-box](https://github.com/SagerNet/sing-box/releases) | Android / Windows / Linux / macOS |

### Universal Config (urltest auto-fallback)
Contains both NaiveProxy and Mieru outbounds with `urltest` selector — automatically uses the faster connection.

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────┐
│                         VPS                               │
│                                                          │
│  ┌──────────┐  port 443     ┌──────────────────────┐    │
│  │  Client  │ ──HTTPS──────▶│    caddy-naive       │    │
│  │ (Naive)  │               │  (NaiveProxy HTTPS   │    │
│  └──────────┘               │   forward proxy)     │    │
│                             └──────────────────────┘    │
│                                                          │
│  ┌──────────┐  ports        ┌──────────────────────┐    │
│  │  Client  │  2012-2022    │        mita          │    │
│  │ (Mieru)  │ ──TCP/UDP────▶│    (Mieru proxy)     │    │
│  └──────────┘               └──────────────────────┘    │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │          Control Panel (Node.js + PM2)              │  │
│  │   127.0.0.1:3000  │  REST API  │  WebSocket  │  UI  │  │
│  │              SQLite DB (/var/lib/rixxx-panel/)      │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ┌─────────────────────┐   ┌────────────────────────┐   │
│  │  /etc/caddy-naive/  │   │ /var/lib/rixxx-panel/  │   │
│  │     Caddyfile       │   │   mita-state.json      │   │
│  └─────────────────────┘   └────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

---

## 🔄 update.sh Reference

```bash
bash update.sh                   # Interactive update
bash update.sh --dry-run         # Preview changes (no writes)
bash update.sh --force -y        # Force update, non-interactive
bash update.sh --status          # Full health report
bash update.sh --repair          # Restore broken configs from backup
bash update.sh --expose <domain> # Switch to public panel mode
bash update.sh --ssh-only        # Revert to SSH-only mode
bash update.sh --help            # Show help
```

---

## 🗑 Uninstall

```bash
# Full removal (including configs and database)
sudo bash uninstall.sh

# Remove without configs (keep /etc/rixxx-panel/ and DB)
sudo bash uninstall.sh --keep-configs
```

---

## 🛡 Security Notes

- Panel runs on `127.0.0.1:3000` — not exposed to the internet by default
- Admin password is bcrypt-hashed in `config.json` (chmod 600)
- SQLite DB in `/var/lib/rixxx-panel/` (root access only)
- Temporary config files deleted with `shred -u`
- Login rate limiting: 20 req / 15 min
- Session cookies are `httpOnly`

---

## 🔧 Troubleshooting

### Top 5 Common Issues

**1. Time sync error (Mieru won't connect)**
```bash
timedatectl status
timedatectl set-ntp true
# Mieru requires accuracy ±30 seconds between client and server
```

**2. Port conflict**
```bash
ss -tlnup | grep -E '443|2012'
# Check if port is occupied by another process
```

**3. mita fails to start**
```bash
journalctl -u mita -n 50
mita status
# Check /var/lib/rixxx-panel/mita-state.json for valid JSON
mita apply config /var/lib/rixxx-panel/mita-state.json
```

**4. Caddy TLS certificate issues**
```bash
journalctl -u caddy-naive -n 50
caddy-naive validate --config /etc/caddy-naive/Caddyfile --adapter caddyfile
# Ensure domain points to server IP and port 443 is open
```

**5. Client connectivity checklist**
```bash
# 1. Can you ping the domain from the client device?
# 2. Is time synchronized on both devices?
# 3. Are ports open in UFW?
ufw status
# 4. Did you download new config after any port change?
# 5. Using correct client? (ShadowRocket / Karing / Sing-box)
```

---

## 📋 Tech Stack

- **Installer:** Bash (Ubuntu 20.04–24.04, Debian 11–12)
- **Panel:** Node.js 20 LTS + Express + better-sqlite3 + WebSocket
- **Process manager:** PM2
- **NaiveProxy:** caddy-naive (Caddy + forward_proxy plugin)
- **Mieru:** mita (managed via `mita apply config`)
- **Firewall:** UFW
- **Database:** SQLite (WAL mode)

---

## 📝 Credits

- **Author:** RIXXX
- **Telegram:** [@russian_paradice_vpn](https://t.me/russian_paradice_vpn)
- **Donate:** [app.lava.top/2107724612](https://app.lava.top/2107724612?tabId=donate)
- **NaiveProxy:** [klzgrad/naiveproxy](https://github.com/klzgrad/naiveproxy)
- **Mieru:** [enfein/mieru](https://github.com/enfein/mieru)
- **Caddy:** [caddyserver.com](https://caddyserver.com)
- **Karing:** [KaringX/karing](https://github.com/KaringX/karing)
