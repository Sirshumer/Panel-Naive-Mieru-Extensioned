[🇷🇺 Русский](README.md) | [🇬🇧 English](README.en.md)

---

<div align="center">

# 🛡 Panel Naive + Mieru by RIXXX

**v1.2.0** — Веб-панель управления NaiveProxy + Mieru для Ubuntu/Debian VPS

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
| 1 | Авто-установщик: определение архитектуры, NaiveProxy, Mieru .deb, systemd, NTP, UFW, config.json |
| 2 | CRUD пользователей: SQLite, перестройка htpasswd / Mieru-конфига, cron удаления просроченных |
| 3 | Настройки сервера: смена портов, паттерны трафика, MTU, авто-обновление UFW |
| 4 | Клиентские конфиги: Naive-ссылка, Mieru sing-box JSON, универсальный конфиг, QR-коды |
| 5 | Мониторинг: WebSocket метрики в реальном времени, трафик, квоты, история снимков |
| 6 | `update.sh`: `--dry-run`, `--force`, `--expose`, `--ssh-only`, `--status`, `--repair`, `--help` |

---

## 🖥 Поддерживаемые ОС

| Дистрибутив | Версии |
|-------------|--------|
| Ubuntu | 20.04, 22.04, 24.04 |
| Debian | 11, 12 |

**Архитектуры:** `x86_64` (amd64) · `aarch64` (arm64) *(экспериментально, не тестировалось в продакшне)* · `armv7l` (armhf) *(экспериментально, не тестировалось в продакшне)*

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
- Email для TLS-сертификата
- Порт NaiveProxy (по умолчанию: `443`)
- Диапазон портов Mieru (по умолчанию: `2012-2022`)
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
| `/etc/naive/config.json` | Конфиг NaiveProxy (listen, name, auth, cert/key) |
| `/etc/naive/htpasswd` | Пользователи NaiveProxy (bcrypt, управляется панелью) |
| `/var/log/naive/access.log` | Лог доступа NaiveProxy |
| `/var/log/rixxx-panel-install.log` | Лог установки |
| `/var/lib/rixxx-panel/mita-state.json` | JSON-файл Mieru (применяется через `mita apply config`) |
| `/var/lib/rixxx-panel/db.sqlite` | SQLite база данных пользователей |
| `/opt/panel-naive-mieru/` | Файлы приложения панели |
| `/usr/local/bin/naive` | Бинарный файл NaiveProxy |

> ⚠️ **Важно:** `/etc/mita/` — внутреннее хранилище Mieru в формате protobuf, **не редактируется вручную**.  
> Панель использует `/var/lib/rixxx-panel/mita-state.json` и применяет его командой `mita apply config <file>`.

---

## 🔧 Ключевые команды

```bash
# Управление сервисами
systemctl status naive mita
systemctl restart naive
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
sudo bash uninstall.sh --keep-configs  # Удаление без конфигов
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

# Удаление без конфигов (сохранить /etc/rixxx-panel/ и DB)
sudo bash uninstall.sh --keep-configs
```

---

## 🛡 Безопасность

- Панель работает на `127.0.0.1:3000` — не доступна из интернета по умолчанию
- Пароль администратора хранится в bcrypt-хэше в `config.json` (chmod 600)
- SQLite БД в `/var/lib/rixxx-panel/` (только root)
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
