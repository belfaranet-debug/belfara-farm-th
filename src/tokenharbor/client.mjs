/**
 * TokenHarbor client — signup, verifikasi email, aktifkan free models, buat API key.
 * Alur ini TERBUKTI 10/10 membuat API key pada 11 Okt 2026.
 *
 * Temuan penting yang membuat versi lama gagal:
 * 1. WAJIB Chrome asli (channel:'chrome'), bukan Chromium headless — Cloudflare cdn-cgi
 *    challenge memblokir Chromium.
 * 2. Login punya 2 tombol "Sign in" (header + form) -> wajib .last().
 * 3. Setelah signup, email verifikasi TIDAK otomatis — klik tombol "Verify email" dulu.
 * 4. Free models tidak aktif otomatis — POST /api/me/privacy {consent_version:2, free_models_enabled:true}.
 * 5. Buat key = modal "New key" -> isi label -> "Create key" -> baca thk_live_... dari halaman.
 */
import { chromium } from 'playwright';

const BASE = 'https://tokenharbor.ai';

export class TokenHarborClient {
  constructor({ proxy, headless = true, log = null }) {
    this.proxy = proxy; // { server, username, password } | null
    this.headless = headless;
    this.log = log ?? console.log;
  }

  #log(...a) { this.log(...a); }

  static parseProxy(line) {
    if (!line) return null;
    const u = new URL(line);
    return {
      server: `${u.protocol}//${u.host}`,
      username: u.username,
      password: u.password,
    };
  }

  async #launch() {
    const opts = { headless: this.headless, channel: 'chrome' };
    if (this.proxy) opts.proxy = this.proxy;
    // channel:'chrome' -> cari google-chrome di PATH
    return chromium.launch(opts);
  }

  /**
   * Signup akun baru. Mengembalikan browser+page yang sudah login, atau null kalau gagal.
   */
  async signup({ email, password, timeoutMs = 60000 }) {
    const browser = await this.#launch();
    const page = await browser.newPage();
    try {
      await page.goto(`${BASE}/login?mode=signup`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 30000 });

      const cookieBtn = page.getByRole('button', { name: /essential only/i });
      if (await cookieBtn.count() > 0) { await cookieBtn.click(); await new Promise(r => setTimeout(r, 800)); }

      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(password);
      await page.getByRole('button', { name: /create account/i }).click();
      await new Promise(r => setTimeout(r, 10000));

      if (!/\/dashboard/.test(page.url())) {
        this.#log(`  [signup] gagal: ${page.url()}`);
        await browser.close();
        return null;
      }
      this.#log('  [signup] DASHBOARD ok');

      // Minta email verifikasi (tidak dikirim otomatis)
      await new Promise(r => setTimeout(r, 2000));
      const verifyBtn = page.getByRole('button', { name: /verify email/i }).first();
      if (await verifyBtn.count()) {
        await verifyBtn.click().catch(() => {});
        this.#log('  [verify-request] klik "Verify email"');
        await new Promise(r => setTimeout(r, 4000));
      } else {
        const b = await page.evaluate(() => document.body.innerText).catch(() => '');
        this.#log('  [verify-request] tombol verify tidak ada; cek modal:', /verify your email/i.test(b));
        const notNow = page.getByRole('button', { name: /not now/i }).first();
        if (await notNow.count()) { await notNow.click().catch(() => {}); await new Promise(r => setTimeout(r, 1500)); }
        const verifyBtn2 = page.getByRole('button', { name: /verify email/i }).first();
        if (await verifyBtn2.count()) {
          await verifyBtn2.click().catch(() => {});
          this.#log('  [verify-request] klik verify (setelah modal)');
          await new Promise(r => setTimeout(r, 4000));
        }
      }
      return { browser, page };
    } catch (e) {
      this.#log('  [signup] ERR:', e.message.substring(0, 100));
      await browser.close().catch(() => {});
      return null;
    }
  }

  /** Klik link verifikasi dari email. */
  async verify(page, link) {
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));
    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText).catch(() => '');
    const ok = /verify=success|email verified/i.test(url + ' ' + text);
    this.#log(`  [verify] ${ok ? 'VERIFIED ok' : `url=${url} text=${text.slice(0, 100)}`}`);
    return ok;
  }

  /** Aktifkan free models (wajib untuk pakai model :free dengan saldo $0). */
  async enableFreeModels(page) {
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/me/privacy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent_version: 2, free_models_enabled: true }),
        credentials: 'include',
      });
      return { status: res.status, body: await res.text() };
    });
    const ok = r.status === 200 && /free_models_enabled.?[:=].?true/.test(r.body);
    this.#log(`  [free-models] ${ok ? 'AKTIF ok' : `gagal ${r.status} ${r.body.substring(0, 120)}`}`);
    return ok;
  }

  /** Buat satu API key dengan label. Mengembalikan string thk_live_... atau null. */
  async createApiKey(page, label) {
    try {
      // Pastikan di halaman API keys (setelah verify, halaman bisa di mana saja)
      await page.goto(`${BASE}/dashboard/api-keys`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await new Promise(r => setTimeout(r, 2500));

      const nk = page.getByRole('button', { name: /new key/i }).first();
      if (!(await nk.count())) { this.#log('  [key] tombol New key tidak ada'); return null; }
      await nk.click();
      await new Promise(r => setTimeout(r, 1800));

      const labelInput = page.locator('input[type="text"]').first();
      if (await labelInput.count()) await labelInput.fill(label).catch(() => {});

      const create = page.getByRole('button', { name: /^create key$/i }).first();
      if (await create.count()) {
        await create.click();
        await new Promise(r => setTimeout(r, 3500));
      }

      const txt = await page.evaluate(() => document.body.innerText).catch(() => '');
      const m = txt.match(/thk_live_[A-Za-z0-9_-]{20,}/);
      if (m) {
        this.#log(`  [key] dibuat: ${m[0].slice(0, 22)}...`);
        const close = page.getByRole('button', { name: /^(close|done|ok)$/i }).first();
        if (await close.count()) { await close.click().catch(() => {}); await new Promise(r => setTimeout(r, 1200)); }
        return m[0];
      }
      this.#log('  [key] tidak terbaca (mungkin sudah dibuat / modal beda)');
      await page.keyboard.press('Escape').catch(() => {});
      return null;
    } catch (e) {
      this.#log('  [key] ERR:', e.message.substring(0, 90));
      return null;
    }
  }
}

/** Tes API key: 1 panggilan chat model :free. True = berfungsi. */
export async function testApiKey(key, { model = 'deepseek-v4-flash:free', timeoutMs = 45000 } = {}) {
  try {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with OK' }],
        max_tokens: 8,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const b = await r.text().catch(() => '');
      return { ok: false, error: `HTTP ${r.status} ${b.substring(0, 100)}` };
    }
    const d = await r.json();
    return { ok: true, content: (d.choices?.[0]?.message?.content || '').substring(0, 40) };
  } catch (e) {
    return { ok: false, error: e.message.substring(0, 100) };
  }
}