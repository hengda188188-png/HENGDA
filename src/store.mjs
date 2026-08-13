/**
 * 資料層：JSON 落地 + 原子寫入 + 樂觀鎖 + 分頁查詢。
 * 單行程單檔，寫入序列化（佇列），避免兩支手機同時上傳互蓋（邊界情境「兩台手機同時傳」）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DB_FILE, PROJECTS_DIR, settings } from './config.mjs';
import { newId, newToken, cleanText } from './lib/security.mjs';
import { conflict, notFound, badRequest, HttpError } from './lib/http.mjs';
import { removeQuiet } from './lib/blob.mjs';
import { log } from './lib/log.mjs';

const EMPTY_DB = { schemaVersion: 2, users: [], projects: [], photos: [], devices: [] };

let db = structuredClone(EMPTY_DB);
let writeQueue = Promise.resolve();
let dirty = false;

export function init() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      db = { ...structuredClone(EMPTY_DB), ...parsed };
      // 啟動備份（韌性：改壞了還救得回來）
      fs.copyFileSync(DB_FILE, path.join(DATA_DIR, 'db.backup.json'));
    } catch (err) {
      log.error('db.json 損毀，改用空資料庫（舊檔保留為 db.corrupt.json）', err.message);
      try {
        fs.renameSync(DB_FILE, path.join(DATA_DIR, 'db.corrupt.json'));
      } catch {}
      db = structuredClone(EMPTY_DB);
    }
  }
  log.info(`資料載入：${db.projects.length} 個專案 / ${db.photos.length} 張照片`);
}

/** 原子寫入：先寫 .tmp 再 rename，避免斷電留半截檔 */
function persist() {
  dirty = true;
  writeQueue = writeQueue.then(async () => {
    if (!dirty) return;
    dirty = false;
    const tmp = DB_FILE + '.tmp';
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fsp.rename(tmp, DB_FILE);
  }).catch((err) => log.error('資料寫入失敗', err.message));
  return writeQueue;
}

export const flush = () => writeQueue;

// ── 使用者（輕量身分：只有名字，無密碼）────────────────────────
export function listUsers() {
  return db.users.map((u) => ({ ...u, projectCount: db.projects.filter((p) => p.ownerUserId === u.id).length }));
}

export function ensureUser(name) {
  const clean = cleanText(name, 40);
  if (!clean) throw badRequest('使用者名稱不可空白');
  const existing = db.users.find((u) => u.name === clean);
  if (existing) return existing;
  const user = { id: newId('u'), name: clean, createdAt: new Date().toISOString() };
  db.users.push(user);
  persist();
  return user;
}

// ── 設備（取代「手打使用者名稱」）───────────────────────
// 綁定三件事：專案 + 日期 + 裝置識別碼。
// 為什麼綁日期：董事長要求「只針對當天該專案」，次日或換專案都要重新指派歸屬，
// 所以每天第一次上傳會長出一筆新的 device 紀錄（label 空白，等電腦端命名）。

/** 伺服器本地日期（YYYY-MM-DD），照片與設備的歸屬都用它 */
export function todayKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 由裝置識別碼導出好念的 4 碼短碼（去掉容易看錯的 0/O/1/I） */
const SHORT_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function shortCodeOf(deviceKey) {
  let hash = 0x811c9dc5;
  for (const ch of String(deviceKey)) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += SHORT_ALPHABET[hash % SHORT_ALPHABET.length];
    hash = Math.floor(hash / SHORT_ALPHABET.length) + 7;
  }
  return code;
}

/** 從 UA 猜個好懂的機型描述（猜不到就回原始 UA 片段，不編造） */
function describeDevice(info = {}) {
  const ua = String(info.ua ?? '');
  const rules = [
    [/iPhone/i, 'iPhone'],
    [/iPad/i, 'iPad'],
    [/Android[^;)]*;\s*([^;)]+)\s*\)/i, null],
    [/Windows NT/i, 'Windows 電腦'],
    [/Macintosh/i, 'Mac'],
  ];
  for (const [pattern, label] of rules) {
    const match = ua.match(pattern);
    if (!match) continue;
    if (label) return label;
    return cleanText(match[1], 40) || 'Android';
  }
  return cleanText(ua.slice(0, 40), 40) || '未知裝置';
}

