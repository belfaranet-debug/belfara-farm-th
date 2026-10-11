# 9router Ops — Fleet Config & Perbaikan (Terverifikasi)

**Tanggal verifikasi:** 2026-10-11
**Host:** r5-2600, dell, nuc5cpyh, nuc6cayh
**Kasus utama:** 598 koneksi TokenHarbor di Dell error `429 Network rate limit reached` — semua key dianggap mati padahal sehat.

---

## 1. Peta Versi & Cara Jalan (ground truth = `/api/version`)

| Host | Versi aktif | Cara jalan | Binary |
|---|---|---|---|
| r5-2600 | **0.5.35** | systemd user `9router.service` | `~/.nvm/versions/node/v22.22.3/lib/node_modules/9router/app/server.js` |
| dell | **0.5.81** | npm CLI global (`--tray`) | `~/.hermes/node/lib/node_modules/9router` |
| nuc5cpyh | **0.5.55** | npm global | `~/.hermes/node/lib/node_modules/9router` |
| nuc6cayh | **0.5.55** | npm global | `~/.hermes/node/lib/node_modules/9router` |

Semua host: `latestVersion: 0.5.99`.

### ⚠️ Cara cek versi yang BENAR

```bash
# JANGAN pakai package.json — bisa beda dari build yang jalan
curl -s http://127.0.0.1:20128/api/version

# Cek siapa yang benar-benar memegang port
ss -tlnp | grep 20128
readlink /proc/<pid>/cwd
```

**Contoh diskrepansi nyata (r5-2600):** `package.json` = `0.5.50`, tapi `/api/version` = `0.5.35`
karena `.next-cli-build` (mtime 3 Sep) belum di-rebuild. **Versi yang jalan = yang di build, bukan package.json.**

### ⚠️ Port yang menipu

- **Dell `:20130`** = **SSH tunnel** ke `192.168.18.9` — BUKAN 9router Dell.
  ```bash
  ps aux | grep "ssh.*20130"   # -> -L 127.0.0.1:20130:127.0.0.1:20128 belfara@192.168.18.9
  ```
- **Container `9router` di r5-2600** (v0.5.35, network `9router_default`) = **tanpa IP & tanpa port mapping** → tidak melayani apa pun. Yang melayani adalah proses systemd.
- **Container `9router-mibp` di Dell** = `Exited (137)`. Source `~/9router-mibp` **tidak dipakai**.

---

## 2. Skema DB (per host: `~/.9router/db/data.sqlite`)

Tabel: `providerNodes`, `providerConnections`, `proxyPools`, `proxyPoolFitness`, `combos`, `apiKeys`, `settings`, `usageHistory`, `usageDaily`, `requestDetails`, `cachedProviderModels`.

### Field penting di `providerConnections.data` (JSON blob)

| Field | Arti |
|---|---|
| `apiKey` | kredensial upstream |
| `testStatus` | `active` / `unavailable` — **stale cache**, jangan dipercaya |
| `backoffLevel` | naik tiap gagal (bisa sampai 15) |
| `errorCode`, `lastError`, `lastErrorAt`, `rateLimitedUntil` | state error |
| `modelLock_<model>` | kunci per-model — **membuat row di-skip** walau proxy sudah diperbaiki |
| `providerSpecificData.connectionProxyEnabled` | **proxy legacy per-koneksi (dipakai v0.5.81)** |
| `providerSpecificData.connectionProxyUrl` | URL proxy untuk koneksi ini |
| `providerSpecificData.strictProxy` | fail kalau proxy mati (jangan fallback direct) |
| `providerSpecificData.proxyPoolIds` | **multi-pool baru — TIDAK ADA di v0.5.81** |

### ⚠️ `isActive` bukan bagian dari JSON

`isActive` adalah **kolom terpisah** di tabel. Kalau script menulis ulang `data` tanpa
`SET isActive=1`, semua row jadi nonaktif dan lane balas:
```
404 {"error":{"message":"No active credentials for provider: <node-id>"}}
```
**Itu kerusakan buatan sendiri, bukan upstream.**

