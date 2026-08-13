/**
 * Google 雲端硬碟（零依賴，只用內建 fetch）。
 * 權限最小化：scope 僅 drive.file —— 只碰本工具自己建立的檔案，看不到你雲端其他東西。
 * 密鑰只存本機 data/secrets.json，永不回傳前端（規則 R12）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { SECRETS_FILE, DATA_DIR } from '../config.mjs';
import { HttpError } from './http.mjs';
import { log } from './log.mjs';

/**
 * 兩種憑證模式：
 * - `oauth`（預設）：你本人授權一次，之後永久用 refresh token 自動換發，不會再叫你登入。
 *   scope 只要 drive.file —— 本工具只碰自己建立的檔案。
 * - `service`：服務帳戶金鑰檔，**完全不需要登入**。但服務帳戶自己沒有儲存配額，
 *   只有上傳到「共用雲端硬碟」（Google Workspace）或已分享給它的共用雲端硬碟資料夾才會成功；
 *   個人 Gmail 的「我的雲端硬碟」會被 Google 擋（storageQuotaExceeded），本檔會把這個錯誤翻成白話。
 *   服務帳戶模式用完整 drive scope，因為它本來就只看得到「被分享給它」的東西。
 */
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SERVICE_SCOPE = 'https://www.googleapis.com/auth/drive';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let accessCache = { token: '', expiresAt: 0 };

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

/** 對外狀態：只回是否設定好，絕不吐出密鑰內容 */
export function driveStatus() {
  const s = readSecrets();
  const mode = s.mode === 'service' ? 'service' : 'oauth';
  const service = s.serviceAccount ?? null;
  return {
    mode,
    hasCredentials: mode === 'service' ? Boolean(service?.client_email && service?.private_key) : Boolean(s.clientId && s.clientSecret),
    authorized: mode === 'service' ? Boolean(service?.client_email) : Boolean(s.refreshToken),
    clientIdMasked: s.clientId ? `${s.clientId.slice(0, 12)}…${s.clientId.slice(-12)}` : '',
    account: mode === 'service' ? (service?.client_email ?? '') : (s.account ?? ''),
    serviceAccountEmail: service?.client_email ?? '',
    rootFolderId: s.rootFolderId ?? '',
  };
}

/**
 * 存服務帳戶金鑰檔（Google Cloud → 服務帳戶 → 建立金鑰 → JSON）。
 * 存完就能用，不需要任何登入動作。
 */
export function saveServiceAccount(rawJson) {
  let parsed;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch {
    throw new HttpError(400, 'E_VALIDATION', '這不是合法的 JSON，請整份貼上金鑰檔內容');
  }
  if (parsed.type !== 'service_account' || !parsed.client_email || !parsed.private_key) {
    throw new HttpError(400, 'E_VALIDATION', '這不是服務帳戶金鑰檔（應包含 type: service_account、client_email、private_key）');
  }
  // 先確認私鑰真的能用來簽章，不要等到上傳當下才爆
  try {
    crypto.createPrivateKey(parsed.private_key);
  } catch {
    throw new HttpError(400, 'E_VALIDATION', '金鑰檔裡的 private_key 無法解析，請重新下載金鑰檔');
  }
  writeSecrets({
    ...readSecrets(),
    mode: 'service',
    serviceAccount: {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      project_id: parsed.project_id ?? '',
    },
  });
  accessCache = { token: '', expiresAt: 0 };
  log.info('已改用服務帳戶模式', parsed.client_email);
  return driveStatus();
}

/** 切回 OAuth 模式（保留已存的用戶端 ID／密鑰與 refresh token） */
export function useOAuthMode() {
  const s = readSecrets();
  writeSecrets({ ...s, mode: 'oauth' });
  accessCache = { token: '', expiresAt: 0 };
  return driveStatus();
}

export function removeServiceAccount() {
  const s = readSecrets();
  delete s.serviceAccount;
  writeSecrets({ ...s, mode: 'oauth' });
  accessCache = { token: '', expiresAt: 0 };
  return driveStatus();
}

const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 服務帳戶：自己簽一張 JWT 換 access token（零依賴，用 node:crypto 簽 RS256） */
async function serviceAccessToken() {
  const s = readSecrets();
  const sa = s.serviceAccount;
  if (!sa?.client_email || !sa?.private_key) {
    throw new HttpError(400, 'E_DRIVE_SETUP', '尚未匯入服務帳戶金鑰檔');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: SERVICE_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const signature = base64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), sa.private_key));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new HttpError(400, 'E_DRIVE_AUTH', `服務帳戶取權杖失敗：${data.error_description ?? data.error ?? res.status}`);
  }
  accessCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  return accessCache.token;
}

