/**
 * OAuth 憑證 JSON 檔匯入的驗收（離線，不連 Google）。
 * 重點：把「憑證類型選錯」這個最常見的坑在匯入當下就擋下來，
 * 而不是等到使用者按授權才噴 redirect_uri_mismatch。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-relay-oauth-'));
process.env.PHOTO_RELAY_DATA = DATA;
const drive = await import('../src/lib/google-drive.mjs');

const REDIRECT = 'http://127.0.0.1:4901/api/drive/callback';
let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

const ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const SECRET = 'GOCSPX-abcdefghijklmnopqrstuv';

console.log('OAuth 憑證檔匯入');

const expectReject = (label, input, codeOrText) => {
  let err = null;
  try { drive.saveCredentialsFromJson(input, REDIRECT); } catch (e) { err = e; }
  check(label, Boolean(err) && (err.message.includes(codeOrText) || err.code === codeOrText), err?.message ?? '沒有拋錯');
};

expectReject('不是 JSON 會被擋', 'not json at all', '合法的 JSON');
expectReject('誤貼服務帳戶金鑰檔會被擋並說清楚',
  JSON.stringify({ type: 'service_account', client_email: 'a@b', private_key: 'x' }), '服務帳戶金鑰檔');
expectReject('檔案內容不對（沒有 installed/web）會被擋',
  JSON.stringify({ hello: 'world' }), '下載 JSON');
expectReject('網頁應用程式沒登記回導網址 → 當場擋下並告知要貼哪一行',
  JSON.stringify({ web: { client_id: ID, client_secret: SECRET, redirect_uris: ['http://localhost:3000/cb'] } }),
  REDIRECT);

// 電腦版應用程式：正常匯入
const installed = drive.saveCredentialsFromJson(
  JSON.stringify({ installed: { client_id: ID, client_secret: SECRET, redirect_uris: ['http://localhost'] } }), REDIRECT);
check('電腦版應用程式憑證匯入成功', installed.hasCredentials === true && installed.clientType === 'installed', JSON.stringify(installed));
check('匯入後是 OAuth 模式', installed.mode === 'oauth');
check('狀態只回遮罩後的 ID，不吐密鑰',
  installed.clientIdMasked.includes('…') && !JSON.stringify(installed).includes(SECRET), installed.clientIdMasked);

// 網頁應用程式：有登記正確網址就放行
const web = drive.saveCredentialsFromJson(
  JSON.stringify({ web: { client_id: ID, client_secret: SECRET, redirect_uris: [REDIRECT, 'http://x/y'] } }), REDIRECT);
check('網頁應用程式有登記正確 URI 就能匯入', web.clientType === 'web' && web.hasCredentials === true);

const stored = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8'));
check('密鑰只存在本機 secrets.json', stored.clientSecret === SECRET);

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`
通過 ${passed}　失敗 ${failed}`);
process.exit(failed ? 1 : 0);
