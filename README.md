# Kantor AI NOC — 3D Datacenter Multi-MikroTik Monitoring & AI Assistant

Sistem **AI Network Operations Center (AI NOC)** bertema **Datacenter 3D Interaktif** (**React + Three.js + Express + WebSocket**) untuk memantau multi-router **MikroTik (RouterOS v6 & v7)** secara real-time, lengkap dengan:

- **Datacenter 3D Interaktif & Mobile Responsive:**
  - Lantai raised-floor, deretan rak server 42U dengan LED berkedip, kabel fiber overhead, partikel telemetri, serta agen IT hidup yang duduk menghadap dual monitor & secara organik mengambil minum, istirahat di sofa, berdiskusi antar rekan, dan mengecek rak server.
  - Kontrol kamera 360° penuh (`OrbitControls`: drag putar, pan, scroll/pinch zoom in & out, fokus agen, auto-tour toggle) + tampilan responsif penuh untuk HP.
- **Pemantauan Multi-MikroTik RouterOS v6 & v7 Native API:**
  - Mendukung protokol binary RouterOS API port `8728` / `8729` (termasuk login v6.43+/v7 dan fallback MD5 challenge lawas).
  - Membaca CPU, RAM, suhu & tegangan (`/system/health/print` v6 & v7), uptime, sesi PPPoE aktif, BGP peer, trafik interface fisik/VLAN real-time (Mbps delta), dan **menarik log MikroTik otomatis via `/log/print`** + penerima **Syslog UDP (`5514`)**.
- **Prioritas #1 — Deteksi `RADIUS Timeout`:**
  - Mendeteksi otomatis pola `<...>: user "NAMA USER" authentication failed - radius timeout`, menyalakan banner alert merah berkedip, dan mengunci agen terkait untuk diagnosis.
- **Konsol AI NOC & Antigravity AI Bridge:**
  - Setiap agen dilengkapi konsol AI interaktif berbasis data live MikroTik (terhubung ke Antigravity AI Bridge & opsional Gemini / OpenAI Cloud LLM).
- **Keamanan Produksi:**
  - **Admin Login Gate** (cookie `HttpOnly`, `SameSite=Lax`, HMAC-SHA256, `scrypt` password hashing, rate limiter, proteksi penuh REST API & WebSocket `/ws`).
  - **Enkripsi AES-256-GCM** untuk password MikroTik per-router yang diatur dari GUI (`SecretVault`).
  - **Human-in-the-Loop Approval Gate** & **Anti-Lockout Guardrail** (2-step `.id` resolution & proteksi subnet manajemen).

## Struktur Proyek
```text
ai-noc-mikrotik/
├── backend/              # Express + WebSocket + RouterOS v6/v7 Client + Syslog UDP + Auth + AI Bridge
├── frontend/             # React 19 + Three.js 3D Datacenter + Mobile Responsive HUD
├── .env.example          # Template konfigurasi environment
├── docker-compose.yml    # Konfigurasi Docker Compose (opsional)
└── deploy-ubuntu.ps1     # Skrip deploy SSH ke Ubuntu Server
```

## Menjalankan Secara Lokal / Ubuntu Server
```bash
cp .env.example .env
# Edit .env: isi NOC_ADMIN_USER, NOC_ADMIN_PASS, MT_READ_SECRET, dan opsional GEMINI_API_KEY / TELEGRAM_BOT_TOKEN

# Build & jalankan frontend + backend
cd frontend && npm ci && npm run build
cd ../backend && npm ci && npm run build
npm start
```
Buka browser ke `http://localhost:8090` (atau sesuai `PORT` di `.env`).

## Pengujian
```bash
cd backend && npm test
cd ../frontend && npm test
```

## Konfigurasi MikroTik (Read-Only + Syslog Opsional)
### RouterOS v7
```routeros
/ip service enable api
/user group add name=aireadonly policy=read,test,api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon,!rest-api
/user add name=noc_readonly group=aireadonly address=<IP_SERVER_NOC>/32 password="<PASSWORD_MIKROTIK>"
/system logging action add name=ainoc target=remote remote=<IP_SERVER_NOC> remote-port=5514
/system logging add topics=warning action=ainoc
/system logging add topics=error action=ainoc
/system logging add topics=critical action=ainoc
/system logging add topics=radius action=ainoc
```

### RouterOS v6
```routeros
/ip service enable api
/user group add name=aireadonly policy=read,test,api,!local,!telnet,!ssh,!ftp,!reboot,!write,!policy,!winbox,!password,!web,!sniff,!sensitive,!romon
/user add name=noc_readonly group=aireadonly address=<IP_SERVER_NOC>/32 password="<PASSWORD_MIKROTIK>"
/system logging action add name=ainoc target=remote remote=<IP_SERVER_NOC> remote-port=5514
/system logging add topics=warning action=ainoc
/system logging add topics=error action=ainoc
/system logging add topics=critical action=ainoc
/system logging add topics=radius action=ainoc
```