export function saveCredentials({ clientId, clientSecret }) {
  const id = String(clientId ?? '').trim();
  const secret = String(clientSecret ?? '').trim();
  if (!id.endsWith('.apps.googleusercontent.com')) {
    throw new HttpError(400, 'E_VALIDATION', '用戶端 ID 格式不對，應以 .apps.googleusercontent.com 結尾');
  }
  if (secret.length < 10) throw new HttpError(400, 'E_VALIDATION', '用戶端密鑰看起來不正確');
  const s = readSecrets();
  writeSecrets({ ...s, clientId: id, clientSecret: secret, refreshToken: s.clientId === id ? s.refreshToken : undefined });
  accessCache = { token: '', expiresAt: 0 };
  return driveStatus();
}

/**
 * 直接吃 Google 憑證頁「下載 JSON」的那個檔，省掉手動複製兩個欄位（最容易貼錯的一步）。
 * 順便把「憑證類型選錯」這個最常見的坑當場擋下來，不要等到授權時才噴 redirect_uri_mismatch。
 * @param {string|object} rawJson 下載的 client_secret_xxx.json 內容
 * @param {string} expectedRedirect 本工具實際使用的回導網址
 */
export function saveCredentialsFromJson(rawJson, expectedRedirect) {
  let parsed;
  try {
    parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson;
  } catch {
    throw new HttpError(400, 'E_VALIDATION', '這不是合法的 JSON，請整份貼上或直接選檔');
  }

  if (parsed.type === 'service_account') {
    throw new HttpError(400, 'E_VALIDATION',
      '這是「服務帳戶金鑰檔」，不是 OAuth 用戶端憑證。要用它請把上面的憑證方式切到「服務帳戶金鑰」。');
  }

  const block = parsed.installed ?? parsed.web ?? null;
  if (!block?.client_id || !block?.client_secret) {
    throw new HttpError(400, 'E_VALIDATION',
      '檔案裡找不到 client_id／client_secret。請在「憑證」頁面該筆 OAuth 用戶端右邊按「下載 JSON」，下載到的才是這個檔。');
  }

  // 網頁應用程式類型必須自己登記回導網址；沒登記就先擋，並把要貼的那一行講清楚
  if (parsed.web) {
    const registered = parsed.web.redirect_uris ?? [];
    if (!registered.includes(expectedRedirect)) {
      throw new HttpError(400, 'E_REDIRECT_MISSING',
        `這是「網頁應用程式」類型的憑證，但它的「已授權的重新導向 URI」沒有包含 ${expectedRedirect}。` +
        '請到 Google Cloud 憑證頁把這一行加進去再下載一次；或是重建一個「電腦版應用程式」類型的憑證（那種不用填 URI，比較不會出錯）。');
    }
  }

  const s = readSecrets();
  writeSecrets({
    ...s,
    mode: 'oauth',
    clientId: block.client_id,
    clientSecret: block.client_secret,
    refreshToken: s.clientId === block.client_id ? s.refreshToken : undefined,
  });
  accessCache = { token: '', expiresAt: 0 };
  log.info('已從 JSON 檔匯入 OAuth 憑證', parsed.installed ? '電腦版應用程式' : '網頁應用程式');
  return { ...driveStatus(), clientType: parsed.installed ? 'installed' : 'web' };
}

