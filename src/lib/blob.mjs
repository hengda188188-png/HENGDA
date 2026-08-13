/**
 * 二進位檔落地：串流寫入 + 大小上限中途中止 + magic bytes 型別驗證 + 原子改名。
 * 規則 R2/R3/R5：不信任 Content-Type、超限即中止不寫滿磁碟、落地檔名由伺服器決定。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError } from './http.mjs';
import { sniffImageType } from './security.mjs';

/**
 * 把 request 串流寫成一個圖片檔。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} dir 目標資料夾
 * @param {string} baseName 不含副檔名的檔名（由伺服器決定，非使用者提供）
 * @param {{maxBytes:number, verifyImage?:boolean}} opts
 * @returns {Promise<{file:string, bytes:number, mime:string, sha256:string}>}
 */
export async function receiveImage(req, dir, baseName, { maxBytes, verifyImage = true }) {
  await fsp.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `${baseName}.part`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmpPath);

  let bytes = 0;
  let head = Buffer.alloc(0);
  let detected = null;

  const cleanup = async () => {
    out.destroy();
    await fsp.rm(tmpPath, { force: true });
  };

  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        await cleanup();
        throw new HttpError(413, 'E_TOO_LARGE', `檔案超過上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
      }
      if (verifyImage && !detected) {
        head = Buffer.concat([head, chunk]);
        if (head.length >= 12) {
          detected = sniffImageType(head);
          if (!detected) {
            await cleanup();
            throw new HttpError(400, 'E_BAD_TYPE', '不是支援的圖片格式（僅接受 JPEG/PNG/WebP/HEIC）');
          }
        }
      }
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
  } catch (err) {
    await cleanup();
    throw err;
  }

  if (bytes === 0) {
    await cleanup();
    throw new HttpError(400, 'E_EMPTY_FILE', '檔案是空的');
  }
  if (verifyImage && !detected) {
    await cleanup();
    throw new HttpError(400, 'E_BAD_TYPE', '檔案太小，無法辨識圖片格式');
  }

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

  const ext = detected?.ext ?? '.bin';
  const finalName = `${baseName}${ext}`;
  await fsp.rename(tmpPath, path.join(dir, finalName));

  return { file: finalName, bytes, mime: detected?.mime ?? 'application/octet-stream', sha256: hash.digest('hex') };
}

/** 刪除檔案，不存在也不報錯（刪照片時清乾淨，不留孤兒檔） */
export async function removeQuiet(filePath) {
  if (!filePath) return;
  await fsp.rm(filePath, { force: true });
}
