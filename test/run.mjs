/**
 * 規格驗收測試：build-spec 的每條業務規則 R1–R11 各對應至少一個測試句。
 * 一律跑在暫存資料夾（PHOTO_RELAY_DATA），不碰正式 data/。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.TEST_PORT ?? 4988);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-relay-test-'));
// 測試行程自己也要指到暫存資料夾：本檔會 import ../src/store.mjs 直接操作資料層，
// 沒設的話會寫進正式的 data/（實測踩過：正式庫被灌入 2 個測試專案 16 筆假照片）。
process.env.PHOTO_RELAY_DATA = DATA;

// 1×1 白色 JPEG（合法 magic bytes）
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);
const NOT_IMAGE = Buffer.from('MZ\x90\x00This is definitely not an image, it is an executable header.');

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(method, url, { json, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (body !== undefined) {
    init.body = body;
  }
  const res = await fetch(BASE + url, init);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

// ── 啟動待測伺服器 ──────────────────────────────────────────
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PHOTO_RELAY_PORT: String(PORT), PHOTO_RELAY_DATA: DATA },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));

async function waitReady(timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 還沒起來 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  if (!(await waitReady())) throw new Error('伺服器沒有在時限內啟動');
  console.log(`\n測試資料夾：${DATA}\n`);

  // ── 專案與使用者 ───────────────────────────────────────
  console.log('專案 / 使用者');
  const created = await req('POST', '/api/projects', { json: { name: '測試專案', ownerName: '阿明', note: '單元測試' } });
  check('建立專案回 201 且有 token', created.status === 201 && typeof created.data.token === 'string', JSON.stringify(created.data).slice(0, 120));
  const project = created.data;

  const emptyName = await req('POST', '/api/projects', { json: { name: '   ' } });
  check('空白專案名稱被擋（400）', emptyName.status === 400, `得到 ${emptyName.status}`);

  const users = await req('GET', '/api/users');
  check('建立者自動登記成使用者', users.data.rows?.some((u) => u.name === '阿明'));

  // ── 設備識別（手機不必輸入名字）────────────────────────
  console.log('\n設備識別 / 歸屬指派');
  const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
  const dev1 = await req('POST', `/api/m/${project.token}/device`, {
    json: { deviceId: 'device-aaa-111', info: { screen: '390x844' } },
    headers: { 'user-agent': IPHONE_UA },
  });
  check('設備報到取得短碼', dev1.status === 200 && /^[A-Z2-9]{4}$/.test(dev1.data.shortCode ?? ''), JSON.stringify(dev1.data));
  check('設備機型有被辨識出來', dev1.data.model === 'iPhone', dev1.data.model);
  check('新設備預設沒有歸屬名稱（等電腦端指派）', dev1.data.label === '');

  const dev1again = await req('POST', `/api/m/${project.token}/device`, { json: { deviceId: 'device-aaa-111', info: {} } });
  check('同一天同一台再報到 → 同一筆紀錄', dev1again.data.deviceRecordId === dev1.data.deviceRecordId);

  const dev2 = await req('POST', `/api/m/${project.token}/device`, { json: { deviceId: 'device-bbb-222', info: {} } });
  check('不同裝置 → 不同短碼', dev2.data.shortCode !== dev1.data.shortCode);

  const deviceList = await req('GET', `/api/projects/${project.id}/devices`);
  check('設備清單只列今天', deviceList.data.rows.length === 2 && deviceList.data.dateKey === deviceList.data.today);

  const named = await req('PATCH', `/api/devices/${dev1.data.deviceRecordId}`, { json: { label: '王小明', version: 1 } });
  check('電腦端可以指派歸屬名稱', named.status === 200 && named.data.label === '王小明', JSON.stringify(named.data).slice(0, 120));

  const staleLabel = await req('PATCH', `/api/devices/${dev1.data.deviceRecordId}`, { json: { label: '搶著改', version: 1 } });
  check('指派歸屬也走樂觀鎖（過期 version → 409）', staleLabel.status === 409, `得到 ${staleLabel.status}`);

  const seenAgain = await req('POST', `/api/m/${project.token}/device`, { json: { deviceId: 'device-aaa-111', info: {} } });
  check('手機端看得到電腦端指派的名字', seenAgain.data.label === '王小明', seenAgain.data.label);

  // ── R1 授權 ────────────────────────────────────────────
  console.log('\nR1 上傳授權');
  const badToken = await req('POST', '/api/m/deadbeefdeadbeefdeadbeefdeadbeef/photos', { json: { uploaderName: '駭客' } });
  check('錯誤 token 建立照片 → 401', badToken.status === 401, `得到 ${badToken.status}`);

  const ctx = await req('GET', `/api/m/${project.token}/context`);
  check('正確 token 取得專案內容', ctx.status === 200 && ctx.data.project.name === '測試專案');

  // ── 正常上傳流程 ────────────────────────────────────────
  console.log('\n上傳流程');
  const rec = await req('POST', `/api/m/${project.token}/photos`, {
    json: { deviceRecordId: dev1.data.deviceRecordId, originalFileName: '../../evil.jpg', width: 1, height: 1 },
  });
  check('建立照片紀錄回 201', rec.status === 201 && rec.data.photoId, JSON.stringify(rec.data));
  const photoId = rec.data.photoId;

  const put = await req('PUT', `/api/m/${project.token}/photos/${photoId}/blob?kind=image&w=1&h=1`, {
    body: JPEG,
    headers: { 'content-type': 'image/jpeg' },
  });
  check('上傳圖片位元組成功', put.status === 200 && put.data.mime === 'image/jpeg', JSON.stringify(put.data));

  // R5 檔名安全
  const onDisk = fs.readdirSync(path.join(DATA, 'projects', project.id, 'original'));
  check('R5 落地檔名用 photoId，不是使用者檔名', onDisk.includes(`${photoId}.jpg`) && !onDisk.some((f) => f.includes('evil')), onDisk.join(','));
  check('R5 沒有寫到專案資料夾外面', !fs.existsSync(path.join(DATA, 'evil.jpg')));

  const photos = await req('GET', `/api/projects/${project.id}/photos`);
  check('照片清單看得到剛上傳的照片', photos.data.total === 1 && photos.data.rows[0].id === photoId);
  check('照片帶得出設備資訊（短碼/機型/歸屬）', photos.data.rows[0].device?.shortCode === dev1.data.shortCode && photos.data.rows[0].uploaderName === '王小明',
    JSON.stringify(photos.data.rows[0].device));
  check('照片有記錄歸屬日期', photos.data.rows[0].dateKey === deviceList.data.today, photos.data.rows[0].dateKey);
  check('照片記得原始檔名（只當資料，不當路徑）', photos.data.rows[0].originalFileName.includes('evil.jpg'));

  const fileRes = await fetch(`${BASE}/api/photos/${photoId}/file?kind=image`);
  check('取得照片原圖 200', fileRes.status === 200 && fileRes.headers.get('content-type') === 'image/jpeg');

  // ── R2 型別白名單 ──────────────────────────────────────
  console.log('\nR2 檔案型別');
  const rec2 = await req('POST', `/api/m/${project.token}/photos`, { json: { deviceRecordId: dev1.data.deviceRecordId, originalFileName: 'fake.jpg' } });
  const badType = await req('PUT', `/api/m/${project.token}/photos/${rec2.data.photoId}/blob?kind=image`, {
    body: NOT_IMAGE,
    headers: { 'content-type': 'image/jpeg' },
  });
  check('偽裝成 jpg 的非圖片 → 400 E_BAD_TYPE', badType.status === 400 && badType.data.error?.code === 'E_BAD_TYPE', JSON.stringify(badType.data));
  const dir2 = fs.readdirSync(path.join(DATA, 'projects', project.id, 'original'));
  check('R2 被擋掉的檔案沒有殘留（含 .part）', !dir2.some((f) => f.startsWith(rec2.data.photoId)), dir2.join(','));

  const emptyBody = await req('POST', `/api/m/${project.token}/photos`, { json: { deviceRecordId: dev1.data.deviceRecordId } });
  const emptyPut = await req('PUT', `/api/m/${project.token}/photos/${emptyBody.data.photoId}/blob?kind=image`, { body: Buffer.alloc(0) });
  check('空檔案被擋', emptyPut.status === 400, `得到 ${emptyPut.status}`);

  // ── R3 檔案大小 ────────────────────────────────────────
  console.log('\nR3 檔案大小上限');
  await req('POST', '/api/settings', { json: { maxFileBytes: 200 * 1024 } });
  const rec3 = await req('POST', `/api/m/${project.token}/photos`, { json: { deviceRecordId: dev1.data.deviceRecordId } });
  const big = Buffer.concat([JPEG, Buffer.alloc(300 * 1024, 0x20)]);
  const tooBig = await req('PUT', `/api/m/${project.token}/photos/${rec3.data.photoId}/blob?kind=image`, { body: big });
  check('超過上限 → 413', tooBig.status === 413, `得到 ${tooBig.status} ${JSON.stringify(tooBig.data).slice(0, 80)}`);
  const dir3 = fs.readdirSync(path.join(DATA, 'projects', project.id, 'original'));
  check('R3 超限檔案沒有留在磁碟', !dir3.some((f) => f.startsWith(rec3.data.photoId)), dir3.join(','));
  await req('POST', '/api/settings', { json: { maxFileBytes: 25 * 1024 * 1024 } });

  // ── R4 數量上限 ────────────────────────────────────────
  console.log('\nR4 數量上限');
  await req('POST', '/api/settings', { json: { maxPhotosPerProject: 1 } });
  const overLimit = await req('POST', `/api/m/${project.token}/photos`, { json: { deviceRecordId: dev1.data.deviceRecordId } });
  check('超過單一專案張數上限 → 400 E_LIMIT', overLimit.status === 400 && overLimit.data.error?.code === 'E_LIMIT', JSON.stringify(overLimit.data));
  await req('POST', '/api/settings', { json: { maxPhotosPerProject: 2000 } });

  // ── R6 樂觀鎖 ──────────────────────────────────────────
  console.log('\nR6 樂觀鎖');
  const current = await req('GET', `/api/photos/${photoId}`);
  const ok1 = await req('PATCH', `/api/photos/${photoId}`, { json: { name: '第一次命名', version: current.data.version } });
  check('帶正確 version 可以改', ok1.status === 200 && ok1.data.name === '第一次命名');
  const stale = await req('PATCH', `/api/photos/${photoId}`, { json: { name: '搶著改', version: current.data.version } });
  check('帶過期 version → 409', stale.status === 409, `得到 ${stale.status}`);
  check('409 有附最新內容供前端還原', stale.data.error?.current?.name === '第一次命名', JSON.stringify(stale.data).slice(0, 140));

  const badStatus = await req('PATCH', `/api/photos/${photoId}`, { json: { status: '亂填' } });
  check('不合法狀態被擋', badStatus.status === 400);

  // ── 裁切版本：原圖不覆寫（R9 伺服器側）────────────────
  console.log('\nR9 裁切不覆寫原圖');
  const originalPath = path.join(DATA, 'projects', project.id, 'original', `${photoId}.jpg`);
  const originalBytesBefore = fs.statSync(originalPath).size;
  const edited = await req('PUT', `/api/photos/${photoId}/edited?w=1&h=1&cx=0&cy=0&cw=1&ch=1&rotate=0`, { body: JPEG });
  check('回存裁切版本成功', edited.status === 200 && edited.data.edited?.file, JSON.stringify(edited.data).slice(0, 120));
  check('原圖檔案未被覆寫', fs.statSync(originalPath).size === originalBytesBefore);
  check('裁切座標有被記錄（可追溯）', edited.data.crop?.w === 1);
  const reverted = await req('DELETE', `/api/photos/${photoId}/edited`);
  check('還原後 edited 檔案被清掉', reverted.status === 200 && !reverted.data.edited && !fs.existsSync(path.join(DATA, 'projects', project.id, 'edited', `${photoId}.jpg`)));

  // ── R7 / R8 只上傳已確認、不重複上傳 ──────────────────
  console.log('\nR7/R8 上傳條件');
  const noDrive = await req('POST', `/api/projects/${project.id}/drive/upload`, { json: {} });
  check('未設定 Google 憑證 → 明確擋下不靜默失敗', noDrive.status === 400 && ['E_DRIVE_SETUP', 'E_DRIVE_AUTH'].includes(noDrive.data.error?.code), JSON.stringify(noDrive.data));

  const store = await import('../src/store.mjs');
  store._resetForTest();
  const p = store.createProject({ name: '規則檢查' });
  const devA = store.ensureDevice({ projectId: p.id, deviceId: 'unit-a' });
  const devB = store.ensureDevice({ projectId: p.id, deviceId: 'unit-b' });
  const mk = (status, drive, deviceId = devA.id) => {
    const ph = store.createPhoto({ projectId: p.id, deviceId });
    store.updatePhoto(ph.id, { status });
    if (drive) store.setPhotoDrive(ph.id, drive);
    return ph;
  };
  mk('pending');
  mk('excluded');
  const confirmedNew = mk('confirmed');
  mk('confirmed', { fileId: 'already', link: 'x' });
  const targets = store.photosForUpload(p.id);
  check('R7 只挑「已確認」的照片', targets.every((x) => x.status === 'confirmed'));
  check('R8 已上傳過的不重複挑', targets.length === 1 && targets[0].id === confirmedNew.id, `挑到 ${targets.length} 張`);
  check('R8 強制重傳時才會包含已上傳', store.photosForUpload(p.id, { includeUploaded: true }).length === 2);

  // ── 分頁三件套 ─────────────────────────────────────────
  console.log('\n分頁 / 搜尋 / 篩選');
  for (let i = 0; i < 12; i++) {
    const ph = store.createPhoto({ projectId: p.id, deviceId: i % 2 ? devA.id : devB.id });
    store.updatePhoto(ph.id, { name: `照片-${i}` });
  }
  const page1 = store.listPhotos(p.id, { page: 1, pageSize: 6 });
  check('分頁：每頁筆數正確', page1.rows.length === 6 && page1.pageCount === Math.ceil(page1.total / 6));
  check('分頁：有回總筆數與統計', page1.total === 16 && page1.stats.confirmed === 2, JSON.stringify(page1.stats));
  check('搜尋：關鍵字命中名稱', store.listPhotos(p.id, { q: '照片-1' }).total === 3);
  check('篩選：依設備', store.listPhotos(p.id, { device: devB.id }).total === 6, String(store.listPhotos(p.id, { device: devB.id }).total));

  // ── 歸屬只綁「當天＋該專案」───────────────────────────
  console.log('\n歸屬範圍（當天 / 該專案）');
  store.labelDevice(devA.id, '今日甲班');
  const tomorrow = store.ensureDevice({ projectId: p.id, deviceId: 'unit-a', dateKey: '2999-12-31' });
  check('次日同一台 → 產生新紀錄且歸屬要重新指派', tomorrow.id !== devA.id && tomorrow.label === '', JSON.stringify({ id: tomorrow.id, label: tomorrow.label }));
  check('次日短碼與今日不同（避免混淆）', tomorrow.shortCode !== store.getDevice(devA.id).shortCode);

  const otherProject = store.createProject({ name: '另一個專案' });
  const sameDeviceElsewhere = store.ensureDevice({ projectId: otherProject.id, deviceId: 'unit-a' });
  check('換專案同一台 → 也要重新指派', sameDeviceElsewhere.label === '' && sameDeviceElsewhere.id !== devA.id);
  check('今天的設備清單不含次日紀錄', store.listDevices(p.id).rows.every((d) => d.dateKey === store.todayKey()));

  // ── 標註（箭頭/文字/螢光筆）以向量存下來 ──────────────
  console.log('\n圖片標註');
  const annotated = store.updatePhoto(confirmedNew.id, {
    annotations: [
      { type: 'arrow', color: '#e0332a', size: 0.007, from: { x: 10, y: 10 }, to: { x: 90, y: 90 } },
      { type: 'text', color: '#2563eb', size: 0.007, at: { x: 20, y: 20 }, text: '這裡有刮傷' },
      { type: 'marker', color: '#f5c518', size: 0.007, points: [{ x: 1, y: 1 }, { x: 5, y: 5 }] },
    ],
  });
  check('標註三種型別都存得下來', annotated.annotations.length === 3 && annotated.annotations[1].text === '這裡有刮傷');
  check('標註可以被清掉（還原成原圖時）', store.updatePhoto(confirmedNew.id, { annotations: null }).annotations === null);

  // ── CSV 清單 ───────────────────────────────────────────
  console.log('\n清單 CSV');
  const csv = await req('GET', `/api/projects/${project.id}/manifest.csv`);
  check('CSV 有標頭與資料列', typeof csv.data === 'string' && csv.data.includes('名稱') && csv.data.includes('第一次命名'), String(csv.data).slice(0, 80));

  // ── SSE 即時同步 ───────────────────────────────────────
  console.log('\nSSE 即時同步');
  const sseOk = await testSse(project);
  check('手機上傳後電腦端收到 photo:created 事件', sseOk, '沒有在 5 秒內收到事件');

  // ── 路徑穿越 / 未知路由 ────────────────────────────────
  console.log('\n資安雜項');
  const traversal = await fetch(`${BASE}/assets/../../package.json`);
  check('靜態資源路徑穿越被擋', traversal.status === 403 || traversal.status === 404, `得到 ${traversal.status}`);
  const unknown = await req('GET', '/api/does-not-exist');
  check('未知路由回 404 統一錯誤格式', unknown.status === 404 && unknown.data.error?.code === 'E_NOT_FOUND');
  const wrongMethod = await req('DELETE', '/api/projects');
  check('錯誤方法回 405', wrongMethod.status === 405, `得到 ${wrongMethod.status}`);
  const noIndex = await fetch(`${BASE}/`);
  check('管理頁標 noindex（不給搜尋引擎索引）', (noIndex.headers.get('x-robots-tag') ?? '').includes('noindex'));

  // ── R11 速率限制（放最後，會吃掉配額）──────────────────
  console.log('\nR11 速率限制');
  await req('POST', '/api/settings', { json: { writeRatePerMinute: 10 } });
  let got429 = false;
  for (let i = 0; i < 14; i++) {
    const res = await req('POST', '/api/users', { json: { name: `壓測${i}` } });
    if (res.status === 429) {
      got429 = true;
      break;
    }
  }
  check('連續寫入超過上限 → 429', got429);

  console.log(`\n${'─'.repeat(52)}\n通過 ${passed}　失敗 ${failed}`);
  if (failures.length) {
    console.log('\n未通過項目：');
    failures.forEach((f) => console.log(`  · ${f}`));
  }
}

/** 開 SSE 連線 → 用手機 API 上傳一張 → 應該收到 photo:created */
async function testSse(project) {
  const controller = new AbortController();
  const res = await fetch(`${BASE}/api/events?projectId=${project.id}`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const waitEvent = (async () => {
    const deadline = Date.now() + 5000;
    let buffer = '';
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes('event: photo:created')) return true;
    }
    return false;
  })();

  await new Promise((r) => setTimeout(r, 200));
  const rec = await req('POST', `/api/m/${project.token}/photos`, { json: { uploaderName: 'SSE 測試' } });
  await req('PUT', `/api/m/${project.token}/photos/${rec.data.photoId}/blob?kind=image`, { body: JPEG });

  const result = await Promise.race([waitEvent, new Promise((r) => setTimeout(() => r(false), 5500))]);
  controller.abort();
  return result;
}

try {
  await main();
} catch (err) {
  failed++;
  console.error('\n測試中斷：', err.stack ?? err.message);
} finally {
  child.kill();
  await fsp.rm(DATA, { recursive: true, force: true }).catch(() => {});
  process.exit(failed ? 1 : 0);
}
