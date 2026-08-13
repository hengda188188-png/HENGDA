/**
 * 持久性驗收：多人多台共用同一專案，跨日、跨重啟，打開網頁還要看得到全部過去紀錄。
 * 做法＝真的起一台伺服器寫資料 → 真的把它殺掉 → 再起一次 → 逐項比對。
 * 不是「應該會在」，是實際殺掉再確認。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT ?? 4989);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-relay-persist-'));
// 測試行程自己也要指到暫存資料夾：本檔會 import ../src/store.mjs 直接操作資料層，
// 沒設的話會寫進正式的 data/（實測踩過：正式庫被灌入 2 個測試專案 16 筆假照片）。
process.env.PHOTO_RELAY_DATA = DATA;

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

async function req(method, url, { json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) init.body = body;
  const res = await fetch(BASE + url, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
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
  // ── 第一天：兩個人、兩台設備，各傳一張 ──────────────
  console.log('第一輪：寫入資料');
  startServer();
  if (!(await waitReady())) throw new Error('伺服器沒起來');

  const project = (await req('POST', '/api/projects', { json: { name: '共用工地專案', ownerName: '阿明' } })).data;

  const devA = (await req('POST', `/api/m/${project.token}/device`, {
    json: { deviceId: 'phone-of-ming' },
    headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' },
  })).data;
  const devB = (await req('POST', `/api/m/${project.token}/device`, {
    json: { deviceId: 'phone-of-hua' },
    headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' },
  })).data;

  await req('PATCH', `/api/devices/${devA.deviceRecordId}`, { json: { label: '阿明', version: 1 } });
  await req('PATCH', `/api/devices/${devB.deviceRecordId}`, { json: { label: '小華', version: 1 } });

  const photoIds = [];
  for (const [dev, name, note] of [[devA, '一樓外牆', '有裂縫'], [devB, '二樓管線', '要重拉']]) {
    const rec = (await req('POST', `/api/m/${project.token}/photos`, {
      json: { deviceRecordId: dev.deviceRecordId, originalFileName: `${name}.jpg` },
    })).data;
    await req('PUT', `/api/m/${project.token}/photos/${rec.photoId}/blob?kind=image&w=1&h=1`, { body: JPEG });
    await req('PUT', `/api/m/${project.token}/photos/${rec.photoId}/blob?kind=thumb`, { body: JPEG });
    const current = (await req('GET', `/api/photos/${rec.photoId}`)).data;
    await req('PATCH', `/api/photos/${rec.photoId}`, {
      json: {
        name,
        note,
        status: 'confirmed',
        annotations: [{ type: 'arrow', color: '#e0332a', size: 0.007, from: { x: 1, y: 1 }, to: { x: 5, y: 5 } }],
        version: current.version,
      },
    });
    photoIds.push(rec.photoId);
  }

  const before = (await req('GET', `/api/projects/${project.id}/photos`)).data;
  check('寫入完成：2 張照片、2 台設備、各有歸屬', before.total === 2 && before.deviceStats.length === 2);

  // ── 殺掉伺服器（模擬關機／當機／隔天重開）──────────
  console.log('\n第二輪：殺掉伺服器再重開');
  await stopServer();
  check('伺服器已真的停止', await fetch(`${BASE}/healthz`).then(() => false).catch(() => true));

  startServer();
  if (!(await waitReady())) throw new Error('重啟後伺服器沒起來');
  check('伺服器重新啟動成功', true);

  // ── 重啟後逐項比對 ─────────────────────────────────
  const projects = (await req('GET', '/api/projects')).data;
  check('專案還在', projects.rows.some((p) => p.id === project.id), `找到 ${projects.total} 個專案`);

  const reopened = projects.rows.find((p) => p.id === project.id);
  check('專案的 QR token 沒變（舊 QR 還能用）', reopened.token === project.token);
  check('專案照片張數正確', reopened.photoCount === 2, String(reopened.photoCount));

  const after = (await req('GET', `/api/projects/${project.id}/photos`)).data;
  check('照片清單載得回來', after.total === 2);
  check('名稱與備註都在', after.rows.map((p) => p.name).sort().join(',') === '一樓外牆,二樓管線', after.rows.map((p) => p.name).join(','));
  check('備註沒掉', after.rows.every((p) => p.note.length > 0));
  check('確認狀態沒掉', after.rows.every((p) => p.status === 'confirmed'));
  check('標註（箭頭）沒掉', after.rows.every((p) => p.annotations?.length === 1));

  check('設備歸屬名稱還在（誰傳的認得出來）',
    after.rows.map((p) => p.uploaderName).sort().join(',') === '小華,阿明',
    after.rows.map((p) => p.uploaderName).join(','));
  check('設備短碼與機型都還在',
    after.rows.every((p) => /^[A-Z2-9]{4}$/.test(p.device?.shortCode ?? '') && p.device?.model),
    JSON.stringify(after.rows.map((p) => p.device?.model)));

  const fileRes = await fetch(`${BASE}/api/photos/${photoIds[0]}/file?kind=image`);
  check('照片實體檔案還讀得到', fileRes.status === 200 && Number(fileRes.headers.get('content-length')) > 0);

  check('設備篩選 chips 仍列出兩台', after.deviceStats.length === 2);

  // ── 跨日：同一台手機隔天再來 ───────────────────────
  console.log('\n第三輪：跨日行為');
  const store = await import('../src/store.mjs');
  const todayDevices = (await req('GET', `/api/projects/${project.id}/devices`)).data;
  check('「今日設備」面板只列今天（符合當天歸屬的設計）',
    todayDevices.rows.every((d) => d.dateKey === todayDevices.today) && todayDevices.rows.length === 2);

  const allDevices = (await req('GET', `/api/projects/${project.id}/devices?date=all`)).data;
  check('可以查全部日期的設備（回頭找過去紀錄）', allDevices.rows.length >= 2, `${allDevices.rows.length} 台`);

  check('過去照片的歸屬不會因為跨日而消失',
    after.rows.every((p) => p.uploaderName && p.uploaderName !== '—'));

  // ── 備份檔 ─────────────────────────────────────────
  check('重啟時自動備份前一版 db（改壞了救得回來）', fs.existsSync(path.join(DATA, 'db.backup.json')));
  const backup = JSON.parse(fs.readFileSync(path.join(DATA, 'db.backup.json'), 'utf8'));
  check('備份內容完整', backup.photos?.length === 2 && backup.devices?.length === 2);

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