/**
 * 手機端報到：同一天同一專案同一裝置只會有一筆。
 * @param {{projectId:string, deviceId:string, info:object}} params
 */
export function ensureDevice({ projectId, deviceId, info = {}, dateKey = todayKey() }) {
  const project = requireProject(projectId);
  const rawId = cleanText(deviceId, 64);
  if (!rawId) throw badRequest('缺少裝置識別碼');

  let device = db.devices.find((d) => d.projectId === project.id && d.dateKey === dateKey && d.deviceKey === rawId);
  if (!device) {
    device = {
      id: newId('dev'),
      projectId: project.id,
      dateKey,
      deviceKey: rawId,
      shortCode: shortCodeOf(`${project.id}|${dateKey}|${rawId}`),
      label: '',
      model: describeDevice(info),
      info: {
        ua: cleanText(info.ua, 200),
        platform: cleanText(info.platform, 40),
        screen: cleanText(info.screen, 20),
        lang: cleanText(info.lang, 20),
        tz: cleanText(info.tz, 40),
      },
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      version: 1,
    };
    db.devices.push(device);
    touchProject(project.id);
    log.info(`新設備報到：${device.shortCode}（${device.model}）專案 ${project.name} / ${dateKey}`);
  } else {
    device.lastSeenAt = new Date().toISOString();
  }
  persist();
  return device;
}

export const getDevice = (id) => db.devices.find((d) => d.id === id) ?? null;

export function requireDevice(id) {
  const device = getDevice(id);
  if (!device) throw notFound('設備紀錄不存在');
  return device;
}

/** 電腦端指派歸屬名稱（只影響這個專案的這一天） */
export function labelDevice(id, label, expectedVersion) {
  const device = requireDevice(id);
  bumpVersion(device, expectedVersion, '設備');
  device.label = cleanText(label, 40);
  touchProject(device.projectId);
  persist();
  return device;
}

/** 顯示用名稱：指派過就用指派的，沒指派就用短碼 */
export const deviceDisplayName = (device) => (device?.label ? device.label : device ? `#${device.shortCode}` : '—');

/** 專案的設備清單（預設只看今天，符合「只針對當天」） */
export function listDevices(projectId, { date = 'today' } = {}) {
  requireProject(projectId);
  const dateKey = date === 'today' ? todayKey() : date;
  const rows = db.devices
    .filter((d) => d.projectId === projectId && (date === 'all' || d.dateKey === dateKey))
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.firstSeenAt.localeCompare(b.firstSeenAt));

  return {
    dateKey: date === 'all' ? 'all' : dateKey,
    today: todayKey(),
    rows: rows.map((d) => ({
      ...d,
      displayName: deviceDisplayName(d),
      photoCount: db.photos.filter((p) => p.deviceId === d.id).length,
    })),
  };
}

/**
 * 雲端版本是不是舊的：已經傳上去之後又編輯過，雲端那份就過期了。
 * 沒有這個判斷的話，使用者改了圖卻以為雲端也跟著更新——這種錯最難發現。
 */
export function isCloudStale(photo) {
  if (!photo.drive?.fileId) return false;
  const editedAt = photo.edited?.at;
  const uploadedAt = photo.drive?.at;
  if (!editedAt || !uploadedAt) return false;
  return editedAt > uploadedAt;
}

/** 對外的照片視圖：把設備資訊接上去（前端不必自己查表） */
export function decoratePhoto(photo) {
  const device = photo.deviceId ? getDevice(photo.deviceId) : null;
  return {
    ...photo,
    cloudStale: isCloudStale(photo),
    device: device
      ? {
          id: device.id,
          shortCode: device.shortCode,
          label: device.label,
          displayName: deviceDisplayName(device),
          model: device.model,
          dateKey: device.dateKey,
        }
      : null,
    uploaderName: deviceDisplayName(device),
  };
}