### Password login dashboard

Ambil dari tabel `apiKeys`, kolom **`name`** (bukan `key` yang jadi Bearer `/v1`):

```python
row = con.execute("SELECT name FROM apiKeys LIMIT 1").fetchone()
```

---

## 3. Kasus: 429 "Network rate limit reached" di seluruh node

### Gejala

- Semua koneksi node `testStatus: unavailable`
- `lastError`: `[429] {"error":{"message":"Network rate limit reached. Try again in a moment.","type":"rate_limit_exceeded"}}`
- `backoffLevel` naik (5 → 15), `modelLock_*` menumpuk di tiap row
- Probe ke lane **timeout** (router mengiterasi semua N koneksi mati)

### Diagnosis berurutan (setiap langkah MENGGUGURKAN satu hipotesis)

```bash
# 1. Buktikan key sehat — bypass 9router, langsung ke upstream
curl -X POST https://tokenharbor.ai/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash:free","messages":[{"role":"user","content":"OK"}],"max_tokens":5}'
# 12/12 HTTP 200 -> key SEHAT, state DB stale
```

```bash
# 2. Cek build 9router yang BENAR-BENAR jalan (langkah paling penting!)
readlink /proc/<pid>/cwd
grep -rl "proxyPoolIds" ~/.hermes/node/lib/node_modules/9router/app/.next-cli-build/server
# -> KOSONG di v0.5.81: fitur pool TIDAK ADA -> semua edit pool DIABAIKAN
```

```bash
# 3. Matriks terkontrol: direct vs via proxy
#    direct x3, proxy#1 x3, proxy#50, proxy#99 — semua 200
#    -> bukan key, bukan proxy; limit dipicu cara 9router mem-fan-out
```

### Perbaikan (mekanisme yang DIDUKUNG versi berjalan)

v0.5.81 **tidak** punya `proxyPoolIds`. Yang dibaca = field legacy per-koneksi.
Pasang **1 proxy berbeda per koneksi** (round-robin 100 proxy → 598 koneksi):

```python
psd = d.get("providerSpecificData") or {}
psd["connectionProxyEnabled"] = True
psd["connectionProxyUrl"]     = proxies[i % len(proxies)]   # rotasi per koneksi
psd["connectionNoProxy"]      = ""
psd["strictProxy"]            = True
d["providerSpecificData"]     = psd

# WAJIB: bersihkan state agar row tidak di-skip
d["testStatus"]       = "active"
d["backoffLevel"]     = 0
d["errorCode"]        = None
d["lastError"]        = None
d["lastErrorAt"]      = None
d["rateLimitedUntil"] = None
for k in list(d.keys()):
    if k.startswith("modelLock_"):
        d.pop(k, None)

con.execute("UPDATE providerConnections SET isActive=1, data=? WHERE id=?", (json.dumps(d), cid))
```

Skrip siap pakai: `scripts/9router_fix_per_ip_429.py`

### Hasil verifikasi

**Dell (v0.5.81):**

| Uji | Hasil |
|---|---|
| Probe 3 model × 4 putaran | **12/12 HTTP 200** |
| `testStatus` | **598/598 active** |
| Koneksi dengan proxy | **598/598** |
| Latensi | 3–27s (`mimo` lebih lambat) |

**r5-2600 (v0.5.35):**

| Uji | Hasil |
|---|---|
| Baseline sebelum fix | 639 unavailable, probe **HTTP 000 timeout** |
| Setelah `--apply` | 5/5 probe OK |
| Stabilitas 15 probe (3 model) | **15/15 OK**, 0 empty, 0 fail |
| `testStatus` setelah `--recheck` | **639/639 active**, `modelLock` 0 |
| Latensi | 2.2–19.7s |

---

## 3b. `testStatus` bisa BASI meski key sudah hidup