export function buildAuthUrl(redirectUri) {
  const s = readSecrets();
  if (!s.clientId) throw new HttpError(400, 'E_DRIVE_SETUP', '尚未填寫 Google 用戶端 ID／密鑰');
  const params = new URLSearchParams({
    client_id: s.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  return `${AUTH_ENDPOINT}?${params}`;
}

export async function exchangeCode(code, redirectUri) {
  const s = readSecrets();
  if (!s.clientId || !s.clientSecret) throw new HttpError(400, 'E_DRIVE_SETUP', '尚未填寫 Google 用戶端 ID／密鑰');
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: s.clientId,
      client_secret: s.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new HttpError(400, 'E_DRIVE_AUTH', `授權失敗：${data.error_description ?? data.error ?? res.status}`);
  }
  accessCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  const account = await fetchAccountEmail(data.access_token);
  writeSecrets({ ...readSecrets(), refreshToken: data.refresh_token, account });
  log.info('Google 雲端授權完成', account);
  return driveStatus();
}

async function fetchAccountEmail(token) {
  try {
    const res = await fetch(`${API}/about?fields=user(emailAddress)`, { headers: { authorization: `Bearer ${token}` } });
    const data = await res.json();
    return data?.user?.emailAddress ?? '';
  } catch {
    return '';
  }
}

export function revoke() {
  const s = readSecrets();
  writeSecrets({ clientId: s.clientId, clientSecret: s.clientSecret });
  accessCache = { token: '', expiresAt: 0 };
  return driveStatus();
}

async function accessToken() {
  if (accessCache.token && Date.now() < accessCache.expiresAt) return accessCache.token;
  const s = readSecrets();
  if (s.mode === 'service') return serviceAccessToken();
  if (!s.clientId || !s.clientSecret) throw new HttpError(400, 'E_DRIVE_SETUP', '尚未填寫 Google 用戶端 ID／密鑰');
  if (!s.refreshToken) throw new HttpError(400, 'E_DRIVE_AUTH', '尚未授權 Google 帳號，請到設定頁完成授權');

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      refresh_token: s.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new HttpError(400, 'E_DRIVE_AUTH', `換發權杖失敗，請重新授權：${data.error_description ?? data.error ?? res.status}`);
  }
  accessCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000 };
  return accessCache.token;
}

