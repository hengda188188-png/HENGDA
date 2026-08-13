/** 工作台密碼：登入頁、登入／登出、設定與取消密碼。 */
import { sendJson, readJsonBody, sendFile, HttpError, clientIp } from '../lib/http.mjs';
import { WEB_DIR } from '../config.mjs';
import * as auth from '../lib/console-auth.mjs';
import { log } from '../lib/log.mjs';

/** 密碼猜測防護：同 IP 連續失敗就鎖一下（比單純速率限制更針對性） */
const failures = new Map();
const LOCK_AFTER = 8;
const LOCK_MS = 5 * 60_000;

function guard(ip) {
  const record = failures.get(ip);
  if (record && record.count >= LOCK_AFTER && Date.now() < record.until) {
    const seconds = Math.ceil((record.until - Date.now()) / 1000);
    throw new HttpError(429, 'E_LOCKED', `密碼錯太多次，請 ${seconds} 秒後再試`);
  }
}

function noteFailure(ip) {
  const record = failures.get(ip) ?? { count: 0, until: 0 };
  record.count += 1;
  record.until = Date.now() + LOCK_MS;
  failures.set(ip, record);
}

export async function loginPage({ res }) {
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  await sendFile(res, WEB_DIR, 'login.html');
}

export async function getAuthStatus({ req, res }) {
  sendJson(res, 200, { ...auth.authStatus(), signedIn: !auth.isEnabled() || auth.hasValidCookie(req) });
}

export async function postLogin({ req, res }) {
  const ip = clientIp(req);
  guard(ip);
  const body = await readJsonBody(req);
  if (!auth.isEnabled()) {
    sendJson(res, 200, { ok: true, enabled: false });
    return;
  }
  if (!auth.verifyPassword(body.password)) {
    noteFailure(ip);
    log.warn('工作台密碼輸入錯誤', ip);
    throw new HttpError(401, 'E_BAD_PASSWORD', '密碼不正確');
  }
  failures.delete(ip);
  res.setHeader('set-cookie', auth.issueCookie().header);
  sendJson(res, 200, { ok: true });
}

export async function postLogout({ res }) {
  res.setHeader('set-cookie', auth.clearCookieHeader());
  sendJson(res, 200, { ok: true });
}

export async function postSetPassword({ req, res }) {
  // /api/auth/* 是開放路徑（登入頁要用），所以這裡自己補一道：已啟用密碼時，
  // 只有「已登入」或「拿得出目前密碼」的人可以改，否則路過的人就能把密碼換掉。
  if (auth.isEnabled() && !auth.hasValidCookie(req)) {
    const peek = await readJsonBody(req);
    if (!auth.verifyPassword(peek.currentPassword)) {
      throw new HttpError(401, 'E_NEED_LOGIN', '請先登入或提供目前的密碼');
    }
    const status = auth.setPassword({ password: peek.password, currentPassword: peek.currentPassword });
    auth.revokeAllSessions();
    res.setHeader('set-cookie', auth.issueCookie().header);
    sendJson(res, 200, status);
    return;
  }
  const body = await readJsonBody(req);
  const status = auth.setPassword({ password: body.password, currentPassword: body.currentPassword });
  auth.revokeAllSessions(); // 改完密碼，其他裝置一律重新輸入
  res.setHeader('set-cookie', auth.issueCookie().header); // 但設定的人自己不用被踢
  sendJson(res, 200, status);
}

export async function postRemovePassword({ req, res }) {
  const body = await readJsonBody(req);
  const status = auth.removePassword(body.currentPassword);
  res.setHeader('set-cookie', auth.clearCookieHeader());
  sendJson(res, 200, status);
}
