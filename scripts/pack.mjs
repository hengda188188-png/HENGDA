/**
 * 搬機打包：把這個工具打成一個 zip，拿到新電腦解壓縮、雙擊就能跑。
 *
 * 這支之所以簡單，是因為專案本身零外部套件、沒有寫死路徑或 IP——
 * 搬機的難處不在程式，而在「哪些東西該帶、哪些不該帶」，所以重點在下面的排除規則。
 *
 * 用法：
 *   node scripts/pack.mjs                          只帶程式碼（新機自己重新授權，最乾淨）
 *   node scripts/pack.mjs --with-auth              帶 Google 授權與設定（新機免登入直接能傳）⚠ 內含憑證
 *   node scripts/pack.mjs --with-data              帶既有照片與專案紀錄
 *   node scripts/pack.mjs --with-auth --with-data  兩者都帶（完整搬機）
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
/** 帶授權＝帶 secrets.json（Google 憑證與權杖）＋ settings.json（目標資料夾等設定） */
const withAuth = args.has('--with-auth') || args.has('--with-secrets');
/** 帶資料＝帶 db.json 與所有照片實體檔 */
const withData = args.has('--with-data');

const ALWAYS_SKIP = new Set(['node_modules', 'dist', '.git', '.DS_Store']);
const SKIP_EXT = new Set(['.log', '.part', '.tmp']);
/** 帶授權時一併帶走的設定檔（不含照片資料） */
const AUTH_FILES = new Set(['secrets.json', 'settings.json']);

function shouldSkip(relative, name, isDir) {
  if (ALWAYS_SKIP.has(name)) return true;
  if (!isDir && SKIP_EXT.has(path.extname(name))) return true;

  const inData = relative === 'data' || relative.startsWith('data' + path.sep);
  if (!inData) return false;

  // 資料夾要先判斷，不然 data/ 會在遞迴之前就被整個排掉，
  // 導致「說要帶授權卻什麼都沒帶到」（自我檢查抓過這個 bug）
  if (isDir) {
    if (relative === 'data') return !withAuth && !withData;
    return !withData; // data 底下的子資料夾都是照片
  }

  if (name === 'db.backup.json') return true;   // 備份檔不必跟著搬
  if (AUTH_FILES.has(name)) return !withAuth;   // 授權與設定：看 --with-auth
  return !withData;                              // 其餘（db.json、照片）：看 --with-data
}

function copyTree(from, to, relative = '') {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    if (shouldSkip(rel, entry.name, entry.isDirectory())) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst, rel);
    else fs.copyFileSync(src, dst);
  }
}

function walk(dir, relative = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else out.push({ rel, bytes: fs.statSync(full).size });
  }
  return out;
}

/** 優先用 pwsh：Windows PowerShell 5.1 的 Compress-Archive 會用反斜線當分隔符，別的系統解壓會出怪檔名 */
function zip(sourceDir, target) {
  const command = `Compress-Archive -Path '${sourceDir}\\*' -DestinationPath '${target}' -Force`;
  for (const shell of ['pwsh', 'powershell']) {
    try {
      execFileSync(shell, ['-NoProfile', '-Command', command], { stdio: 'pipe' });
      return shell;
    } catch {
      /* 換下一個 */
    }
  }
  throw new Error('找不到可用的 PowerShell 來壓縮');
}

const stamp = new Date().toISOString().slice(0, 10);
const suffix = [withAuth ? '含授權' : '', withData ? '含資料' : ''].filter(Boolean).join('');
const distDir = path.join(ROOT, 'dist');
const target = path.join(distDir, `photo-relay-${stamp}${suffix ? '-' + suffix : ''}.zip`);
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'photo-relay-pack-'));
const payload = path.join(staging, 'photo-relay');

try {
  copyTree(ROOT, payload);
  const files = walk(payload);
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

  // 打包前自我檢查：說有帶就要真的在，說沒帶就不能混進去
  const hasSecrets = files.some((f) => f.rel.endsWith('data/secrets.json'));
  const hasDb = files.some((f) => f.rel.endsWith('data/db.json'));
  if (withAuth !== hasSecrets) throw new Error(`打包結果與宣稱不符：--with-auth=${withAuth} 但 secrets.json ${hasSecrets ? '在' : '不在'}包裡`);
  if (withData !== hasDb) throw new Error(`打包結果與宣稱不符：--with-data=${withData} 但 db.json ${hasDb ? '在' : '不在'}包裡`);
  if (files.some((f) => f.rel.includes('/original/') || f.rel.includes('/thumb/')) && !withData) {
    throw new Error('打包結果與宣稱不符：沒說要帶資料卻混進了照片檔');
  }

  fs.mkdirSync(distDir, { recursive: true });
  fs.rmSync(target, { force: true });
  const shell = zip(staging, target);
  const size = fs.statSync(target).size;
  const photoCount = files.filter((f) => f.rel.includes('/original/')).length;

  console.log('打包完成');
  console.log(`  檔案 : ${target}`);
  console.log(`  內容 : ${files.length} 個檔案（壓縮前 ${(totalBytes / 1024).toFixed(0)} KB → 壓縮後 ${(size / 1024).toFixed(0)} KB，用 ${shell}）`);
  console.log(`  Google 授權 : ${withAuth ? '✅ 有帶（新機免登入，開了就能傳）' : '沒帶（新機要自己授權一次）'}`);
  console.log(`  既有照片    : ${withData ? `✅ 有帶（${photoCount} 張原圖）` : '沒帶（新機從零開始）'}`);
  console.log('');
  if (withAuth) {
    console.log('  ⚠ 這個 zip 內含你的 Google 憑證與權杖，等於一把可以寫入你雲端硬碟的鑰匙。');
    console.log('    用隨身碟或加密方式傳遞，不要放在公開空間、不要用即時通訊軟體傳。');
    console.log('');
  }
  console.log('新電腦還原步驟：');
  console.log('  1. 安裝 Node.js 20 以上（https://nodejs.org）← 只有這步要先做');
  console.log('  2. 把 zip 解壓縮到任意位置（桌面也可以）');
  console.log('  3. 雙擊資料夾裡的 start.cmd → 瀏覽器會自動打開工作台');
  console.log('     想要桌面捷徑：先雙擊 install-desktop-shortcut.cmd，之後點桌面的 PhotoRelay 就好');
  if (!withAuth) console.log('  4. 設定頁完成 Google 授權（用同一份憑證 JSON 即可，不必重新申請）');
  console.log('');
  console.log('  多台電腦要一起用時：只讓「一台」跑伺服器，其他台用瀏覽器開它的區網網址。');
  console.log('  每台各跑一份會變成各自獨立的資料庫，照片不會互通。');
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
