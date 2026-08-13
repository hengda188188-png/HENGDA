/**
 * QR 產生器回歸測試（零依賴）。
 * 黃金值來源：2026-08-10 以 npm `qrcode` 當對照組，6 組內容 × 4 容錯等級 × 8 遮罩共 192 組矩陣「逐模組完全一致」後固化。
 * 之後只要改到 qrcode.mjs，這支測試就會抓出行為漂移。
 */
import crypto from 'node:crypto';
import { encode, toSVG } from '../src/lib/qrcode.mjs';

const GOLDEN = [
  ['http://192.168.1.23:4901/m/a1b2c3d4e5f6a7b8', 'M', 4, 4, '62278c278a7a909ad7997df681c3de28'],
  ['HELLO WORLD', 'L', 1, 3, '59047e77ff643f4c941969a88e3ad399'],
  ['A', 'H', 1, 7, '22ab3bf2cd0ed98fdb03284c7f9e5765'],
  ['手機掃碼傳圖', 'Q', 2, 2, '220814e5b65197576c10723400ebfd04'],
  [
    'https://example.com/very/long/path/that/pushes/version/up/1234567890/abcdefghijklmnopqrstuvwxyz/ABCDEFGHIJKLMNOP',
    'M', 7, 2, 'd9aa30284a0e3052a1b8e7fe727d9eb8',
  ],
];

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

console.log('QR 產生器');
for (const [text, ecl, version, mask, digest] of GOLDEN) {
  const qr = encode(text, { ecl });
  const actual = crypto.createHash('sha256').update(Buffer.from(qr.modules)).digest('hex').slice(0, 32);
  check(
    `「${text.slice(0, 24)}」${ecl} → v${version} mask${mask}`,
    qr.version === version && qr.mask === mask && actual === digest,
    `得到 v${qr.version} mask${qr.mask} ${actual}`
  );
}

// 結構性檢查
const qr = encode('http://192.168.1.106:4901/m/0123456789abcdef0123456789abcdef', { ecl: 'M' });
check('矩陣尺寸 = 版本 × 4 + 17', qr.size === qr.version * 4 + 17);
check('三個定位圖左上角是黑點', qr.get(0, 0) && qr.get(qr.size - 7, 0) && qr.get(0, qr.size - 7));
check('計時線交替', [...Array(qr.size - 16)].every((_, i) => qr.get(8 + i, 6) === ((8 + i) % 2 === 0)));

const svg = toSVG('http://192.168.1.106:4901/m/abc', { ecl: 'M' });
check('SVG 自我包含（無外部資源）', svg.startsWith('<svg') && !svg.includes('http://www.w3.org/1999/xlink') && !/<image/.test(svg));
check('SVG 有無障礙標題', svg.includes('role="img"') && svg.includes('<title>'));

let tooLong = false;
try {
  encode('x'.repeat(300), { ecl: 'H' });
} catch (err) {
  tooLong = err.message.startsWith('E_QR_TOO_LONG');
}
check('內容過長會明確報錯（不是默默產生壞圖）', tooLong);

console.log(`\n通過 ${passed}　失敗 ${failed}`);
process.exit(failed ? 1 : 0);
