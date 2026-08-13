/**
 * 設定單一來源：預設值 + data/settings.json 覆寫 + 環境變數覆寫。
 * 規範「禁寫死」：所有數量/尺寸/品質限制都走這裡，程式碼不得再寫魔術數字。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 測試一律用 PHOTO_RELAY_DATA 指到暫存資料夾，避免污染正式資料（price-db 教訓） */
export const DATA_DIR = process.env.PHOTO_RELAY_DATA
  ? path.resolve(process.env.PHOTO_RELAY_DATA)
  : path.join(ROOT, 'data');
export const WEB_DIR = path.join(ROOT, 'web');
export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const DB_FILE = path.join(DATA_DIR, 'db.json');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

/** 這些預設值可在設定頁改，改完寫回 data/settings.json */
export const DEFAULT_SETTINGS = {
  port: 4901,
  maxEdgePx: 2560,          // 手機端標準化後最大邊長
  jpegQuality: 0.92,        // 標準化 JPEG 品質
  thumbEdgePx: 512,         // 縮圖邊長
  maxFileBytes: 25 * 1024 * 1024,
  maxFilesPerRequest: 12,
  maxPhotosPerProject: 2000,
  keepOriginalFile: false,  // true = 連未標準化的原檔一起留
  pageSize: 24,             // 縮圖牆每頁張數
  writeRatePerMinute: 120,  // 同 IP 每分鐘寫入請求上限
  driveRootFolderName: 'PhotoRelay 上傳',
  driveTargetFolderId: '',  // 空 = 用 app 自建根資料夾
  uploadCsvManifest: true,  // 每個專案上傳一份 清單.csv
};

/** 允許的圖片型別：副檔名 + magic bytes 雙重判定用 */
export const ALLOWED_IMAGE_TYPES = [
  { mime: 'image/jpeg', ext: '.jpg', magic: [[0xff, 0xd8, 0xff]] },
  { mime: 'image/png', ext: '.png', magic: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]] },
  { mime: 'image/webp', ext: '.webp', magic: [[0x52, 0x49, 0x46, 0x46]], riffType: 'WEBP' },
  { mime: 'image/heic', ext: '.heic', ftyp: ['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'] },
  { mime: 'image/heif', ext: '.heif', ftyp: ['heif', 'mif1'] },
];

let cache = null;

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 讀取有效設定（含使用者覆寫）。改設定後呼叫 invalidate() 讓下次讀取重載。 */
export function settings() {
  if (cache) return cache;
  const stored = readJsonSafe(SETTINGS_FILE) ?? {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (process.env.PHOTO_RELAY_PORT) merged.port = Number(process.env.PHOTO_RELAY_PORT);
  cache = Object.freeze(merged);
  return cache;
}

export function invalidateSettings() {
  cache = null;
}

/** 只接受白名單內的設定鍵，型別與範圍都驗；回傳實際寫入的值 */
export function saveSettings(patch) {
  const current = { ...settings() };
  const limits = {
    port: [1024, 65535],
    maxEdgePx: [640, 8000],
    jpegQuality: [0.5, 1],
    thumbEdgePx: [128, 1024],
    maxFileBytes: [1024 * 100, 200 * 1024 * 1024],
    maxFilesPerRequest: [1, 50],
    maxPhotosPerProject: [1, 20000],
    pageSize: [6, 200],
    writeRatePerMinute: [10, 6000],
  };
  const next = { ...current };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!(key in DEFAULT_SETTINGS)) continue; // 白名單：未知鍵直接忽略
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === 'boolean') {
      next[key] = Boolean(value);
    } else if (typeof def === 'number') {
      const num = Number(value);
      if (!Number.isFinite(num)) throw Object.assign(new Error(`設定 ${key} 必須是數字`), { code: 'E_VALIDATION' });
      const [min, max] = limits[key] ?? [-Infinity, Infinity];
      if (num < min || num > max) {
        throw Object.assign(new Error(`設定 ${key} 必須介於 ${min} ~ ${max}`), { code: 'E_VALIDATION' });
      }
      next[key] = num;
    } else {
      next[key] = String(value ?? '').slice(0, 200);
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  invalidateSettings();
  return settings();
}
