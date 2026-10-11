# belfara-farm-th

TokenHarbor API-key provisioning — diperbaiki agar **benar-benar bekerja**.

Fork/perbaikan dari `0xgetz/tokenharbor-bulk-creator` yang memperbaiki semua alasan
kenapa repo asli gagal membuat akun & API key (diuji end-to-end 11 Okt 2026: signup →
verifikasi → free models → key → tes chat, semuanya sukses).

> Alat ini untuk otomatisasi yang sah, pengujian internal, dan riset pada akun yang
> Anda miliki. Anda bertanggung jawab mematuhi Ketentuan Layanan TokenHarbor dan
> hukum yang berlaku.

## Apa yang diperbaiki vs repo asli

| # | Masalah di repo asli | Perbaikan di repo ini |
|---|---|---|
| 1 | Inbox default `temp-email.dev` — **domainnya DIBLOKIR** TokenHarbor (`email already registered`), signup tak pernah lolos | Pakai **inbox sendiri**: Cloudflare Worker **Tempik** + **domain sendiri** (milikmu) via Cloudflare Email Routing → worker |
| 2 | Install Chromium Playwright — kena **Cloudflare JS challenge** (`cdn-cgi/challenge-platform`), signup "Something went wrong" | **Chrome asli** (`chromium.launch({ channel: 'chrome' })`) yang terbukti lolos challenge |
| 3 | Asumsi ada Turnstile → buang waktu ke CAPSolver | TokenHarbor **tidak punya Turnstile** — alur CAPSolver dihapus |
| 4 | Email verifikasi dianggap otomatis | Email **tidak** dikirim otomatis — di dashboard ada tombol **"Verify email"** yang harus diklik dulu |
| 5 | (tidak ada) | **Free models tidak aktif otomatis** — wajib `POST /api/me/privacy` dengan `{consent_version:2, free_models_enabled:true}` setelah login, kalau tidak semua request kena `balance_zero` |
| 6 | Login asal klik tombol "Sign in" | Halaman login punya **2 tombol "Sign in"** (header + form) — wajib `.last()` |
| 7 | Buat key tidak stabil | Navigasi eksplisit ke `/dashboard/api-keys` → modal **New key** → isi label → **Create key** → baca `thk_live_...` dari halaman → tutup modal |
| 8 | Tidak ada retry proxy | Proxy residential (~50% gagal acak) → **retry ganti proxy** (max 6 percobaan per akun, email baru tiap percobaan) |

## Persyaratan

- Node.js 18+
- **Google Chrome asli terpasang** (`google-chrome` di PATH) — Chromium headless TIDAK cukup
- Akses ke instance Tempik worker + domain sendiri dengan Email Routing ke worker itu

## Instalasi

```bash
git clone https://github.com/belfaranet-debug/belfara-farm-th.git
cd belfara-farm-th
npm install
# pastikan google-chrome ada:
which google-chrome
```

## Pemakaian

```bash
# Cek lingkungan
node src/index.mjs --doctor

# Buat 1 key + tes
node src/index.mjs -n 1 \
  --mail-base-url https://YOUR-TEMPIK-WORKER.workers.dev \
  --mailbox-domain your-domain.com \
  --proxy-file proxies.txt \
  --test

# Buat 5 key, tanpa proxy
node src/index.mjs -n 5

# Browser terlihat (debug)
node src/index.mjs -n 1 --headful
```

### CLI

| Flag | Default | Deskripsi |
|---|---|---|
| `-n, --count` | 1 | Jumlah key/akun |
| `-o, --out` | output/th-keys-<ts>.json | Path hasil JSON |
| `-p, --password` | random 16 char | Password akun |
| `--prefix` | th | Prefix label key & local-part email |
| `--mail-base-url` | https://YOUR-TEMPIK-WORKER.workers.dev | Base URL worker Tempik |
| `--mailbox-domain` | your-domain.com | Domain inbox (wajib punya Email Routing → worker) |
| `--proxy-file` | – | File proxy, satu `http://user:pass@host:port` per baris |
| `--headful` | false | Browser terlihat (debug) |
| `--timeout` | 240000 | Tunggu email verifikasi (ms) |
| `--test` | false | Tes tiap key setelah dibuat (chat `deepseek-v4-flash:free`) |
| `--doctor` | – | Cek lingkungan |

## Alur kerja (sesuai yang terbukti sukses)

```
1. TempikInbox.createSession()          -> session id (sekali, dipakai semua akun)
2. TempikInbox.createInbox(localPart)   -> buat alamat @domainmu
3. TokenHarborClient.signup()           -> Chrome asli + proxy, buat akun, klik "Verify email"
4. TempikInbox.waitForVerifyLink()      -> poll pesan, ekstrak link tokenharbor.ai/verify-email?token=...
5. client.verify(page, link)            -> buka link, konfirmasi VERIFIED
6. client.enableFreeModels(page)        -> POST /api/me/privacy (free_models_enabled:true)
7. client.createApiKey(page, label)     -> 1 key thk_live_... per akun (loop untuk multi-key)
8. testApiKey(key)                      -> opsional, tes chat model :free
```

Hasil ditulis ke JSON (mode aman) dengan mask `chmod 600` — layanan ini menulis
kredensial, jadi file output & direktori `output/` masuk `.gitignore`.

## Penting: model `:free`

Akun TokenHarbor saldo $0 hanya bisa memakai model dengan suffix `:free`
(`deepseek-v4-flash:free`, `mimo-v2.5:free`). Tanpa suffix, API menolak dengan
`balance_zero` — itu normal, bukan bug.

## Struktur

```
src/
├── index.mjs              # CLI entry (flags, retry proxy, output JSON)
├── inbox/tempik.mjs       # provider inbox Tempik (worker Cloudflare + D1)
└── tokenharbor/client.mjs # signup, verify, free-models, create key + test key
```

## Lisensi

MIT — sama seperti repo asli.