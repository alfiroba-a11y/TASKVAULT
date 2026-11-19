import { createServer } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const storePath = join(dataDir, 'payments.json');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
let payments = {};
try { payments = JSON.parse(await readFile(storePath, 'utf8')); } catch { /* first start */ }
async function savePayments() {
  await mkdir(dataDir, { recursive: true });
  const temp = `${storePath}.tmp`;
  await writeFile(temp, JSON.stringify(payments, null, 2), { mode: 0o600 });
  await rename(temp, storePath);
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }
async function body(req, max = 10000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('Request too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function normalizePhone(input) {
  let p = String(input || '').replace(/[\s()+-]/g, '');
  if (p.startsWith('0')) p = `254${p.slice(1)}`;
  if (p.startsWith('7') || p.startsWith('1')) p = `254${p}`;
  return /^254[17]\d{8}$/.test(p) ? p : null;
}
const limits = new Map();
function limited(ip) {
  const now = Date.now(), old = limits.get(ip) || { at: now, count: 0 };
  if (now - old.at > 60000) { old.at = now; old.count = 0; }
  old.count++; limits.set(ip, old); return old.count > 5;
}
async function initiatePrompt({ amount, phone, reference }) {
  const callback = String(process.env.HASHPAY_WEBHOOK_URL || `${process.env.PUBLIC_BASE_URL || ''}/webhooks/hashpay`).replace(/\/$/, '');
  const response = await fetch('https://api.hashback.co.ke/initiatestk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: process.env.HASHPAY_API_KEY, account_id: process.env.HASHPAY_ACCOUNT_ID, amount: String(amount), msisdn: phone, reference, ...(callback ? { callback_webhook: callback } : {}) }),
    signal: AbortSignal.timeout(20000)
  });
  const result = await response.json().catch(() => ({}));
  const accepted = result.success === true || result.success === 'true' || String(result.ResponseCode) === '0';
  if (!response.ok || !accepted) throw new Error(result.message || result.ResponseDescription || 'HashPay did not accept the prompt.');
  return result;
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', hashpayConfigured: Boolean(process.env.HASHPAY_API_KEY && process.env.HASHPAY_ACCOUNT_ID), webhookConfigured: Boolean(process.env.HASHPAY_WEBHOOK_SECRET) });
    if (req.method === 'POST' && url.pathname === '/api/payments/prompt') {
      if (!process.env.HASHPAY_API_KEY || !process.env.HASHPAY_ACCOUNT_ID || !process.env.HASHPAY_WEBHOOK_SECRET || !(process.env.PUBLIC_BASE_URL || process.env.HASHPAY_WEBHOOK_URL)) return json(res, 503, { error: 'HashPay environment settings are incomplete.' });
      if (limited(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'Too many payment prompts. Try again in a minute.' });
      const input = JSON.parse((await body(req)).toString('utf8'));
      const amount = Math.round(Number(input.amount));
      const phone = normalizePhone(input.phone);
      if (!Number.isInteger(amount) || amount < 1 || amount > 150000) return json(res, 400, { error: 'Enter a valid amount from KES 1 to KES 150,000.' });
      if (!phone) return json(res, 400, { error: 'Enter a valid Kenyan M-Pesa number.' });
      const reference = `TV${Date.now().toString(36).toUpperCase()}${randomUUID().slice(0, 6).toUpperCase()}`;
      const record = { reference, amount, phoneLast4: phone.slice(-4), status: 'starting', createdAt: new Date().toISOString() };
      payments[reference] = record; await savePayments();
      try {
        const provider = await initiatePrompt({ amount, phone, reference });
        record.checkoutId = provider.checkout_id || provider.CheckoutRequestID || null;
        record.merchantRequestId = provider.MerchantRequestID || null;
        record.status = 'pending'; record.customerMessage = provider.CustomerMessage || 'Check your phone and enter your M-Pesa PIN to complete.';
        await savePayments();
        return json(res, 200, { reference, status: record.status, customerMessage: record.customerMessage });
      } catch (error) {
        record.status = 'failed'; record.failure = error.message; await savePayments();
        return json(res, 502, { error: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/payments/')) {
      const reference = decodeURIComponent(url.pathname.slice('/api/payments/'.length));
      const record = payments[reference];
      return record ? json(res, 200, { reference, status: record.status, amount: record.amount, receipt: record.receipt || null }) : json(res, 404, { error: 'Payment not found.' });
    }
    if (req.method === 'POST' && url.pathname === '/webhooks/hashpay') {
      if (!process.env.HASHPAY_WEBHOOK_SECRET) return json(res, 503, { error: 'Webhook is not configured.' });
      const raw = await body(req, 100000);
      const signature = req.headers['x-hashpay-signature'] || '';
      const expected = `sha256=${createHmac('sha256', process.env.HASHPAY_WEBHOOK_SECRET).update(raw).digest('hex')}`;
      const a = Buffer.from(String(signature)), b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return json(res, 401, { error: 'Invalid webhook signature.' });
      const event = JSON.parse(raw.toString('utf8'));
      const reference = String(event.TransactionReference || event.reference || '');
      const record = payments[reference];
      if (record && record.status !== 'paid' && (event.event === 'payment.success' || String(event.ResponseCode) === '0')) {
        const paid = Number(event.TransactionAmount ?? event.amount);
        const accountMatches = !process.env.HASHPAY_ACCOUNT_ID || String(event.AccountID || process.env.HASHPAY_ACCOUNT_ID) === String(process.env.HASHPAY_ACCOUNT_ID);
        if (paid === record.amount && accountMatches) {
          record.status = 'paid'; record.receipt = String(event.TransactionReceipt || event.TransactionID || event.receipt || '');
          record.paidAt = new Date().toISOString(); await savePayments();
        } else {
          console.warn('HashPay callback did not match the pending Task Vault payment', { reference, amount: paid, accountMatches });
        }
      }
      return json(res, 200, { received: true });
    }
    const pathname = decodeURIComponent(url.pathname);
    const relative = pathname === '/' || pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.slice(1);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) return res.writeHead(403).end('Forbidden');
    const file = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    res.end(file);
  } catch (error) {
    console.error('Task Vault request failed:', error.message);
    json(res, error.message === 'Request too large' ? 413 : 400, { error: error.message || 'Request failed.' });
  }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, '0.0.0.0', () => console.log(`Task Vault listening on port ${port}`));
