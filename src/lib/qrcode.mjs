/**
 * 零依賴 QR Code 產生器（byte mode，版本 1-10，EC L/M/Q/H）。
 * 只做本專案需要的事：把一段短網址編成矩陣 → 輸出 SVG。
 * 演算法依 ISO/IEC 18004；正確性由 test/qr-crosscheck.mjs 對照 npm `qrcode` 逐 mask 驗證。
 */

// ── GF(256) 對數表（本原多項式 0x11D）────────────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// ── 版本/EC 參數表（版本 1-10）──────────────────────────────────
const TOTAL_CODEWORDS = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const EC_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const NUM_BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
export const MIN_VERSION = 1;
export const MAX_VERSION = 10;

const getBit = (value, i) => ((value >>> i) & 1) !== 0;

function dataCapacityBits(version, ecl) {
  const ecTotal = EC_PER_BLOCK[ecl][version] * NUM_BLOCKS[ecl][version];
  return (TOTAL_CODEWORDS[version] - ecTotal) * 8;
}

function charCountBits(version) {
  return version < 10 ? 8 : 16; // byte mode
}

/** 依內容長度挑最小可容納的版本 */
function pickVersion(byteLen, ecl, minVersion, maxVersion) {
  for (let v = minVersion; v <= maxVersion; v++) {
    const needed = 4 + charCountBits(v) + byteLen * 8;
    if (needed <= dataCapacityBits(v, ecl)) return v;
  }
  throw new Error(`E_QR_TOO_LONG: ${byteLen} bytes 放不進版本 ${maxVersion}(${ecl})`);
}

// ── Reed-Solomon ───────────────────────────────────────────────
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ── 位元流 → 交錯後的完整碼字 ────────────────────────────────────
function buildCodewords(text, version, ecl) {
  const bytes = new TextEncoder().encode(text);
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, charCountBits(version));
  for (const b of bytes) push(b, 8);

  const capacity = dataCapacityBits(version, ecl);
  push(0, Math.min(4, capacity - bits.length)); // 終止符
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const dataCodewords = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => {
    if (bit) dataCodewords[i >>> 3] |= 0x80 >>> (i & 7);
  });

  // 分塊 + RS + 交錯
  const numBlocks = NUM_BLOCKS[ecl][version];
  const ecLen = EC_PER_BLOCK[ecl][version];
  const rawCodewords = TOTAL_CODEWORDS[version];
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const divisor = rsDivisor(ecLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dataLen = shortBlockLen - ecLen + (i < numShortBlocks ? 0 : 1);
    const dat = dataCodewords.slice(k, k + dataLen);
    k += dataLen;
    blocks.push({ data: dat, ec: rsRemainder(dat, divisor) });
  }

  const out = new Uint8Array(rawCodewords);
  let n = 0;
  const maxData = shortBlockLen - ecLen + 1;
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.data.length) out[n++] = blk.data[i];
  }
  for (let i = 0; i < ecLen; i++) {
    for (const blk of blocks) out[n++] = blk.ec[i];
  }
  return out;
}

// ── 矩陣 ────────────────────────────────────────────────────────
function alignmentPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = new Uint8Array(this.size * this.size);
    this.isFunction = new Uint8Array(this.size * this.size);
  }
  idx(x, y) {
    return y * this.size + x;
  }
  get(x, y) {
    return this.modules[this.idx(x, y)] === 1;
  }
  set(x, y, dark) {
    this.modules[this.idx(x, y)] = dark ? 1 : 0;
  }
  setFunction(x, y, dark) {
    this.set(x, y, dark);
    this.isFunction[this.idx(x, y)] = 1;
  }
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const x = cx + dx;
      const y = cy + dy;
      if (x >= 0 && x < m.size && y >= 0 && y < m.size) m.setFunction(x, y, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      m.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(m, ecl, mask) {
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = (((data << 10) | rem) ^ 0x5412) >>> 0;

  for (let i = 0; i <= 5; i++) m.setFunction(8, i, getBit(bits, i));
  m.setFunction(8, 7, getBit(bits, 6));
  m.setFunction(8, 8, getBit(bits, 7));
  m.setFunction(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, getBit(bits, i));

  for (let i = 0; i < 8; i++) m.setFunction(m.size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i++) m.setFunction(8, m.size - 15 + i, getBit(bits, i));
  m.setFunction(8, m.size - 8, true); // 固定黑點
}

function drawFunctionPatterns(m, ecl) {
  for (let i = 0; i < m.size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }
  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);

  const positions = alignmentPositions(m.version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === positions.length - 1) || (i === positions.length - 1 && j === 0);
      if (!corner) drawAlignment(m, positions[i], positions[j]);
    }
  }

  drawFormatBits(m, ecl, 0); // 先佔位，選定 mask 後重畫

  if (m.version >= 7) {
    let rem = m.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = ((m.version << 12) | rem) >>> 0;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = m.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      m.setFunction(a, b, bit);
      m.setFunction(b, a, bit);
    }
  }
}

