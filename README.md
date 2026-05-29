[🇷🇺 Русский](README.md) | [🇬🇧 English](README.en.md)

---

<div align="center">

# 🛡 Panel Naive + Mieru by RIXXX

**v1.2.6** — Веб-панель управления NaiveProxy + Mieru для Ubuntu/Debian VPS

[![Telegram](https://img.shields.io/badge/Telegram-@russian__paradice__vpn-2CA5E0?logo=telegram&logoColor=white)](https://t.me/russian_paradice_vpn)
[![GitHub](https://img.shields.io/badge/GitHub-cwash797--cmd-181717?logo=github)](https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX)
[![License](https://img.shields.io/badge/License-MIT-bronze?color=c08552)](LICENSE)

> 💬 **Поддержка и обновления:** [t.me/russian_paradice_vpn](https://t.me/russian_paradice_vpn)  
> ☕ **Поддержать проект:** [app.lava.top/2107724612](https://app.lava.top/2107724612?tabId=donate)

</div>

---

## ✨ Возможности

| Sprint | Функционал |
|--------|-----------|
| 1 | Авто-установщик: определение архитектуры (только amd64), caddy-forwardproxy-naive, Mieru .deb, systemd, NTP, UFW, config.json |
| 2 | CRUD пользователей: SQLite, атомарная перестройка Caddyfile / Mieru-конфига, cron удаления просроченных |
| 3 | Настройки сервера: смена портов, паттерны трафика, MTU, авто-обновление UFW |
| 4 | Клиентские конфиги: Naive-ссылка, Mieru sing-box JSON, универсальный конфиг, QR-коды |
| 5 | Мониторинг: WebSocket метрики в реальном времени, трафик, квоты, история снимков |
| 6 | `update.sh`: `--dry-run`, `--force`, `--expose`, `--ssh-only`, `--status`, `--repair`, `--help` |
| 7 | **Каскад / Relay** (v1.2.6): `client → Entry (RU) → Exit (EU) → internet` — upstream (Naive) + egress SOCKS5 (Mieru) |

---

## 🖥 Поддерживаемые ОС

| Дистрибутив | Версии |
|-------------|--------|
| Ubuntu | 20.04, 22.04, 24.04 |
| Debian | 11, 12 |

**Архитектуры:** `x86_64` (amd64) — **только** *(caddy-forwardproxy-naive поддерживает только amd64)*  
> ⚠️ ARM64 и ARMv7 **не поддерживаются** в v1.2.3 — установщик завершится с понятной ошибкой.

---

## 🚀 Быстрый старт

```bash
# 1. Клонировать репозиторий
git clone https://github.com/cwash797-cmd/Panel-Naive-Mieru-by-RIXXX.git
cd Panel-Naive-Mieru-by-RIXXX

# 2. Запустить установщик от root
sudo bash install.sh
```

Мастер установки запросит:
- Язык (Русский / English) — **первый вопрос**
- Домен / имя хоста
- Email для TLS (Caddy управляет сертификатами автоматически через TLS-ALPN-01)
- Порт NaiveProxy (по умолчанию: `443`)
- Диапазон портов Mieru (по умолчанию: `2012-2022`)
- URL фейкового сайта (по умолчанию: `https://www.example.com`)
- Probe secret (по умолчанию: авто-генерация)
- Данные администратора панели
- Настройка UFW (опционально)
- Режим доступа к панели (SSH-only / публичный)

---

## 🔒 Доступ к панели

### SSH-only (по умолчанию, наиболее безопасно)
```bash
# С вашей локальной машины:
ssh -L 3000:127.0.0.1:3000 root@<ip-сервера>
# Затем откройте: http://localhost:3000/
```

### Публичный режим
```bash
sudo bash update.sh --expose vpn.example.com
# Панель доступна по: http://vpn.example.com:8080/
```

---

## 📁 Важные пути

| Путь | Назначение |
|------|-----------|
| `/etc/rixxx-panel/config.json` | Конфигурация панели |
| `/etc/rixxx-panel/version` | Установленная версия |
| `/etc/rixxx-panel/backups/` | Резервные копии (хранится последние 10) |
| `/etc/caddy-naive/Caddyfile` | Конфиг Caddy forwardproxy-naive (basicauth, probe_resistance) |
| `/etc/caddy-naive/probe_secret` | Секрет защиты от зондирования |
| `/var/www/fake-site/` | Фейковый сайт (показывается неопознанным клиентам) |
| `/var/log/caddy-naive/access.log` | Лог доступа caddy-naive |
| `/var/log/rixxx-panel-install.log` | Лог установки |
| `/var/lib/rixxx-panel/mita-state.json` | JSON-файл Mieru (применяется через `mita apply config`) |
| `/var/lib/rixxx-panel/db.sqlite` | SQLite база данных пользователей |
| `/opt/panel-naive-mieru/` | Файлы приложения панели |
| `/usr/local/bin/caddy-naive` | Бинарный файл caddy-forwardproxy-naive |

> ⚠️ **Важно:** `/etc/mita/` — внутреннее хранилище Mieru в формате protobuf, **не редактируется вручную**.  
> Панель использует `/var/lib/rixxx-panel/mita-state.json` и применяет его командой `mita apply config <file>`.

> 🔐 **Предупреждение безопасности (Bug 45):** Панель хранит **открытые (plaintext) пароли** пользователей  
> в SQLite (`/var/lib/rixxx-panel/db.sqlite`). Это необходимо, потому что `caddy-forwardproxy-naive`  
> хэширует пароли самостоятельно при запуске и требует оригинальный текст. **Ограничьте доступ  
> к файлу БД:** он уже защищён правами `600 root:root`, но вы должны убедиться, что VPS не  
> скомпрометирован. Не используйте пароли VPN повторно на других сервисах.

---

## 🔧 Ключевые команды

```bash
# Управление сервисами
systemctl status caddy-naive mita
systemctl restart caddy-naive
systemctl restart mita

# Панель (PM2)
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

# Управление панелью
bash update.sh --status    # Проверка состояния
bash update.sh --repair    # Исправление сломанной установки
sudo bash uninstall.sh     # Полное удаление
```

---

## 📱 Клиентские приложения

### NaiveProxy
Формат ссылки: `naive+https://username:password@domain:443`

| Клиент | Платформа |
|--------|-----------|
| [ShadowRocket](https://apps.apple.com/app/shadowrocket/id932747118) | iOS |
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [NekoBox](https://github.com/MatsuriDayo/NekoBoxForAndroid) | Android |
| [naiveproxy](https://github.com/klzgrad/naiveproxy/releases) | CLI |

### Mieru (sing-box)
Скачайте **Mieru JSON** или **Универсальный конфиг** со страницы пользователей.

| Клиент | Платформа |
|--------|-----------|
| [Karing](https://github.com/KaringX/karing/releases) | iOS / Android / Windows / macOS / Linux |
| [Sing-box](https://apps.apple.com/app/sing-box/id6451272673) | iOS |
| [Sing-box](https://github.com/SagerNet/sing-box/releases) | Android / Windows / Linux / macOS |

### Универсальный конфиг (urltest авто-выбор)
Содержит оба протокола (NaiveProxy + Mieru) с `urltest` — автоматически выбирает более быстрое соединение.

---

## 🏗 Архитектура

```
┌──────────────────────────────────────────────────────────┐
│                         VPS                               │
│                                                          │
│  ┌──────────┐  порт 443     ┌──────────────────────┐    │
│  │  Клиент  │ ──HTTPS──────▶│    caddy-naive       │    │
│  │ (Naive)  │               │  (NaiveProxy HTTPS   │    │
│  └──────────┘               │   forward proxy)     │    │
│                             └──────────────────────┘    │
│                                                          │
│  ┌──────────┐  порты        ┌──────────────────────┐    │
│  │  Клиент  │  2012-2022    │        mita          │    │
│  │ (Mieru)  │ ──TCP/UDP────▶│    (Mieru proxy)     │    │
│  └──────────┘               └──────────────────────┘    │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │           Панель управления (Node.js + PM2)         │  │
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

## 🌐 Каскад / Relay (v1.2.6)

Настройте двухузловую цепочку прямо из панели (**Settings → Каскад**):

```
┌──────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────┐
│  Клиент  │──▶│ Entry (RU)   │──▶│ Exit (EU)    │──▶│ Интернет │
│          │   │ caddy-naive  │   │ SOCKS5/443   │   │          │
│  Naive   │   │ upstream     │   │              │   │          │
│  + Mieru │   │ mita + egress│   │              │   │          │
└──────────┘   └──────────────┘   └──────────────┘   └──────────┘
```

### Что происходит под капотом

- **NaiveProxy** — в `Caddyfile` добавляется директива `upstream https://user:pass@exit-host:443` внутри блока `forward_proxy`. Трафик клиента заворачивается на Exit-ноду перед выходом в интернет.
- **Mieru** — в `mita-state.json` добавляется объект `egress` с SOCKS5-прокси (`SOCKS5_PROXY_PROTOCOL`) на Exit-ноду. Правило `action: DIRECT` означает, что весь трафик идёт через этот выход.

### UI-управление

1. Откройте **Settings → Каскад**.
2. Включите галочку **«Включить каскад»**.
3. Заполните:
   - **Naive upstream URL** — `https://user:password@exit.example.com:443`
   - **Mieru Exit host** — IP или домен Exit-ноды
   - **Mieru Exit port** — порт SOCKS5 (обычно `1080`)
   - **User / Password** — если Exit требует аутентификацию SOCKS5
4. Нажмите **Применить каскад**. Панель атомарно перепишет `Caddyfile` и `mita-state.json`, перезагрузит сервисы и выдаст toast-уведомление.

> 💡 Каскад можно включать/выключать без удаления настроек — просто снимите галочку и нажмите «Применить».

---

## 🔄 Справочник update.sh

```bash
bash update.sh                    # Интерактивное обновление
bash update.sh --dry-run          # Предпросмотр изменений (без записи)
bash update.sh --force -y         # Принудительное обновление, без вопросов
bash update.sh --status           # Полный отчёт о состоянии
bash update.sh --repair           # Восстановление сломанных конфигов
bash update.sh --expose <домен>   # Публичный режим панели
bash update.sh --ssh-only         # Вернуться в SSH-only режим
bash update.sh --help             # Справка
```

---

## 🗑 Удаление

```bash
# Полное удаление (включая конфиги и базу данных)
sudo bash uninstall.sh
```

---

## 🛡 Безопасность

- Панель работает на `127.0.0.1:3000` — не доступна из интернета по умолчанию
- Пароль администратора хранится в bcrypt-хэше в `config.json` (chmod 600)
- SQLite БД в `/var/lib/rixxx-panel/` (только root)
- **Probe resistance**: неопознанные клиенты видят фейковый сайт вместо ошибки прокси
- **Без certbot**: Caddy управляет TLS автоматически через TLS-ALPN-01 (порт 80 не нужен)
- Временные конфиг-файлы удаляются через `shred -u`
- Rate limiting на login (20 запросов / 15 мин)
- Куки сессии `httpOnly`

---

## 🔧 Решение проблем

### Топ-5 распространённых проблем

**1. Ошибка синхронизации времени (Mieru не подключается)**
```bash
timedatectl status
timedatectl set-ntp true
# Mieru требует точность ±30 секунд между клиентом и сервером
```

**2. Конфликт портов**
```bash
ss -tlnup | grep -E '443|2012'
# Проверьте, не занят ли порт другим процессом
```

**3. mita не запускается**
```bash
journalctl -u mita -n 50
mita status
# Проверьте /var/lib/rixxx-panel/mita-state.json на валидность JSON
mita apply config /var/lib/rixxx-panel/mita-state.json
```

**4. Проблемы с TLS-сертификатом Caddy**
```bash
journalctl -u caddy-naive -n 50
caddy-naive validate --config /etc/caddy-naive/Caddyfile --adapter caddyfile
# Убедитесь, что домен указывает на IP сервера и порт 443 открыт
```

**5. Клиент не подключается**
```bash
# Чеклист:
# 1. Пинг домена с клиентского устройства
# 2. Время синхронизировано на обоих устройствах?
# 3. Порты открыты в UFW?
ufw status
# 4. Скачайте новый конфиг после любого изменения портов
# 5. Используйте правильный клиент (ShadowRocket / Karing / Sing-box)
```

---

## 📸 Скриншоты

> Скриншоты UI доступны в папке `docs/screenshots/` репозитория.

---

## 📋 Стек технологий

- **Установщик:** Bash (Ubuntu 20.04–24.04, Debian 11–12)
- **Панель:** Node.js 20 LTS + Express + better-sqlite3 + WebSocket
- **Процесс-менеджер:** PM2
- **NaiveProxy:** caddy-naive (Caddy + forward_proxy plugin)
- **Mieru:** mita (управляется через `mita apply config`)
- **Файрвол:** UFW
- **База данных:** SQLite (WAL mode)

---

## 📝 Кредиты

- **Автор:** RIXXX
- **Telegram:** [@russian_paradice_vpn](https://t.me/russian_paradice_vpn)
- **Донат:** [app.lava.top/2107724612](https://app.lava.top/2107724612?tabId=donate)
- **NaiveProxy:** [klzgrad/naiveproxy](https://github.com/klzgrad/naiveproxy)
- **Mieru:** [enfein/mieru](https://github.com/enfein/mieru)
- **Caddy:** [caddyserver.com](https://caddyserver.com)
- **Karing:** [KaringX/karing](https://github.com/KaringX/karing)
