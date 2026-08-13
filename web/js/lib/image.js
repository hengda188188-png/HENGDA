/**
 * 前端影像處理（手機端標準化 + 電腦端裁切輸出）。
 * 在瀏覽器做，伺服器就不必背 sharp 這類原生相依（零依賴後端）。
 */
import { t } from './i18n.js';

/** 讀成點陣圖，EXIF 方向轉正（規則 R10：直式手機照不可躺著） */
export async function decodeImage(fileOrBlob) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(fileOrBlob, { imageOrientation: 'from-image' });
    } catch {
      /* 有些瀏覽器不支援 options，往下走備援 */
    }
    try {
      return await createImageBitmap(fileOrBlob);
    } catch {
      /* HEIC 等格式解不了 → 備援也會失敗 */
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(fileOrBlob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t('error.decode')));
    };
    img.src = url;
  });
}

const sizeOf = (source) => ({
  width: source.width ?? source.naturalWidth,
  height: source.height ?? source.naturalHeight,
});

function drawTo(source, targetW, targetH, sx = 0, sy = 0, sw = null, sh = null) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(targetW));
  canvas.height = Math.max(1, Math.round(targetH));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const { width, height } = sizeOf(source);
  ctx.drawImage(source, sx, sy, sw ?? width, sh ?? height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

const toBlob = (canvas, quality) =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('error.encode')))), 'image/jpeg', quality);
  });

/**
 * 手機端標準化：縮到最大邊長內、轉 JPEG、順便產縮圖。
 * 解不開的格式（例如某些 HEIC）→ 回 { fallback:true }，改直傳原檔。
 */
export async function standardize(file, { maxEdgePx, jpegQuality, thumbEdgePx }) {
  let source;
  try {
    source = await decodeImage(file);
  } catch {
    return { fallback: true, image: file, thumb: null, width: null, height: null };
  }
  const { width, height } = sizeOf(source);
  const scale = Math.min(1, maxEdgePx / Math.max(width, height));
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);

  const image = await toBlob(drawTo(source, outW, outH), jpegQuality);

  const thumbScale = Math.min(1, thumbEdgePx / Math.max(width, height));
  const thumb = await toBlob(drawTo(source, Math.round(width * thumbScale), Math.round(height * thumbScale)), 0.82);

  source.close?.();
  return { fallback: false, image, thumb, width: outW, height: outH };
}

/**
 * 電腦端裁切輸出。
 * @param {Blob} blob 來源圖
 * @param {{x:number,y:number,w:number,h:number}} rect 來源像素座標
 * @param {number} rotate 0/90/180/270（先旋轉再裁）
 */
export async function cropToBlob(blob, rect, rotate = 0, quality = 0.92) {
  const source = await decodeImage(blob);
  const rotated = rotate % 360 === 0 ? source : rotateSource(source, rotate);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.round(rect.w));
  const h = Math.max(1, Math.round(rect.h));
  const canvas = drawTo(rotated, w, h, x, y, w, h);
  const out = await toBlob(canvas, quality);
  source.close?.();
  return { blob: out, width: canvas.width, height: canvas.height };
}

/** 旋轉來源，回傳 canvas（可再當 drawImage 來源） */
export function rotateSource(source, degrees) {
  const { width, height } = sizeOf(source);
  const rad = (degrees % 360) * Math.PI / 180;
  const swap = degrees % 180 !== 0;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? height : width;
  canvas.height = swap ? width : height;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(source, -width / 2, -height / 2);
  return canvas;
}

export const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
