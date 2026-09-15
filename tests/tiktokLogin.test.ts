import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { observeLogin, loginSignal } from '../lib/tiktok/loginDiagnostics';
import { openLoginPage } from '../lib/tiktok/browser';

test('opening login does not request a QR; QR cooldown still allows offered email login', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://www.tiktok.com/**', route => route.fulfill({ contentType: 'text/html', body: `<button onclick="document.body.dataset.qr='requested'">Use QR code</button><button onclick="document.body.dataset.method='email'">Use phone / email / username</button>` }));
    await openLoginPage(page, false);
    assert.equal(await page.locator('body').getAttribute('data-qr'), null);
    await openLoginPage(page, true);
    assert.equal(await page.locator('body').getAttribute('data-qr'), null);
    assert.equal(await page.locator('body').getAttribute('data-method'), 'email');
  } finally { await browser.close(); }
});

test('TikTok rate limit stops QR polling instead of leaving a scannable dead session', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route('https://www.tiktok.com/**', async route => {
      if (route.request().url().includes('/passport/')) {
        requests++;
        return route.fulfill({ json: { message: 'error', data: { error_code: 7, description: 'Maximum number of attempts reached. Try again later.', token: 'SECRET' } } });
      }
      return route.fulfill({ contentType: 'text/html', body: `<h1>QR login</h1><script>setInterval(()=>fetch('/passport/web/check_qrconnect/?token=SECRET'),100)</script>` });
    });
    const signals: any[] = [];
    observeLogin(page, s => signals.push(s));
    await page.goto('https://www.tiktok.com/login');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.ok(page.isClosed(), 'rejected QR page must close to stop automatic retry traffic');
    assert.equal(requests, 1);
    assert.ok(!JSON.stringify(signals).includes('SECRET'));
  } finally { await browser.close(); }
});

test('normal pending QR state is not a failed login and diagnostics omit credentials', () => {
  const s = loginSignal('https://www.tiktok.com/passport/web/check_qrconnect/?token=SECRET', 200, { message: 'success', data: { status: 'new', token: 'SECRET', user: 'PRIVATE' } });
  assert.equal(s?.state, 'new');
  assert.equal(s?.rateLimited, false);
  assert.ok(!JSON.stringify(s).includes('SECRET'));
  assert.equal(loginSignal('https://attacker.test/passport/web/check_qrconnect/', 429, {}), undefined);
});

test('waiting for a QR scan keeps the real browser session open', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const signals: any[] = [];
    observeLogin(page, s => signals.push(s));
    await page.route('https://www.tiktok.com/**', route => route.fulfill({ json: { message: 'success', data: { status: 'new' } } }));
    await page.goto('https://www.tiktok.com/passport/web/check_qrconnect/');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(page.isClosed(), false);
    assert.equal(signals.at(-1)?.state, 'new');
  } finally { await browser.close(); }
});
