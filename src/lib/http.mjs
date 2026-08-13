/** HTTP 共用件：統一回應格式、JSON body 解析、靜態檔、速率限制。 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { settings } from '../config.mjs';
import { log } from './log.mjs';

/** 統一成功格式 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** 統一錯誤格式：{ error: { code, message } } */
export function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } });
}

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, code = 'E_VALIDATION') => new HttpError(400, code, msg);
export const notFound = (msg = '找不到資源') => new HttpError(404, 'E_NOT_FOUND', msg);
export const unauthorized = (msg = '授權碼不正確') => new HttpError(401, 'E_UNAUTHORIZED', msg);
export const conflict = (msg, extra) => new HttpError(409, 'E_CONFLICT', msg, extra);

const JSON_BODY_LIMIT = 1024 * 512;

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_BODY_LIMIT) throw new HttpError(413, 'E_TOO_LARGE', '請求內容過大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('JSON 格式錯誤');
  }
}

// ── 速率限制（記憶體內滑動視窗，單機工具夠用）─────────────────
const buckets = new Map();

export function rateLimit(req) {
  const limit = settings().writeRatePerMinute;
  const key = clientIp(req);
  const now = Date.now();
  const windowStart = now - 60_000;
  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 500) {
    for (const [k, v] of buckets) if (!v.some((t) => t > windowStart)) buckets.delete(k);
  }
  if (hits.length > limit) {
    throw new HttpError(429, 'E_RATE_LIMIT', `請求太頻繁，每分鐘上限 ${limit} 次，請稍候再試`);
  }
}

export function clientIp(req) {
  return (req.socket?.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

/**
 * 送出實體檔案。baseDir 之外的路徑一律拒絕（防路徑穿越）。
 */
export async function sendFile(res, baseDir, relativePath, { download = null, immutable = false } = {}) {
  const target = path.resolve(baseDir, '.' + path.sep + relativePath.replace(/^[/\\]+/, ''));
  const base = path.resolve(baseDir);
  if (target !== base && !target.startsWith(base + path.sep)) {
    sendError(res, 403, 'E_FORBIDDEN', '路徑不允許');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    sendError(res, 404, 'E_NOT_FOUND', '檔案不存在');
    return;
  }
  const headers = {
    'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
    'content-length': stat.size,
    'x-content-type-options': 'nosniff',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(download)}"`;
  res.writeHead(200, headers);
  const stream = fs.createReadStream(target);
  stream.on('error', (err) => {
    log.error('sendFile stream', err.message);
    res.destroy();
  });
  stream.pipe(res);
}

/** 把 URL 拆成 pathname + query（不解析 hash） */
export function parseUrl(req) {
  const url = new URL(req.url, 'http://localhost');
  return { pathname: decodeURIComponent(url.pathname), query: url.searchParams };
}