Setelah `--apply`, 3 koneksi di r5-2600 **masih** `unavailable` + `modelLock`. Aku tes manual:

```
direct : HTTP 429 Network rate limit reached
proxy  : HTTP 200 ✅   (egress 103.101.193.118)
```

**Key hidup, proxy bekerja — statusnya cuma cache yang belum ikut refresh.**
Perbaikan: `--recheck` (reset `testStatus=active` + buang `backoff`/`modelLock`,
**tanpa** mengubah proxy).

```bash
python3 9router_fix_per_ip_429.py --recheck --probe th/deepseek-v4-flash:free
```

Aturan: kalau `curl -x <proxy>` balas 200 tapi row masih `unavailable`,
**jangan** ubah proxy lagi — cukup `--recheck`.

---

## 4. Pitfalls

0. **Parser respons: 9router balas `content-type: text/event-stream` walau `stream:false`,
   dan body punya trailing bytes.** `json.load()` gagal (`Extra data`) — pakai
   `json.JSONDecoder().raw_decode(raw)[0]`. Ini bug parser, bukan kegagalan provider.
   (Sempat membuat 15/15 probe terlihat "FAIL" padahal semuanya HTTP 200.)

1. **Versi yang jalan ≠ `package.json`.** Selalu `curl /api/version` + `readlink /proc/<pid>/cwd`.
2. **Edit source tree ≠ edit build yang jalan.** Cek `grep` di `.next-cli-build/server` dulu.
3. **`isActive` = kolom, bukan JSON.** Lupa `SET isActive=1` → `404 No active credentials`.
4. **Pool `/test` mengembalikan `{"ok":true,"status":200}` hanya membuktikan URL proxy hidup** —
   bukan membuktikan router memakainya. Verifikasi di level **lane**, bukan DB.
5. **`testStatus` = cache basi.** Verdict sebenarnya dari probe langsung ke upstream.
6. **`th/mimo-v2.5:free` lambat (12–27s)** dan bisa balas HTTP 200 dengan `content` kosong
   (reasoning menghabiskan token). Naikkan `max_tokens` sebelum menyatakan model rusak.
7. **Backup `data.sqlite` sebelum tiap mutasi** — skrip ini menulis ulang semua row sekaligus.
8. **Hati-hati bandwidth:** 598 koneksi × trafik lewat proxy residential bisa cepat menghabiskan kuota.

---

## 5. Perintah Cepat

```bash
# Versi semua host
for h in dell nuc5cpyh; do echo -n "$h: "; ssh $h 'curl -s -m5 http://127.0.0.1:20128/api/version'; echo; done

# Hitung koneksi per node
sqlite3 ~/.9router/db/data.sqlite \
  "SELECT pn.name, COUNT(*) FROM providerConnections pc
   JOIN providerNodes pn ON pc.provider=pn.id GROUP BY 1;"

# Distribusi testStatus
sqlite3 ~/.9router/db/data.sqlite "SELECT data FROM providerConnections" \
  | python3 -c "import sys,json,collections;c=collections.Counter(json.loads(l).get('testStatus','?') for l in sys.stdin if l.strip());print(dict(c))"
```

---

## 6. Login dashboard (per host)

```python
import json, urllib.request, sqlite3, os
db = os.path.expanduser("~/.9router/db/data.sqlite")
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
pw = con.execute("SELECT name FROM apiKeys LIMIT 1").fetchone()[0]   # name = password
req = urllib.request.Request("http://127.0.0.1:20128/api/auth/login",
    data=json.dumps({"password": pw}).encode(),
    headers={"Content-Type": "application/json"}, method="POST")
cookie = urllib.request.urlopen(req, timeout=10).headers.get("Set-Cookie")
```

---

## Catatan Keamanan

- **Kredensial tidak disimpan di repo ini.** Password, API key, dan proxy diambil runtime dari
  `~/.9router/db/data.sqlite` / file lokal.
- `.gitignore` memblokir: `output/`, `proxies*.txt`, `*.env`, `*.log`.
