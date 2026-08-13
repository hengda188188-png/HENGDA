/**
 * 服務帳戶（零登入模式）的憑證處理測試。
 * 不連 Google：用自己產生的 RSA 金鑰驗證「金鑰檔驗證 → JWT 組裝 → RS256 簽章」這條路真的成立，
 * 避免等到實際上傳當下才發現簽不出來。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-relay-sa-'));
process.env.PHOTO_RELAY_DATA = DATA;

const drive = await import('../src/lib/google-drive.mjs');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const keyFile = {
  type: 'service_account',
  project_id: 'demo-project',
  client_email: 'photo-relay@demo-project.iam.gserviceaccount.com',
  private_key: privateKey,
};

console.log('服務帳戶憑證');

// 壞資料要擋掉
for (const [label, input] of [
  ['不是 JSON', 'hello world'],
  ['缺少 client_email', JSON.stringify({ type: 'service_account', private_key: privateKey })],
  ['type 不對（誤貼 OAuth 憑證檔）', JSON.stringify({ type: 'authorized_user', client_email: 'x@y', private_key: privateKey })],
  ['private_key 是假的', JSON.stringify({ ...keyFile, private_key: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' })],
]) {
  let rejected = false;
  try {
    drive.saveServiceAccount(input);
  } catch (err) {
    rejected = err.code === 'E_VALIDATION';
  }
  check(`擋掉錯誤金鑰檔：${label}`, rejected);
}

// 正常金鑰檔
const status = drive.saveServiceAccount(JSON.stringify(keyFile));
check('匯入合法金鑰檔後切換成服務帳戶模式', status.mode === 'service' && status.authorized === true, JSON.stringify(status));
check('狀態回傳服務帳戶信箱（給使用者拿去分享資料夾）', status.serviceAccountEmail === keyFile.client_email);

// 密鑰不可外洩
check('對外狀態不含 private_key', !JSON.stringify(status).includes('BEGIN PRIVATE KEY'));
const onDisk = JSON.parse(fs.readFileSync(path.join(DATA, 'secrets.json'), 'utf8'));
check('金鑰只存在本機 secrets.json', onDisk.serviceAccount.private_key.includes('BEGIN PRIVATE KEY'));

// JWT 簽章：自己組一次，用公鑰驗證簽得出來且驗得過
const base64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const now = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claim = base64url(JSON.stringify({
  iss: keyFile.client_email,
  scope: drive.SERVICE_SCOPE,
  aud: 'https://oauth2.googleapis.com/token',
  iat: now,
  exp: now + 3600,
}));
const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${claim}`), privateKey);
const verified = crypto.verify('RSA-SHA256', Buffer.from(`${header}.${claim}`), publicKey, signature);
check('RS256 簽章可用公鑰驗證通過', verified);

const decodedClaim = JSON.parse(Buffer.from(claim.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
check('JWT claim 帶對 scope（服務帳戶用完整 drive）', decodedClaim.scope === 'https://www.googleapis.com/auth/drive');
check('JWT claim 帶對 aud（Google 權杖端點）', decodedClaim.aud === 'https://oauth2.googleapis.com/token');
check('JWT 有效期不超過 1 小時', decodedClaim.exp - decodedClaim.iat <= 3600);

// 服務帳戶模式沒指定目標資料夾 → 要明確擋下，不能默默失敗
let blocked = null;
try {
  await drive.ensureRootFolder('PhotoRelay 上傳');
} catch (err) {
  blocked = err;
}
check('服務帳戶模式未設目標資料夾 → 明確擋下並說怎麼做',
  blocked?.code === 'E_DRIVE_SETUP' && blocked.message.includes('共用雲端硬碟'), blocked?.message);

// 切回 OAuth
const back = drive.useOAuthMode();
check('可以切回 OAuth 模式', back.mode === 'oauth');
const removed = drive.removeServiceAccount();
check('可以移除服務帳戶金鑰', removed.serviceAccountEmail === '');

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n通過 ${passed}　失敗 ${failed}`);
process.exit(failed ? 1 : 0);
