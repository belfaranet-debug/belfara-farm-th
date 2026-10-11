#!/usr/bin/env node
/**
 * belfara-farm-th — buat API key TokenHarbor memakai inbox Tempik sendiri + Chrome asli.
 *
 * Contoh:
 *   node src/index.mjs -n 2
 *   node src/index.mjs -n 5 --mail-base-url https://YOUR-TEMPIK-WORKER.workers.dev --mailbox-domain your-domain.com --proxy-file proxies.txt
 *   node src/index.mjs --doctor
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TempikInbox } from './inbox/tempik.mjs';
import { TokenHarborClient, testApiKey } from './tokenharbor/client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { args[key] = next; i++; }
      else args[key] = true;
    } else if (a.startsWith('-') && a.length > 1) {
      args[a.slice(1)] = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : true;
      if (typeof args[a.slice(1)] === 'string') i++;
    }
  }
  return args;
}

const HELP = `
belfara-farm-th — TokenHarbor API-key provisioning (Tempik inbox + Chrome asli)

Pemakaian:
  node src/index.mjs [flags]

Flags:
  -n, --count             jumlah key (default 1)
  -o, --out               path output JSON (default output/th-keys-<ts>.json)
  -p, --password          password akun (default random 16 char)
      --prefix            prefix label key (default th)
      --mail-base-url     base URL Tempik worker (default https://YOUR-TEMPIK-WORKER.workers.dev)
      --mailbox-domain    domain inbox (default your-domain.com)
      --proxy-file        file proxy, satu per baris http://user:pass@host:port
      --headful           jalankan browser terlihat (debug)
      --timeout           timeout tunggu email verifikasi ms (default 240000)
      --test              tes tiap key setelah dibuat (chat :free)
      --doctor            cek lingkungan (node, chrome, deps)
  -h, --help              tampilkan ini
`;

function makeLocalPart(prefix) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

function localPartOf(email) {
  return email.split('@')[0];
}

function randPass(len = 16) {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

async function readProxyList(file) {
  if (!file) return [];
  const t = await fs.readFile(file, 'utf8');
  return t.split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith('http'));
}

async function doctor() {
  console.log('== doctor ==');
  console.log('node:', process.version);
  const { execSync } = await import('node:child_process');
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium']) {
    try { execSync(`which ${bin}`); console.log(`${bin}: OK`); }
    catch { console.log(`${bin}: TIDAK ADA`); }
  }
  try {
    const { chromium } = await import('playwright');
    const exe = chromium.executablePath();
    console.log('playwright chromium executable:', exe);
  } catch (e) { console.log('playwright: TIDAK ADA', e.message.substring(0, 80)); }
  console.log('panduan: pastikan google-chrome terpasang (bukan hanya chromium headless).');
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.h || a.help) return console.log(HELP);
  if (a.doctor) return doctor();

  const count = parseInt(a.count ?? '1', 10) || 1;
  const out = a.out || path.join(__dirname, '..', 'output', `th-keys-${Date.now()}.json`);
  const password = a.password || randPass();
  const prefix = a.prefix || 'th';
  const mailBase = a['mail-base-url'] || 'https://YOUR-TEMPIK-WORKER.workers.dev';
  const mailDomain = a['mailbox-domain'] || 'YOUR-DOMAIN.com';
  const proxyFile = a['proxy-file'];
  const allowHeadful = !!a.headful;
  const verifyTimeout = parseInt(a.timeout ?? '240000', 10) || 240000;
  const doTest = !!a.test;

  const proxies = await readProxyList(proxyFile);
  console.log(`[config] count=${count} domain=${mailDomain} proxy=${proxies.length} test=${doTest}`);
  console.log(`[config] password=${password}`);  // aman: ini akun yang dibuat, bukan rahasia lama

  // session Tempik sekali, dipakai semua akun
  const inbox = new TempikInbox({ baseUrl: mailBase, domain: mailDomain });
  await inbox.createSession();
  console.log('[tempik] session ok');

  const results = [];
  const MAX_PROXY_ATTEMPTS = 6; // proxy residential sering gagal (~50%) -> retry pindah proxy
  for (let i = 1; i <= count; i++) {
    console.log(`\n=== Akun ${i}/${count} ===`);
    const passwordForThis = password;
    const record = { email: null, password: passwordForThis, keys: [], proxy_attempts: 0 };
    let done = false;
    for (let attempt = 1; attempt <= MAX_PROXY_ATTEMPTS && !done; attempt++) {
      console.log(`\n  [attempt ${attempt}/${MAX_PROXY_ATTEMPTS}]`);
      const email = `${makeLocalPart(prefix)}@${mailDomain}`;
      try {
        const address = await inbox.createInbox(localPartOf(email));
        console.log('[tempik] inbox:', address);

        // proxy: pilih acak tiap percobaan
        let client = new TokenHarborClient({ proxy: null, headless: !allowHeadful });
        if (proxies.length) {
          const line = proxies[Math.floor(Math.random() * proxies.length)];
          client = new TokenHarborClient({ proxy: TokenHarborClient.parseProxy(line), headless: !allowHeadful });
        }
        record.proxy_attempts = attempt;
        const sess = await client.signup({ email, password: passwordForThis });
        if (!sess) {
          console.log('[akun] signup gagal, coba proxy lain');
          continue;
        }
        record.email = email;
        const { browser, page } = sess;

        // tunggu email verifikasi
        const link = await inbox.waitForVerifyLink(address, { timeoutMs: verifyTimeout, log: console.log });
        if (!link) {
          console.log('[akun] email verifikasi tidak sampai dalam batas waktu');
          await browser.close().catch(() => {});
          continue;
        }
        const verified = await client.verify(page, link);
        if (!verified) {
          console.log('[akun] verifikasi gagal');
          await browser.close().catch(() => {});
          continue;
        }

        // aktifkan free models
        await client.enableFreeModels(page);

        // buat 1 key (atau sesukamu: loop di sini untuk multi-key per akun)
        const key = await client.createApiKey(page, `${prefix}-${String(i).padStart(2, '0')}`);
        if (key) {
          record.keys.push(key);
          if (doTest) {
            const t = await testApiKey(key);
            console.log(`[test] ${t.ok ? 'OK ✅ ' + t.content : 'GAGAL ❌ ' + (t.error || '')}`);
            record.test = t.ok ? 'ok' : 'fail';
          }
        }
        await browser.close().catch(() => {});
        done = true;
      } catch (e) {
        console.log('[akun] ERR:', e.message.substring(0, 120));
      }
    }
    if (!record.email) record.email = `${makeLocalPart(prefix)}@${mailDomain}`;
    results.push(record);
  }

  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(results, null, 2));
  console.log(`\nSelesai. Hasil: ${out}`);
  console.log('Ringkasan:');
  let okKeys = 0;
  for (const r of results) { okKeys += r.keys.length; console.log(`  ${r.email} -> ${r.keys.length} key`); }
  console.log(`Total key: ${okKeys}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });