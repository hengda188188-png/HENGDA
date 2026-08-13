/**
 * 工作台存取密碼（多人共用區網時用）。
 *
 * 設計取捨：
 * - **預設關閉**。沒設密碼就跟以前一樣，誰都能開——適合家裡自己一台。
 * - 設了密碼之後，**電腦端工作台與管理 API 都要通過**；**手機上傳頁不受影響**
 *   （手機是掃 QR 進來的，本來就有專案 token 當授權，再要密碼會讓現場的人傳不了圖）。
 * - Cookie 用 HMAC 簽章而不是在記憶體存 session，**重啟後大家不會被踢出來**（這正是多人共用最怕的）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { SECRETS_FILE, DATA_DIR } from '../config.mjs';
import { HttpError } from './http.mjs';
import { log } from './log.mjs';

export const COOKIE_NAME = 'photo_relay_console';
const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 32;

function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeSecrets(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** 簽 cookie 用的伺服器密鑰，第一次用到才產生，之後跟著檔案走（重啟不失效） */
function serverSecret() {
  const s = readSecrets();
  if (s.consoleSecret) return s.consoleSecret;
  const secret = crypto.randomBytes(32).toString('hex');
  writeSecrets({ ...s, consoleSecret: secret });
  return secret;
}

export function isEnabled() {
  const s = readSecrets();
  return Boolean(s.consolePassword?.hash && s.consolePassword?.salt);
}

export function authStatus() {
  return { enabled: isEnabled() };
}

const hashWith = (password, salt) =>
  crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');

/** 設定或更換密碼。已經有密碼時，必須先給對舊密碼才能改（防別人趁你離開改掉） */
export function setPassword({ password, currentPassword }) {
  const value = String(password ?? '');
  if (value.length < 4) throw new HttpError(400, 'E_VALIDATION', '密碼至少要 4 個字');
  if (value.length > 128) throw new HttpError(400, 'E_VALIDATION', '密碼太長');

  if (isEnabled() && !verifyPassword(currentPassword)) {
    throw new HttpError(400, 'E_BAD_PASSWORD', '目前的密碼不正確');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  writeSecrets({ ...readSecrets(), consolePassword: { salt, hash: hashWith(value, salt) } });
  log.info('已設定工作台存取密碼');
  return authStatus();
}

/** 取消密碼保護（要先驗證目前密碼） */
export function removePassword(currentPassword) {
  if (!isEnabled()) return authStatus();
  if (!verifyPassword(currentPassword)) throw new HttpError(400, 'E_BAD_PASSWORD', '目前的密碼不正確');
  const s = readSecrets();
  delete s.consolePassword;
  writeSecrets(s);
  log.info('已取消工作台存取密碼');
  return authStatus();
}

export function verifyPassword(password) {
  const stored = readSecrets().consolePassword;
  if (!stored?.hash || !stored?.salt) return false;
  const candidate = Buffer.from(hashWith(String(password ?? ''), stored.salt), 'hex');
  const expected = Buffer.from(stored.hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/** 產生 cookie 值：到期時間 + HMAC 簽章（無狀態，重啟仍有效） */
export function issueCookie() {
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = String(expires);
  const signature = crypto.createHmac('sha256', serverSecret()).update(payload).digest('hex');
  const value = `${payload}.${signature}`;
  return {
    value,
    header: `${COOKIE_NAME}=${value}; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; HttpOnly; SameSite=Lax`,
  };
}

export const clearCookieHeader = () => `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;

function parseCookies(header = '') {
  const jar = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return jar;
}

export function hasValidCookie(req) {
  const raw = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  if (!raw) return false;
  const [payload, signature] = raw.split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', serverSecret()).update(payload).digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

/** 改密碼後把所有人踢掉（換掉簽章密鑰即可，不必記錄誰登入過） */
export function revokeAllSessions() {
  writeSecrets({ ...readSecrets(), consoleSecret: crypto.randomBytes(32).toString('hex') });
}

/**
 * 不需要密碼也能走的路徑。
 * 手機上傳整條鏈都放行——現場的人只掃 QR，不該被密碼擋住。
 */
const OPEN_PREFIXES = ['/m/', '/api/m/', '/assets/', '/login', '/api/auth/', '/favicon', '/healthz'];

export const isOpenPath = (pathname) => OPEN_PREFIXES.some((prefix) => pathname.startsWith(prefix));