/** 帶指數退避的 API 呼叫（外部依賴情境：Google 偶發 5xx/429） */
async function api(pathname, init = {}, attempt = 0) {
  const token = await accessToken();
  const res = await fetch(pathname.startsWith('http') ? pathname : `${API}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 3) {
    await new Promise((r) => setTimeout(r, 2 ** attempt * 800));
    return api(pathname, init, attempt + 1);
  }
  return res;
}

async function apiJson(pathname, init) {
  const res = await api(pathname, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw driveError(res.status, data);
  return data;
}

/** 把 Google 的錯誤翻成看得懂的話（尤其是服務帳戶最常撞的配額問題） */
function driveError(status, data) {
  const message = data?.error?.message ?? String(status);
  const reason = data?.error?.errors?.[0]?.reason ?? '';
  if (/storageQuotaExceeded/i.test(reason + message)) {
    return new HttpError(400, 'E_DRIVE_QUOTA',
      '服務帳戶沒有自己的儲存空間，不能傳進「我的雲端硬碟」。' +
      '請把目標資料夾改成「共用雲端硬碟」裡的資料夾（需要 Google Workspace），' +
      '並把該資料夾分享給服務帳戶信箱（編輯者權限）；或改用 OAuth 一次授權模式。');
  }
  if (status === 404) {
    const mode = readSecrets().mode === 'service' ? 'service' : 'oauth';
    return new HttpError(400, 'E_DRIVE_FOLDER', mode === 'service'
      ? `找不到目標資料夾，或服務帳戶沒有存取權（${message}）。記得把資料夾分享給服務帳戶信箱（編輯者）。`
      : `讀不到這個資料夾的資料（${message}）。本工具只要 drive.file 權限，看不到「不是自己建立」的資料夾——這不一定代表不能寫入，請用「檢查並套用」讓它實際測一次。`);
  }
  return new HttpError(status === 401 ? 400 : 502, 'E_DRIVE_API', `Google 回應錯誤：${message}`);
}

/** 共用雲端硬碟需要這組參數，個人硬碟帶著也無害 */
const SHARED_DRIVE_PARAMS = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };

/** 找或建資料夾（drive.file 權限下只看得到本工具建立的，剛好避免撞名） */
export async function ensureFolder(name, parentId = null) {
  const escaped = String(name).replace(/'/g, "\\'");
  const clauses = [
    `name='${escaped}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    parentId ? `'${parentId}' in parents` : null,
  ].filter(Boolean);
  const query = new URLSearchParams({ q: clauses.join(' and '), fields: 'files(id,name)', pageSize: '10', ...SHARED_DRIVE_PARAMS });
  const found = await apiJson(`/files?${query}`);
  if (found.files?.length) return found.files[0].id;

  const created = await apiJson(`/files?fields=id,name&supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  return created.id;
}

/**
 * 取得（必要時建立）本工具的根資料夾。
 * 服務帳戶模式沒有可用的「我的雲端硬碟」，一定要先指定目標資料夾，否則直接講清楚不要讓它默默失敗。
 */
export async function ensureRootFolder(folderName) {
  const s = readSecrets();
  if (s.mode === 'service') {
    throw new HttpError(400, 'E_DRIVE_SETUP',
      '服務帳戶模式必須先在設定頁指定「目標資料夾 ID」：' +
      '在共用雲端硬碟建一個資料夾，分享給服務帳戶信箱（編輯者），再把資料夾 ID 貼進來。');
  }
  if (s.rootFolderId) {
    const res = await api(`/files/${s.rootFolderId}?fields=id,trashed`);
    if (res.ok) {
      const data = await res.json();
      if (!data.trashed) return s.rootFolderId;
    }
  }
  const id = await ensureFolder(folderName, null);
  writeSecrets({ ...readSecrets(), rootFolderId: id });
  return id;
}

/**
 * Resumable 上傳一個本機檔案（手機原圖常 >5MB，simple upload 上限 5MB 不夠用）。
 * @returns {Promise<{id:string, webViewLink:string, name:string}>}
 */
export async function uploadFile({ filePath, name, mimeType, parents, description = '' }) {
  const stat = await fsp.stat(filePath);
  const token = await accessToken();

  const startRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': mimeType,
      'x-upload-content-length': String(stat.size),
    },
    body: JSON.stringify({ name, parents, description: description || undefined }),
  });
  if (!startRes.ok) {
    const text = await startRes.text().catch(() => '');
    throw new HttpError(502, 'E_DRIVE_API', `建立上傳工作階段失敗（${startRes.status}）${text.slice(0, 200)}`);
  }
  const sessionUrl = startRes.headers.get('location');
  if (!sessionUrl) throw new HttpError(502, 'E_DRIVE_API', 'Google 沒有回傳上傳位址');

  const body = await fsp.readFile(filePath);
  const putRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'content-type': mimeType, 'content-length': String(stat.size) },
    body,
  });
  const data = await putRes.json().catch(() => ({}));
  if (!putRes.ok) {
    throw new HttpError(502, 'E_DRIVE_API', `上傳失敗（${putRes.status}）${data?.error?.message ?? ''}`);
  }
  return { id: data.id, name: data.name, webViewLink: data.webViewLink ?? `https://drive.google.com/file/d/${data.id}/view` };
}

/** 上傳一段文字（清單 CSV） */
export async function uploadText({ name, text, parents, mimeType = 'text/csv' }) {
  const token = await accessToken();
  const boundary = `----photoRelay${Date.now()}`;
  const meta = JSON.stringify({ name, parents });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\ncontent-type: ${mimeType}; charset=UTF-8\r\n\r\n`),
    Buffer.from('﻿' + text, 'utf8'), // BOM：Excel 開 CSV 才不會中文亂碼
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'E_DRIVE_API', `清單上傳失敗：${data?.error?.message ?? res.status}`);
  return data;
}

/**
 * 把資料夾設成「知道連結的人都可以編輯」，回傳可分享的連結。
 * 用 drive.file scope 對自己建立的資料夾設權限是允許的；子檔案會繼承這個權限。
 * 注意：這等於公開可寫，任何拿到連結的人都能改內容 —— UI 上要講清楚。
 */
export async function shareFolderForEditing(folderId) {
  const existing = await apiJson(`/files/${folderId}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`);
  const already = (existing.permissions ?? []).find((p) => p.type === 'anyone' && p.role === 'writer');
  if (!already) {
    const res = await api(`/files/${folderId}/permissions?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new HttpError(502, 'E_DRIVE_SHARE', `建立共用權限失敗：${data?.error?.message ?? res.status}`);
    }
  }
  const folder = await apiJson(`/files/${folderId}?fields=id,name,webViewLink&supportsAllDrives=true`);
  return { id: folder.id, name: folder.name, link: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folderId}` };
}

/**
 * 讓「單一檔案」自己有一組「知道連結的人可以編輯」的權限，並取回它的專屬連結。
 * 為什麼不靠資料夾繼承：繼承來的權限看不出來、也不能單獨撤銷；
 * 每張圖各自掛一份，才能真的「把這一張分享給某人編輯」而不是整個資料夾。
 */
export async function shareFileForEditing(fileId) {
  const existing = await apiJson(`/files/${fileId}/permissions?fields=permissions(id,type,role)&supportsAllDrives=true`);
  const already = (existing.permissions ?? []).find((p) => p.type === 'anyone' && p.role === 'writer');
  if (!already) {
    const res = await api(`/files/${fileId}/permissions?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'writer', type: 'anyone' }),
    });
    if (!res.ok) throw driveError(res.status, await res.json().catch(() => ({})));
  }
  const file = await apiJson(`/files/${fileId}?fields=id,name,webViewLink&supportsAllDrives=true`);
  return {
    id: file.id,
    name: file.name,
    link: file.webViewLink ?? `https://drive.google.com/file/d/${fileId}/view`,
    role: 'writer',
  };
}