function drawCodewords(m, codewords) {
  let i = 0;
  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳過垂直計時線
    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;
        if (m.isFunction[m.idx(x, y)] || i >= codewords.length * 8) continue;
        m.set(x, y, getBit(codewords[i >>> 3], 7 - (i & 7)));
        i++;
      }
    }
  }
}

const MASK_FN = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(m, mask) {
  const fn = MASK_FN[mask];
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[m.idx(x, y)] && fn(x, y)) m.modules[m.idx(x, y)] ^= 1;
    }
  }
}

/** 遮罩罰分（ISO 18004 §8.8.2） */
function penalty(m) {
  const size = m.size;
  let score = 0;

  const runScore = (line) => {
    let sub = 0;
    let runLen = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) {
        runLen++;
      } else {
        if (runLen >= 5) sub += 3 + (runLen - 5);
        runLen = 1;
      }
    }
    return sub;
  };

  const P1 = [1, 0, 1, 1, 1, 0, 1];
  const hasFinderLike = (line, start) => {
    for (let k = 0; k < 7; k++) if (line[start + k] !== P1[k]) return false;
    const before = line.slice(Math.max(0, start - 4), start);
    const after = line.slice(start + 7, start + 11);
    const quietBefore = before.length >= 4 && before.every((v) => v === 0);
    const quietAfter = after.length >= 4 && after.every((v) => v === 0);
    return quietBefore || quietAfter;
  };

  for (let y = 0; y < size; y++) {
    const row = [];
    const col = [];
    for (let x = 0; x < size; x++) {
      row.push(m.get(x, y) ? 1 : 0);
      col.push(m.get(y, x) ? 1 : 0);
    }
    score += runScore(row) + runScore(col);
    for (let i = 0; i + 7 <= size; i++) {
      if (hasFinderLike(row, i)) score += 40;
      if (hasFinderLike(col, i)) score += 40;
    }
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.get(x, y);
      if (c === m.get(x + 1, y) && c === m.get(x, y + 1) && c === m.get(x + 1, y + 1)) score += 3;
    }
  }

  let dark = 0;
  for (const v of m.modules) dark += v;
  const total = size * size;
  const deviation = Math.abs(dark * 100 - total * 50);
  score += Math.floor(deviation / (total * 5)) * 10;

  return score;
}

/**
 * 產生 QR 矩陣。
 * @param {string} text 內容（UTF-8）
 * @param {{ecl?:'L'|'M'|'Q'|'H', minVersion?:number, maxVersion?:number, mask?:number}} opts
 * @returns {{size:number, version:number, mask:number, modules:Uint8Array, get:(x,y)=>boolean}}
 */
export function encode(text, opts = {}) {
  const ecl = opts.ecl ?? 'M';
  if (!ECL_BITS.hasOwnProperty(ecl)) throw new Error(`E_QR_ECL: ${ecl}`);
  if (typeof text !== 'string' || text.length === 0) throw new Error('E_QR_EMPTY');

  const minVersion = Math.max(MIN_VERSION, opts.minVersion ?? MIN_VERSION);
  const maxVersion = Math.min(MAX_VERSION, opts.maxVersion ?? MAX_VERSION);
  const byteLen = new TextEncoder().encode(text).length;
  const version = pickVersion(byteLen, ecl, minVersion, maxVersion);

  const codewords = buildCodewords(text, version, ecl);
  const m = new Matrix(version);
  drawFunctionPatterns(m, ecl);
  drawCodewords(m, codewords);

  let chosen = opts.mask;
  if (chosen === undefined || chosen === null || chosen < 0) {
    let best = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(m, mask);
      drawFormatBits(m, ecl, mask);
      const score = penalty(m);
      if (score < best) {
        best = score;
        chosen = mask;
      }
      applyMask(m, mask); // 還原（XOR 兩次）
    }
  }
  if (chosen < 0 || chosen > 7) throw new Error(`E_QR_MASK: ${chosen}`);
  applyMask(m, chosen);
  drawFormatBits(m, ecl, chosen);

  return {
    size: m.size,
    version,
    mask: chosen,
    modules: m.modules,
    get: (x, y) => m.get(x, y),
  };
}

/**
 * 輸出 SVG 字串（單色路徑，無外部資源）。
 * @param {string} text
 * @param {{ecl?:string, scale?:number, margin?:number, dark?:string, light?:string, title?:string}} opts
 */
export function toSVG(text, opts = {}) {
  const { ecl = 'M', margin = 4, dark = '#111827', light = '#ffffff', title = 'QR Code' } = opts;
  const qr = encode(text, { ecl });
  const dim = qr.size + margin * 2;

  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.get(x, y)) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" role="img" aria-label="${escapeXml(title)}" shape-rendering="crispEdges">` +
    `<title>${escapeXml(title)}</title>` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}
