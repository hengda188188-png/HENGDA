/**
 * 資安共用件（對應 docs/知識庫/網站資安防護標準.md）：
 * - token 產生與定時比較
 * - 圖片型別判定：magic bytes 為準，不信任 Content-Type / 副檔名
 * - 使用者文字清洗（存 DB 前限制長度、去控制字元；輸出端一律由前端 textContent 編碼）
 */
import crypto from 'node:crypto';
import { ALLOWED_IMAGE_TYPES } from '../config.mjs';

/** 控制字元（保留 \t \n \r，其餘剔除） */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]', 'g');

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const newToken = () => crypto.randomBytes(16).toString('hex');

/** 定時比較，避免 token 被時間側通道逐字元猜出 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 依 magic bytes 判定圖片型別；判不出來回 null（呼叫端應拒收） */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  for (const type of ALLOWED_IMAGE_TYPES) {
    if (type.magic) {
      for (const sig of type.magic) {
        if (sig.every((byte, i) => buf[i] === byte)) {
          if (type.riffType && buf.slice(8, 12).toString('latin1') !== type.riffType) continue;
          return { mime: type.mime, ext: type.ext };
        }
      }
    }
    if (type.ftyp && buf.slice(4, 8).toString('latin1') === 'ftyp') {
      const brand = buf.slice(8, 12).toString('latin1');
      if (type.ftyp.includes(brand)) return { mime: type.mime, ext: type.ext };
    }
  }
  return null;
}

/** 清洗使用者輸入文字：去除控制字元、trim、限制長度 */
export function cleanText(value, maxLen = 200) {
  if (value === undefined || value === null) return '';
  return String(value).replace(CONTROL_CHARS, '').trim().slice(0, maxLen);
}

/** 給雲端/下載用的安全檔名（保留中文，剔除路徑與危險字元） */
export function safeFileName(name, fallback = 'photo') {
  const cleaned = cleanText(name, 120)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
