/**
 * 工作台存取密碼驗收（多人共用區網的情境）。
 * 重點不是「有沒有密碼欄位」，而是：
 *  - 沒設密碼時完全不影響現有用法
 *  - 設了之後別台電腦真的進不去，但**手機掃碼上傳照樣可用**（現場的人不能被擋）
 *  - 伺服器重啟後已登入的電腦不用重登（多人共用最怕每次重開都要重輸）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT ?? 4990);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-relay-auth-'));
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

let passed = 0;
let failed = 0;
const failures = [];
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

let cookie = '';
async function req(method, url, { json, body, useCookie = false, redirect = 'manual' } = {}) {
  const headers = {};
  if (useCookie && cookie) headers.cookie = cookie;
  const init = { method, headers, redirect };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) init.body = body;
  const res = await fetch(BASE + url, init);
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, location: res.headers.get('location') };
}

let child = null;
function startServer() {
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PHOTO_RELAY_PORT: String(PORT), PHOTO_RELAY_DATA: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));
}
async function waitReady(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
async function stopServer() {
  if (!child) return;
  const dead = new Promise((r) => child.once('exit', r));
  child.kill();
  await dead;
  child = null;
  await new Promise((r) => setTimeout(r, 400));
}

try {
  startServer();
  if (!(await waitReady())) throw new Error('伺服器沒起來');

  // ── 沒設密碼：一切照舊 ─────────────────────────────
  console.log('沒設密碼時');
  check('狀態顯示未啟用', (await req('GET', '/api/auth/status')).data.enabled === false);
  check('工作台直接打得開', (await req('GET', '/')).status === 200);
  check('管理 API 直接可用', (await req('GET', '/api/projects')).status === 200);

  const project = (await req('POST', '/api/projects', { json: { name: '密碼測試專案' } })).data;
  const device = (await req('POST', `/api/m/${project.token}/device`, { json: { deviceId: 'phone-1' } })).data;

  // ── 設密碼 ─────────────────────────────────────────
  console.log('\n設定密碼');
  check('太短的密碼被擋', (await req('POST', '/api/auth/password', { json: { password: '123' } })).status === 400);
  const setRes = await req('POST', '/api/auth/password', { json: { password: 'site-1234' } });
  check('設定成功並回發 cookie', setRes.status === 200 && setRes.data.enabled === true && cookie.length > 0);
  const myCookie = cookie;

  // ── 別台電腦（沒有 cookie）進不去 ──────────────────
  console.log('\n別台電腦（沒有 cookie）');
  cookie = '';
  const page = await req('GET', '/');
  check('開工作台被導到登入頁', page.status === 302 && page.location === '/login', `${page.status} → ${page.location}`);
  check('登入頁本身打得開', (await req('GET', '/login')).status === 200);
  check('管理 API 回 401 而不是默默給資料', (await req('GET', '/api/projects')).status === 401);
  check('照片 API 也擋住', (await req('GET', `/api/projects/${project.id}/photos`)).status === 401);
  check('設定 API 也擋住', (await req('GET', '/api/settings')).status === 401);

  // ── 手機掃碼上傳「不能」被擋 ───────────────────────
  console.log('\n手機端不受影響（關鍵）');
  check('手機頁打得開', (await req('GET', `/m/${project.token}`)).status === 200);
  check('手機取得專案內容 200', (await req('GET', `/api/m/${project.token}/context`)).status === 200);
  const rec = await req('POST', `/api/m/${project.token}/photos`, {
    json: { deviceRecordId: device.deviceRecordId, originalFileName: '現場.jpg' },
  });
  check('手機建立照片紀錄 201', rec.status === 201, String(rec.status));
  const put = await req('PUT', `/api/m/${project.token}/photos/${rec.data.photoId}/blob?kind=image`, { body: JPEG });
  check('手機上傳圖片成功（有密碼也照傳）', put.status === 200, String(put.status));
  check('靜態資源仍可載入（登入頁要用）', (await req('GET', '/assets/css/app.css')).status === 200);

  // ── 登入 ───────────────────────────────────────────
  console.log('\n登入');
  check('密碼錯誤回 401', (await req('POST', '/api/auth/login', { json: { password: 'wrong' } })).status === 401);
  cookie = '';
  const login = await req('POST', '/api/auth/login', { json: { password: 'site-1234' } });
  check('密碼正確可登入並拿到 cookie', login.status === 200 && cookie.length > 0);
  check('登入後工作台打得開', (await req('GET', '/', { useCookie: true })).status === 200);
  check('登入後管理 API 可用', (await req('GET', '/api/projects', { useCookie: true })).status === 200);

  // ── 重啟後不用重登 ─────────────────────────────────
  console.log('\n伺服器重啟後');
  const keep = cookie;
  await stopServer();
  startServer();
  if (!(await waitReady())) throw new Error('重啟失敗');
  cookie = keep;
  check('重啟後已登入的電腦不用重新輸入密碼', (await req('GET', '/api/projects', { useCookie: true })).status === 200);
  check('重啟後密碼設定仍在', (await req('GET', '/api/auth/status')).data.enabled === true);

  // ── 改密碼會把別台踢掉 ─────────────────────────────
  console.log('\n更改密碼');
  cookie = keep;
  const changed = await req('POST', '/api/auth/password', { json: { password: 'site-5678', currentPassword: 'site-1234' }, useCookie: true });
  check('要帶對舊密碼才能改', changed.status === 200, JSON.stringify(changed.data).slice(0, 80));
  const wrongOld = await req('POST', '/api/auth/password', { json: { password: 'x1234', currentPassword: 'wrong' }, useCookie: true });
  check('舊密碼錯誤改不動', wrongOld.status === 400, String(wrongOld.status));

  cookie = keep; // 舊 cookie（改密碼前發的）
  check('改密碼後舊 cookie 失效（別台要重輸）', (await req('GET', '/api/projects', { useCookie: true })).status === 401);

  // ── 密鑰不外洩 ─────────────────────────────────────
  console.log('\n不外洩');
  const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8'));
  check('密碼是雜湊過的，不是明文', !JSON.stringify(stored).includes('site-5678') && Boolean(stored.consolePassword?.hash));
  const status = (await req('GET', '/api/auth/status')).data;
  check('狀態 API 只回「有沒有啟用」，不吐雜湊', JSON.stringify(status) === JSON.stringify({ enabled: true, signedIn: false }), JSON.stringify(status));

  // ── 取消密碼 ───────────────────────────────────────
  console.log('\n取消密碼');
  cookie = '';
  await req('POST', '/api/auth/login', { json: { password: 'site-5678' } });
  const removed = await req('POST', '/api/auth/password/remove', { json: { currentPassword: 'site-5678' }, useCookie: true });
  check('取消成功', removed.status === 200 && removed.data.enabled === false);
  cookie = '';
  check('取消後工作台又可以直接開', (await req('GET', '/')).status === 200);

  console.log(`\n${'─'.repeat(52)}\n通過 ${passed}　失敗 ${failed}`);
  if (failures.length) {
    console.log('\n未通過：');
    failures.forEach((f) => console.log(`  · ${f}`));
  }
} catch (err) {
  failed++;
  console.error('\n測試中斷：', err.stack ?? err.message);
} finally {
  await stopServer();
  await fsp.rm(DATA, { recursive: true, force: true }).catch(() => {});
  process.exit(failed ? 1 : 0);
}