/** 刪檔（連線測試用完要收乾淨，不留垃圾在你的雲端） */
export async function deleteFile(fileId) {
  await api(`/files/${fileId}?supportsAllDrives=true`, { method: 'DELETE' });
}

/**
 * 連線測試：真的建資料夾、真的傳一個小檔、再刪掉。
 * 目的是「按一下就知道到底通不通」，而不是等到現場傳了 50 張才發現雲端沒設好。
 */
export async function testConnection({ rootFolderName, targetFolderId }) {
  const parentId = targetFolderId || (await ensureRootFolder(rootFolderName));

  // 讀不到中繼資料不代表不能寫（drive.file 對「使用者自己建的資料夾」就是這樣），
  // 所以讀失敗不中止，直接往下用真的上傳來判定。
  let folder = { id: parentId, name: '', webViewLink: '' };
  const meta = await api(`/files/${parentId}?fields=id,name,webViewLink&supportsAllDrives=true`);
  if (meta.ok) {
    folder = await meta.json();
  } else if (meta.status !== 404) {
    throw driveError(meta.status, await meta.json().catch(() => ({})));
  }

  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const probe = await uploadText({
    name: `連線測試-${stamp}.txt`,
    text: `photo-relay 連線測試\n時間：${stamp}\n看到這個檔案代表雲端上傳是通的（本檔會自動刪除）。`,
    parents: [parentId],
  });
  await deleteFile(probe.id).catch(() => {}); // 刪不掉不算失敗，檔案本來就很小

  return {
    ok: true,
    folderId: folder.id,
    folderName: folder.name || '你指定的資料夾（權限只夠寫入，讀不到名稱）',
    folderLink: folder.webViewLink ?? `https://drive.google.com/drive/folders/${folder.id}`,
    account: driveStatus().account,
  };
}

/** 驗證使用者自填的目標資料夾 ID 是否可用 */
/**
 * 檢查目標資料夾能不能用。
 *
 * 為什麼不是單純讀中繼資料：本工具只要 `drive.file` 權限（最小權限），
 * 對「使用者自己在 Drive 建的資料夾」是**讀不到名字但寫得進去**的。
 * 只用 files.get 判斷會誤判成「不能用」，所以讀不到時改成**實際建一個暫時資料夾再刪掉**，
 * 用真的寫入結果決定能不能用，而不是用猜的。
 */
export async function checkFolder(folderId) {
  const res = await api(`/files/${folderId}?fields=id,name,mimeType,trashed,driveId&supportsAllDrives=true`);
  const data = await res.json().catch(() => ({}));

  if (res.ok) {
    if (data.mimeType !== 'application/vnd.google-apps.folder') throw new HttpError(400, 'E_DRIVE_FOLDER', '這個 ID 不是資料夾');
    if (data.trashed) throw new HttpError(400, 'E_DRIVE_FOLDER', '這個資料夾在垃圾桶裡');
    return { id: data.id, name: data.name, writable: true, readable: true };
  }
  if (res.status !== 404) throw driveError(res.status, data);

  // 讀不到 → 實際寫寫看
  const probe = await api('/files?fields=id&supportsAllDrives=true', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '.photo-relay-權限測試',
      mimeType: 'application/vnd.google-apps.folder',
      parents: [folderId],
    }),
  });
  const probeData = await probe.json().catch(() => ({}));
  if (!probe.ok) throw driveError(probe.status, probeData);
  await deleteFile(probeData.id).catch(() => {});

  return {
    id: folderId,
    name: '（權限只夠寫入，讀不到資料夾名稱）',
    writable: true,
    readable: false,
  };
}
