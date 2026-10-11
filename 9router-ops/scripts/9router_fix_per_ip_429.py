#!/usr/bin/env python3
"""
9router — perbaiki 429 "Network rate limit reached" dengan proxy per-koneksi.

KASUS: seluruh node (mis. tokenharbor) berstatus `testStatus: unavailable` dengan
       `lastError: [429] Network rate limit reached`, `backoffLevel` naik, dan
       `modelLock_*` menumpuk. Key SEHAT — ini limit per-IP egress, bukan limit key.

MENGAPA field legacy: build 9router yang umum terpasang (v0.5.81) TIDAK mendukung
       `proxyPoolIds` (fitur multi-pool baru). Yang dibaca adalah field per-koneksi
       `connectionProxyEnabled` / `connectionProxyUrl` / `strictProxy`.

Pemakaian:
    python3 9router_fix_per_ip_429.py --list
    python3 9router_fix_per_ip_429.py --node tokenharbor --proxies proxies.txt --apply
    python3 9router_fix_per_ip_429.py --node tokenharbor --proxies proxies.txt --apply \
        --limit 100 --probe th/deepseek-v4-flash:free

Tanpa --apply = dry-run (tidak menulis apa pun).
"""

import argparse
import json
import os
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

DB = os.path.expanduser("~/.9router/db/data.sqlite")
BASE = os.environ.get("NINE_ROUTER_BASE", "http://127.0.0.1:20128")


# ─────────────────────────── helpers ───────────────────────────

def die(msg):
    print("ERROR:", msg, file=sys.stderr)
    sys.exit(1)


def load_proxies(path):
    with open(path) as fh:
        return [ln.strip() for ln in fh if ln.strip().startswith(("http://", "https://", "socks5://", "socks4://"))]


def get_password(db=DB):
    """Password dashboard = kolom `name` di tabel apiKeys (bukan `key`)."""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute("SELECT name FROM apiKeys WHERE isActive = 1 LIMIT 1").fetchone()
        if not row:
            row = con.execute("SELECT name FROM apiKeys LIMIT 1").fetchone()
        return row[0] if row else ""
    finally:
        con.close()


def get_bearer(db=DB):
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        row = con.execute("SELECT key FROM apiKeys WHERE isActive = 1 LIMIT 1").fetchone()
        return row[0] if row else ""
    finally:
        con.close()