// ── 專案 ───────────────────────────────────────────────────────
export function createProject({ name, note = '', ownerName = '' }) {
  const clean = cleanText(name, 60);
  if (!clean) throw badRequest('專案名稱不可空白');
  const owner = ownerName ? ensureUser(ownerName) : null;
  const project = {
    id: newId('p'),
    name: clean,
    note: cleanText(note, 500),
    ownerUserId: owner?.id ?? null,
    ownerName: owner?.name ?? '',
    token: newToken(),
    status: 'active',
    driveFolderId: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  db.projects.push(project);
  persist();
  return project;
}

/** 專案「最近活動」時間戳——多專案並行時，側欄靠這個排序，不然找不到現在該傳去哪個 */
function touchProject(id) {
  const project = getProject(id);
  if (project) project.updatedAt = new Date().toISOString();
}

export const getProject = (id) => db.projects.find((p) => p.id === id) ?? null;
export const getProjectByToken = (token) => db.projects.find((p) => p.token === token) ?? null;

export function requireProject(id) {
  const project = getProject(id);
  if (!project) throw notFound('專案不存在');
  return project;
}

/** 樂觀鎖：version 不符回 409 並附現值（規則 R6） */
function bumpVersion(entity, expectedVersion, label) {
  if (expectedVersion !== undefined && expectedVersion !== null && Number(expectedVersion) !== entity.version) {
    throw conflict(`${label}已被其他裝置修改，請重新整理後再試`, { currentVersion: entity.version, current: entity });
  }
  entity.version += 1;
}

export function updateProject(id, patch, expectedVersion) {
  const project = requireProject(id);
  bumpVersion(project, expectedVersion, '專案');
  if (patch.name !== undefined) {
    const clean = cleanText(patch.name, 60);
    if (!clean) throw badRequest('專案名稱不可空白');
    project.name = clean;
  }
  if (patch.note !== undefined) project.note = cleanText(patch.note, 500);
  if (patch.status !== undefined) {
    if (!['active', 'archived'].includes(patch.status)) throw badRequest('狀態只能是 active 或 archived');
    project.status = patch.status;
  }
  if (patch.driveFolderId !== undefined) project.driveFolderId = cleanText(patch.driveFolderId, 100);
  touchProject(id);
  persist();
  return project;
}

export function regenerateToken(id) {
  const project = requireProject(id);
  project.token = newToken();
  project.version += 1;
  persist();
  return project;
}

/** 專案清單：搜尋 + 篩選 + 分頁（規則：>50 筆必分頁三件套） */
export function listProjects({ q = '', status = 'active', page = 1, pageSize } = {}) {
  const size = clampPageSize(pageSize);
  const keyword = cleanText(q, 60).toLowerCase();
  let rows = db.projects;
  if (status && status !== 'all') rows = rows.filter((p) => p.status === status);
  if (keyword) {
    rows = rows.filter((p) => `${p.name} ${p.note} ${p.ownerName}`.toLowerCase().includes(keyword));
  }
  // 依「最近活動」排序（多專案並行時，最新有人在動的排最前面）；舊資料沒有 updatedAt 就退回建立時間
  rows = [...rows].sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const total = rows.length;
  const start = (Math.max(1, page) - 1) * size;
  return {
    total,
    page: Math.max(1, page),
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    rows: rows.slice(start, start + size).map(withPhotoStats),
  };
}

function withPhotoStats(project) {
  const photos = db.photos.filter((ph) => ph.projectId === project.id);
  return {
    ...project,
    photoCount: photos.length,
    confirmedCount: photos.filter((p) => p.status === 'confirmed').length,
    uploadedCount: photos.filter((p) => p.drive?.fileId).length,
  };
}

export const projectSummary = withPhotoStats;

function clampPageSize(pageSize) {
  const fallback = settings().pageSize;
  const size = Number(pageSize);
  if (!Number.isFinite(size)) return fallback;
  return Math.min(200, Math.max(6, Math.floor(size)));
}

// ── 照片 ───────────────────────────────────────────────────────
export const photoDir = (projectId, kind) => path.join(PROJECTS_DIR, projectId, kind);

export function countPhotos(projectId) {
  return db.photos.filter((p) => p.projectId === projectId).length;
}

export function createPhoto({ projectId, deviceId, originalFileName, width, height, note = '' }) {
  const project = requireProject(projectId);
  if (countPhotos(projectId) >= settings().maxPhotosPerProject) {
    throw new HttpError(400, 'E_LIMIT', `單一專案最多 ${settings().maxPhotosPerProject} 張照片`);
  }
  const device = deviceId ? requireDevice(deviceId) : null;
  if (device && device.projectId !== project.id) throw badRequest('這台設備不屬於本專案');
  const photo = {
    id: newId('ph'),
    projectId: project.id,
    deviceId: device?.id ?? '',
    dateKey: device?.dateKey ?? todayKey(),
    originalFileName: cleanText(originalFileName, 160),
    name: '',
    // 手機端可選填一句備註（拍照當下最清楚問題是什麼，不用等電腦端事後補），零輸入原則不變：留空就跟以前一樣
    note: cleanText(note, 1000),
    status: 'pending', // pending | confirmed | excluded
    image: null,       // { file, bytes, mime, w, h, sha256 }
    thumb: null,       // { file, bytes }
    edited: null,      // { file, bytes, w, h, sha256 }
    crop: null,
    annotations: null,
    drive: null,       // { fileId, link, name, at } | { error }
    createdAt: new Date().toISOString(),
    version: 1,
  };
  if (Number.isFinite(Number(width))) photo.declaredWidth = Number(width);
  if (Number.isFinite(Number(height))) photo.declaredHeight = Number(height);
  db.photos.push(photo);
  touchProject(project.id);
  persist();
  return photo;
}

/**
 * 從既有照片衍生一張新的（編輯後選「另存新照片」時用）。
 * 沿用來源的設備歸屬與日期，這樣新舊兩張在清單裡仍然屬於同一個人、同一天。
 */
export function derivePhoto(sourceId, { nameSuffix = '' } = {}) {
  const source = requirePhoto(sourceId);
  if (countPhotos(source.projectId) >= settings().maxPhotosPerProject) {
    throw new HttpError(400, 'E_LIMIT', `單一專案最多 ${settings().maxPhotosPerProject} 張照片`);
  }
  const photo = {
    ...structuredClone(source),
    id: newId('ph'),
    name: source.name ? `${source.name}${nameSuffix}` : '',
    image: null,
    thumb: null,
    edited: null,
    crop: null,
    annotations: null,
    drive: null,          // 新的一張還沒上過雲端
    derivedFrom: source.id,
    createdAt: new Date().toISOString(),
    version: 1,
  };
  db.photos.push(photo);
  touchProject(photo.projectId);
  persist();
  return photo;
}

export const getPhoto = (id) => db.photos.find((p) => p.id === id) ?? null;

export function requirePhoto(id) {
  const photo = getPhoto(id);
  if (!photo) throw notFound('照片不存在');
  return photo;
}

export function setPhotoBlob(id, kind, info) {
  const photo = requirePhoto(id);
  if (kind === 'image') photo.image = info;
  else if (kind === 'thumb') photo.thumb = info;
  else if (kind === 'edited') photo.edited = info;
  else throw badRequest('未知的檔案類型');
  photo.version += 1;
  touchProject(photo.projectId);
  persist();
  return photo;
}

export function updatePhoto(id, patch, expectedVersion) {
  const photo = requirePhoto(id);
  bumpVersion(photo, expectedVersion, '照片');
  if (patch.name !== undefined) photo.name = cleanText(patch.name, 120);
  if (patch.note !== undefined) photo.note = cleanText(patch.note, 1000);
  if (patch.status !== undefined) {
    if (!['pending', 'confirmed', 'excluded'].includes(patch.status)) throw badRequest('狀態不合法');
    photo.status = patch.status;
  }
  if (patch.crop !== undefined) photo.crop = patch.crop;
  // 標註（箭頭/文字/螢光筆）以向量形式存下來，之後才能再編輯，不是只有燒進圖片
  if (patch.annotations !== undefined) photo.annotations = Array.isArray(patch.annotations) ? patch.annotations.slice(0, 200) : null;
  touchProject(photo.projectId);
  persist();
  return photo;
}

export function setPhotoDrive(id, drive) {
  const photo = requirePhoto(id);
  photo.drive = drive;
  photo.version += 1;
  touchProject(photo.projectId);
  persist();
  return photo;
}

export async function deletePhoto(id) {
  const photo = requirePhoto(id);
  const index = db.photos.indexOf(photo);
  db.photos.splice(index, 1);
  touchProject(photo.projectId);
  persist();
  await Promise.all([
    removeQuiet(photo.image && path.join(photoDir(photo.projectId, 'original'), photo.image.file)),
    removeQuiet(photo.thumb && path.join(photoDir(photo.projectId, 'thumb'), photo.thumb.file)),
    removeQuiet(photo.edited && path.join(photoDir(photo.projectId, 'edited'), photo.edited.file)),
  ]);
  return photo;
}

/**
 * 照片清單：快搜尋 + 篩選（狀態／設備／雲端）+ 排序（時間／設備分組）+ 分頁。
 * 各種計數都一次算好回前端，篩選列的數字才不會跟畫面對不上。
 */
export function listPhotos(projectId, { q = '', status = 'all', device = 'all', drive = 'all', sort = 'time', page = 1, pageSize } = {}) {
  requireProject(projectId);
  const size = clampPageSize(pageSize);
  const keyword = cleanText(q, 60).toLowerCase();

  const inProject = db.photos.filter((p) => p.projectId === projectId).map(decoratePhoto);
  const matchKeyword = (p) =>
    !keyword ||
    `${p.name} ${p.note} ${p.originalFileName} ${p.uploaderName} ${p.device?.shortCode ?? ''} ${p.device?.model ?? ''}`
      .toLowerCase()
      .includes(keyword);

  // 搜尋是所有計數的共同前提；狀態計數不受「狀態篩選」影響，設備計數不受「設備篩選」影響
  const searched = inProject.filter(matchKeyword);
  const stats = {
    all: searched.length,
    pending: searched.filter((p) => p.status === 'pending').length,
    confirmed: searched.filter((p) => p.status === 'confirmed').length,
    excluded: searched.filter((p) => p.status === 'excluded').length,
    uploaded: searched.filter((p) => p.drive?.fileId).length,
    projectTotal: inProject.length,
  };

  const byStatus = searched.filter((p) => (status === 'all' ? true : p.status === status));
  const byDrive = byStatus.filter((p) =>
    drive === 'uploaded' ? Boolean(p.drive?.fileId) : drive === 'pending' ? !p.drive?.fileId : true
  );

  const deviceIds = [...new Set(inProject.map((p) => p.deviceId).filter(Boolean))];
  const deviceStats = deviceIds
    .map((id) => {
      const record = getDevice(id);
      const mine = byDrive.filter((p) => p.deviceId === id);
      return {
        id,
        shortCode: record?.shortCode ?? '????',
        label: record?.label ?? '',
        displayName: deviceDisplayName(record),
        model: record?.model ?? '',
        dateKey: record?.dateKey ?? '',
        total: mine.length,
        confirmed: mine.filter((p) => p.status === 'confirmed').length,
        uploaded: mine.filter((p) => p.drive?.fileId).length,
        projectTotal: inProject.filter((p) => p.deviceId === id).length,
      };
    })
    .sort((a, b) => b.dateKey.localeCompare(a.dateKey) || a.displayName.localeCompare(b.displayName, 'zh-Hant'));

  let rows = byDrive.filter((p) => (device === 'all' ? true : p.deviceId === device));
  rows = [...rows].sort((a, b) =>
    sort === 'device'
      ? a.uploaderName.localeCompare(b.uploaderName, 'zh-Hant') || a.createdAt.localeCompare(b.createdAt)
      : a.createdAt.localeCompare(b.createdAt)
  );

  const total = rows.length;
  const start = (Math.max(1, page) - 1) * size;
  return {
    total,
    stats,
    deviceStats,
    sort,
    page: Math.max(1, page),
    pageSize: size,
    pageCount: Math.max(1, Math.ceil(total / size)),
    rows: rows.slice(start, start + size),
  };
}

/**
 * 給雲端上傳用：該專案「已確認」而且需要傳的照片（規則 R7/R8）。
 * 需要傳＝還沒傳過，**或是傳過之後又編輯了**（雲端那份已經是舊的，要覆蓋上去）。
 */
export function photosForUpload(projectId, { includeUploaded = false, ids = null } = {}) {
  const picked = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  return db.photos
    .filter((p) => p.projectId === projectId)
    // 指定張數時就是「使用者自己挑的」，不再要求一定要標成已確認
    .filter((p) => (picked ? picked.has(p.id) : p.status === 'confirmed'))
    .filter((p) => includeUploaded || !p.drive?.fileId || isCloudStale(p))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export const allPhotosOfProject = (projectId) =>
  db.photos
    .filter((p) => p.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(decoratePhoto);

/** 測試用：清空記憶體資料（不動磁碟） */
export function _resetForTest() {
  db = structuredClone(EMPTY_DB);
}
