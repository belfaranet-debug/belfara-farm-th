/**
 * Tempik inbox provider — self-hosted Cloudflare Worker + D1.
 *
 * Kontrak API (terbukti hidup 11 Okt 2026):
 *   GET  /api/session                      -> { sessionId }
 *   POST /api/inboxes                      -> { address, ... }  body: { domain, localPart }
 *   GET  /api/inboxes                      -> { inboxes: [...] }
 *   GET  /api/inboxes/:address/messages    -> [ { from, subject, text, ... } ]
 *
 * Semua request kecuali GET /api/session wajib header `x-session-id`.
 */
export class TempikInbox {
  constructor({ baseUrl, domain, sessionId = null }) {
    if (!baseUrl) throw new Error('TempikInbox: baseUrl wajib');
    if (!domain) throw new Error('TempikInbox: domain wajib (domain sendiri, bukan disposable)');
    this.base = baseUrl.replace(/\/$/, '');
    this.domain = domain;
    this.sessionId = sessionId;
  }

  async #fetch(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (this.sessionId) headers['x-session-id'] = this.sessionId;
    const r = await fetch(this.base + path, { ...opts, headers });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!r.ok) throw new Error(`Tempik ${r.status} ${path}: ${typeof body === 'string' ? body : JSON.stringify(body).substring(0, 140)}`);
    return body;
  }

  async createSession() {
    const d = await this.#fetch('/api/session', { method: 'GET' });
    this.sessionId = d.sessionId || d.session_id || d.id;
    if (!this.sessionId) throw new Error('Tempik: tidak dapat sessionId');
    return this.sessionId;
  }

  async createInbox(localPart, domain = null) {
    const d = domain || this.domain;
    const res = await this.#fetch('/api/inboxes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain: d, localPart }),
    });
    return res.address || `${localPart}@${d}`;
  }

  /** Poll sampai menemukan link verifikasi TokenHarbor. Balas URL link atau null. */
  async waitForVerifyLink(address, { timeoutMs = 240000, intervalMs = 5000, log = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    const enc = encodeURIComponent(address);
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const msgs = await this.#fetch(`/api/inboxes/${enc}/messages`, { method: 'GET' });
        const all = JSON.stringify(msgs ?? []);
        const m = all.match(/https:\/\/tokenharbor\.ai\/verify-email\?token=[A-Za-z0-9._~-]+/i);
        if (m) return m[0];
        log?.(`[inbox] ${Array.isArray(msgs) ? msgs.length : '?'} pesan, menunggu verifikasi...`);
      } catch (e) {
        log?.(`[inbox] poll error: ${e.message.substring(0, 80)}`);
      }
    }
    return null;
  }
}