def login(password, base=BASE):
    req = urllib.request.Request(
        f"{base}/api/auth/login",
        data=json.dumps({"password": password}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    resp = urllib.request.urlopen(req, timeout=15)
    for part in resp.headers.get("Set-Cookie", "").split(";"):
        if "auth_token" in part:
            return part.strip()
    return ""


def node_ids(con, name):
    rows = con.execute(
        "SELECT id FROM providerNodes WHERE name = ?", (name,)
    ).fetchall()
    if not rows:
        rows = con.execute(
            "SELECT id FROM providerNodes WHERE name LIKE ?", (f"%{name}%",)
        ).fetchall()
    return [r[0] for r in rows]


def connection_rows(con, name):
    ids = node_ids(con, name)
    if not ids:
        die(f"node '{name}' tidak ditemukan di providerNodes")
    q = ",".join("?" * len(ids))
    return con.execute(
        f"SELECT pc.id, pc.data FROM providerConnections pc WHERE pc.provider IN ({q})",
        ids,
    ).fetchall()


def probe(base, bearer, model, timeout=60):
    t0 = time.time()
    try:
        req = urllib.request.Request(
            f"{base}/v1/chat/completions",
            data=json.dumps(
                {"model": model, "messages": [{"role": "user", "content": "OK"}], "max_tokens": 16}
            ).encode(),
            headers={"Authorization": f"Bearer {bearer}", "Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=timeout)
        data, _ = json.JSONDecoder().raw_decode(resp.read().decode())
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        # HTTP 200 + content kosong = reasoning menghabiskan budget, bukan sukses penuh
        return ("200" if content else "200-empty", f"{time.time() - t0:.1f}s", content[:30])
    except urllib.error.HTTPError as exc:
        return (str(exc.code), f"{time.time() - t0:.1f}s", exc.read().decode()[:120])
    except Exception as exc:  # noqa: BLE001
        return ("ERR", f"{time.time() - t0:.1f}s", str(exc)[:80])


# ─────────────────────────── main ───────────────────────────

def cmd_list(con, name):
    rows = connection_rows(con, name)
    stats = {}
    with_proxy = 0
    locked = 0
    for _cid, raw in rows:
        try:
            d = json.loads(raw) if raw else {}
        except Exception:  # noqa: BLE001
            stats["parse_err"] = stats.get("parse_err", 0) + 1
            continue
        stats[d.get("testStatus", "?")] = stats.get(d.get("testStatus", "?"), 0) + 1
        psd = d.get("providerSpecificData") or {}
        if psd.get("connectionProxyUrl"):
            with_proxy += 1
        if any(k.startswith("modelLock_") for k in d):
            locked += 1
    print(f"node '{name}': {len(rows)} koneksi")
    print("  testStatus :", stats)
    print("  pakai proxy:", with_proxy)
    print("  modelLock  :", locked)


def cmd_fix(con, name, proxies, limit, apply_, probe_model, base, db=DB):
    rows = connection_rows(con, name)
    print(f"node '{name}': {len(rows)} koneksi | {len(proxies)} proxy")

    if not apply_:
        print("\n[DRY-RUN] tidak ada perubahan ditulis. Tambahkan --apply untuk menerapkan.")
        print(f"  akan set connectionProxyUrl round-robin untuk {min(limit or len(rows), len(rows))} koneksi")
        print("  akan reset testStatus=active, backoffLevel=0, hapus modelLock_*/lastError")
        return

    # backup
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak = f"{db}.bak-connproxy-{stamp}"
    shutil.copy(db, bak)
    print("backup:", bak)

    rw = sqlite3.connect(db)
    n = 0
    for i, (cid, raw) in enumerate(rows):
        if limit and n >= limit:
            break
        try:
            d = json.loads(raw) if raw else {}
        except Exception:  # noqa: BLE001
            continue
        psd = d.get("providerSpecificData") or {}
        psd["connectionProxyEnabled"] = True
        psd["connectionProxyUrl"] = proxies[i % len(proxies)]
        psd["connectionNoProxy"] = ""
        psd["strictProxy"] = True
        d["providerSpecificData"] = psd

        d["testStatus"] = "active"
        d["backoffLevel"] = 0
        d["errorCode"] = None
        d["lastError"] = None
        d["lastErrorAt"] = None
        d["rateLimitedUntil"] = None
        for key in list(d.keys()):
            if key.startswith("modelLock_"):
                d.pop(key, None)

        # PENTING: isActive adalah KOLOM terpisah, bukan bagian JSON
        rw.execute(
            "UPDATE providerConnections SET isActive = 1, data = ? WHERE id = ?",
            (json.dumps(d), cid),
        )
        n += 1
    rw.commit()
    rw.close()
    print(f"diperbarui: {n} koneksi")

    # verifikasi di level LANE (bukan DB)
    if probe_model:
        bearer = get_bearer()
        print(f"\nprobe lane '{probe_model}' (ground truth):")
        ok = 0
        for i in range(5):
            code, lat, extra = probe(base, bearer, probe_model)
            if code == "200":
                ok += 1
            print(f"  [{i + 1}] {code:10s} {lat:7s} {extra}")
            time.sleep(1.5)
        print(f"hasil: {ok}/5 OK")
        if ok == 0:
            print("\nPERINGATAN: lane masih gagal. Cek:")
            print("  1) apakah build yang jalan mendukung connectionProxyUrl:")
            print("     grep -rl connectionProxyUrl ~/.hermes/node/lib/node_modules/9router/app/.next-cli-build/server")
            print("  2) apakah proxy benar-benar hidup (curl -x <proxy> https://api.ipify.org)")
            print("  3) apakah isActive=1 di semua row")


def main():
    ap = argparse.ArgumentParser(description="Perbaiki 429 per-IP di 9router dengan proxy per-koneksi")
    ap.add_argument("--node", default="tokenharbor", help="nama providerNodes (default: tokenharbor)")
    ap.add_argument("--proxies", help="file proxy, satu per baris")
    ap.add_argument("--db", default=DB, help=f"path data.sqlite (default: {DB})")
    ap.add_argument("--base", default=BASE, help=f"base URL 9router (default: {BASE})")
    ap.add_argument("--limit", type=int, default=0, help="batasi jumlah koneksi yang diubah (0 = semua)")
    ap.add_argument("--apply", action="store_true", help="tulis perubahan (default: dry-run)")
    ap.add_argument("--probe", metavar="MODEL", help="setelah fix, probe lane ini (mis. th/deepseek-v4-flash:free)")
    ap.add_argument("--list", action="store_true", help="tampilkan ringkasan state lalu keluar")
    args = ap.parse_args()

    db = args.db
    if not os.path.exists(db):
        die(f"DB tidak ditemukan: {db}")

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)

    if args.list:
        cmd_list(con, args.node)
        con.close()
        return

    if not args.proxies:
        die("--proxies wajib (atau pakai --list)")

    proxies = load_proxies(args.proxies)
    if not proxies:
        die("file proxy kosong / format tidak dikenal")

    cmd_fix(con, args.node, proxies, args.limit, args.apply, args.probe, args.base, db)
    con.close()


if __name__ == "__main__":
    main()
