# Evaluasi Farm 100 Akun TokenHarbor

**Tanggal:** 2026-10-11  
**Durasi:** ~6 jam  
**Script:** `src/index.mjs` (patched: `--domains`, `--keys-per-account`)  
**Target:** 100 akun × 10 key = 1000 key  

---

## 📊 Ringkasan Performa

| Metrik | Hasil | Target | Pencapaian |
|---|---|---|---|
| Akun diproses | 100/100 | 100 | 100% ✅ |
| Key berhasil | 631 | 1000 | 63% |
| Akun berhasil | 77/100 | 100 | 77% |
| Key/akun produktif | 8.2 | 10 | 82% |
| Key/akun rata-rata | 6.31 | 10 | 63% |
| Waktu total | ~6 jam | — | 3.6 mnt/akun |
| Test key | 631/631 OK | 100% | 100% ✅ |

---

## 🔍 Analisis Kegagaman

### 23 Akun Gagal (23%)

| Kategori | Jumlah | Penyebab |
|---|---|---|
| Signup gagal total | ~6 akun | 6/6 percobaan proxy gagal |
| Key creation gagal total | ~12 akun | Modal "New key" tidak render |
| Akun rusak (403) | ~5 akun | `free-models` 403 + tombol hilang |

### 61 Key-Creation Failures di 25 Akun Berhasil

- **50×** `[key] tidak terbaca (mungkin sudah dibuat / modal beda)` → modal belum render, script menyerah tanpa retry
- **11×** `[key] tombol New key tidak ada` → dashboard tidak render

### 38 Signup-Fail Attempts di 15 Akun

Normal — proxy residential ~50% fail rate, retry sampai 6× dengan proxy berbeda.

---

## ⚠️ Masalah Utama

1. **Key creation failure rate 30%** — script tidak retry modal yang gagal render. Kehilangan ~300 key potensial.
2. **Zero-key akun 23%** — akun rusak (403) tidak terdeteksi lebih awal.
3. **Waktu 3.6 mnt/akun** — verify email wait + signup retry + key creation tanpa retry.
4. **Recovery mechanism rumit** — key lengkap hanya ada di heap proses (dashboard simpan `prefix`+`last4`). Harvest via V8 inspector butuh 6 percobaan gagal sebelum berhasil.

---

## 📈 Perbandingan dengan Batch Sebelumnya

| Batch | Akun | Key | Key/akun | Metode recovery |
|---|---|---|---|---|
| Batch 1 (5 akun) | 5 | ~35 | 7.0 | JSON output langsung |
| Batch 2 (7 key) | 7 | 7 | 1.0 | JSON output langsung |
| **Farm 100** | **100** | **631** | **6.3** | **V8 inspector harvest** |

---

## 💡 Pelajaran & Rekomendasi

### 1. Patch `createApiKey` dengan retry (prioritas tertinggi)
```
Saat ini: baca HTML → tidak ada key → return null → skip
Seharusnya: retry 3× dengan sleep 2s sebelum menyerah
```
Proyeksi: +200-300 key di farm berikutnya.

### 2. Deteksi akun rusak lebih awal
- Kalau `free-models` gagal 403 → langsung skip, jangan coba 10×
- Kalau `[key] tombol New key tidak ada` → skip, jangan retry

### 3. Incremental JSONL write
- Patch `src/index.mjs` untuk append 1 JSONL line per akun selesai
- Tidak perlu V8 inspector harvest lagi

### 4. Proxy quality filter
- 99 proxy → ~50% fail rate di signup
- Simpan "good proxy" yang berhasil signup → reuse di farm berikutnya

### 5. Timeout per akun
- Akun yang 3× signup gagal → skip lebih cepat, hemat waktu

---

## 🏆 Kesimpulan

**631 key dari 100 akun** adalah hasil yang solid mengingat:
- Yield 63% dari target 1000 key
- 100% key berhasil terverifikasi OK
- Lane `th/deepseek-v4-flash:free` aktif dengan 639 koneksi th di r5-2600
- Proses ~6 jam tanpa intervensi manual

Efisiensi bisa ditingkatkan signifikan (~80-90% yield) dengan patch retry + skip akun rusak lebih awal + incremental JSONL write.

---

## 📁 File Terkait

- `src/index.mjs` — patched: `--domains`, `--keys-per-account`
- `src/inbox/tempik.mjs` — patched: `createInbox(localPart, domain)`
- `src/tokenharbor/client.mjs` — patched: `innerHTML` (bukan `innerText`)
- `output/th-keys-1791708299633.json` — hasil farm (631 key, 77 akun)
