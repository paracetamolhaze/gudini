import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';

async function main() {
  const dir = path.resolve('data/tiktok-browser/windows-login');
  fs.mkdirSync(dir, { recursive: true });
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    `--user-data-dir=${path.join(dir, 'profile')}`, '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`, 'https://www.tiktok.com/login',
  ], { detached: true, stdio: 'ignore', windowsHide: false });
  chrome.unref();
  const endpoint = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (await fetch(endpoint + '/json/version').then(r => r.ok).catch(() => false)) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (!ready) throw new Error('ChromeStartupFailed');
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  try {
    let page = context.pages().find(p => !p.isClosed() && p.url().includes('tiktok.com')) ?? context.pages()[0] ?? await context.newPage();
    console.log('LOGIN_WINDOW_OPEN');
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      if (page.isClosed()) {
        const next = context.pages().find(p => !p.isClosed());
        if (!next) {
          if (!browser.isConnected()) break;
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        page = next;
      }
      const cookies = await context.cookies('https://www.tiktok.com');
      const session = cookies.some(c => ['sessionid', 'sessionid_ss'].includes(c.name) && c.value);
      const uid = cookies.some(c => ['uid_tt', 'uid_tt_ss'].includes(c.name) && c.value);
      if (session && uid) {
        await page.goto('https://www.tiktok.com/tiktokstudio/upload', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('input[type="file"][accept*="video"], input[type="file"][accept*="mp4"]').first().waitFor({ state: 'attached', timeout: 45000 });
        const storage = await context.storageState();
        storage.cookies = storage.cookies.filter(c => /(^|\.)tiktok\.com$/.test(c.domain));
        storage.origins = storage.origins.filter(o => { const host = new URL(o.origin).hostname; return host === 'tiktok.com' || host.endsWith('.tiktok.com'); });
        fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify(storage), { mode: 0o600 });
        console.log('SESSION_SAVED_AND_UPLOAD_VERIFIED');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    console.log('LOGIN_NOT_COMPLETED');
  } finally { await browser.close(); }
}
main().catch(e => { console.error(e.name || 'LOGIN_ERROR'); process.exitCode = 1; });
