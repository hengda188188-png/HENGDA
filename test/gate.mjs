/**
 * 前端規範機器閘門（本專案自帶版）。
 * 為什麼要自帶：這台電腦只有基地同步骨架，沒有 tools/ui-constraints、web-standard-check、feature-map 可用。
 * 這支把「網頁設計規範第八章自審清單」裡**能靜態驗**的項目機器化，ERROR 一項都不能剩。
 * 回到主基地後，仍應再跑官方三道閘門（見 README「未過閘門」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');

const errors = [];
const warns = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);
const warn = (file, msg) => warns.push(`${file}: ${msg}`);

function walk(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (ext.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const htmlFiles = walk(WEB, ['.html']);
const cssFiles = walk(WEB, ['.css']);
const jsFiles = walk(WEB, ['.js']);

// ── A. 可及性 ───────────────────────────────────────────
for (const file of htmlFiles) {
  const src = fs.readFileSync(file, 'utf8');

  for (const tag of src.match(/<img\b[^>]*>/g) ?? []) {
    if (!/\salt=/.test(tag)) err(rel(file), `A1 <img> 缺 alt：${tag.slice(0, 60)}`);
  }

  // 只有圖示、沒有文字的按鈕必須有 aria-label
  for (const btn of src.match(/<button\b[\s\S]*?<\/button>/g) ?? []) {
    const text = btn.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    const hasLabel = /aria-label=|data-i18n-label=/.test(btn);
    const hasTextSlot = /data-i18n=/.test(btn);
    if (!text && !hasLabel && !hasTextSlot) err(rel(file), `A2 圖示按鈕缺 aria-label：${btn.slice(0, 70)}`);
  }

  // 輸入框要有 label（for=）或 aria-label
  for (const input of src.match(/<(input|select|textarea)\b[^>]*>/g) ?? []) {
    if (/type="(hidden|checkbox|file)"/.test(input)) continue;
    const id = input.match(/\sid="([^"]+)"/)?.[1];
    const labelled = (id && new RegExp(`<label[^>]*for="${id}"`).test(src)) || /aria-label=|data-i18n-label=/.test(input);
    if (!labelled) err(rel(file), `A3 輸入元件沒有對應 label：${input.slice(0, 70)}`);
  }

  if (!/<meta\s+name="robots"\s+content="noindex/.test(src)) err(rel(file), 'S1 管理/工具頁必須標 noindex');
  if (!/<html\s+lang="/.test(src)) err(rel(file), 'S2 <html> 缺 lang');
  if (!/<meta\s+name="viewport"/.test(src)) err(rel(file), 'S3 缺 viewport（手機會破版）');
}

// ── B. 視覺規範 ─────────────────────────────────────────
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
for (const file of [...htmlFiles, ...jsFiles, ...cssFiles]) {
  const src = fs.readFileSync(file, 'utf8');
  if (EMOJI.test(src)) err(rel(file), 'V1 禁用 emoji（圖示一律 inline SVG）');
}

for (const file of cssFiles) {
  const src = fs.readFileSync(file, 'utf8');
  // 彩虹漸層：一個 gradient 出現 3 個以上色碼
  for (const gradient of src.match(/(linear|radial|conic)-gradient\([^)]*\)/g) ?? []) {
    const colors = gradient.match(/#[0-9a-f]{3,8}|rgba?\(|var\(--/gi) ?? [];
    if (colors.length >= 4) warn(rel(file), `V2 漸層色數偏多，確認不是彩虹：${gradient.slice(0, 60)}`);
  }
  // 寬度失控：width:100% 沒有 max-width（同一個規則區塊內）
  for (const block of src.match(/[^{}]+\{[^}]*\}/g) ?? []) {
    if (/width:\s*100%/.test(block) && !/max-width/.test(block) && !/height|grid|flex:|\.progress|\.qr-box|canvas|img|textarea|input/.test(block)) {
      warn(rel(file), `C1 width:100% 沒有 max-width：${block.split('{')[0].trim()}`);
    }
  }
}

// 顏色一律走 token：HTML 內聯樣式不得直接寫色碼
for (const file of htmlFiles) {
  const src = fs.readFileSync(file, 'utf8');
  for (const style of src.match(/style="[^"]*"/g) ?? []) {
    if (/#[0-9a-f]{3,8}|rgb\(/i.test(style)) err(rel(file), `V3 內聯樣式寫死顏色，應用 CSS 變數：${style.slice(0, 60)}`);
  }
}

// ── C. 容器約束（版面穩定鐵則）─────────────────────────
const cssAll = cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const scrollContainers = ['.gallery', '.project-list', '.member-list', '.ov-body', '.side'];
for (const selector of scrollContainers) {
  const block = cssAll.match(new RegExp(`\\${selector}\\s*\\{[^}]*\\}`))?.[0];
  if (!block) {
    err('web/css', `C2 找不到容器規則 ${selector}`);
    continue;
  }
  if (!/overflow(-y)?:\s*auto/.test(block)) err('web/css', `C2 ${selector} 必須內捲（overflow-y:auto）`);
  if (!/(height|max-height|flex:\s*1|min-height)/.test(block)) err('web/css', `C3 ${selector} 必須有尺寸約束，否則會被內容撐大`);
}

// ── D. 文案不硬編碼（走 i18n 字典）──────────────────────
const CJK = /[\u4e00-\u9fff]/;
for (const file of jsFiles) {
  if (file.endsWith(path.join('lib', 'i18n.js'))) continue;
  const src = fs.readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/^\s*\*/.test(line)) return; // JSDoc 註解
    if (/console\.(log|warn|error|info|debug)/.test(code)) return; // 開發日誌不是使用者文案
    for (const literal of code.match(/(['"`])(?:(?!\1)[^\\]|\\.)*\1/g) ?? []) {
      if (CJK.test(literal)) err(rel(file), `I1 第 ${i + 1} 行有硬編碼中文，請移進 i18n 字典：${literal.slice(0, 40)}`);
    }
  });
}

// ── E. 死代碼（每個前端模組都要被載入鏈用到）────────────
const entryHtml = htmlFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
const jsSources = jsFiles.map((f) => ({ file: f, src: fs.readFileSync(f, 'utf8') }));
for (const { file } of jsSources) {
  const name = path.basename(file);
  const importedBy = jsSources.some((other) => other.file !== file && new RegExp(`['"\`][^'"\`]*${name.replace('.', '\\.')}['"\`]`).test(other.src));
  const inHtml = entryHtml.includes(rel(file).replace('web/', '/assets/'));
  if (!importedBy && !inHtml) err(rel(file), 'D1 沒有任何入口載入這支模組（死代碼）');
}

// ── 輸出 ────────────────────────────────────────────────
console.log('前端規範閘門\n');
if (warns.length) {
  console.log(`WARN ${warns.length}`);
  warns.forEach((w) => console.log(`  · ${w}`));
  console.log('');
}
if (errors.length) {
  console.log(`ERROR ${errors.length}`);
  errors.forEach((e) => console.log(`  · ${e}`));
  console.log('\n閘門未通過：ERROR 必須清零才算完成。');
  process.exit(1);
}
console.log(`ERROR 0　WARN ${warns.length}　→ 閘門通過`);
