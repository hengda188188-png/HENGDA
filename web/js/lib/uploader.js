/**
 * 共用的「一張照片上傳流程」：手機頁與電腦端貼上都走這裡，不要兩邊各寫一份。
 *
 * 流程：本機標準化（EXIF 轉正／縮到最大邊長／產縮圖）→ 建立照片紀錄 → PUT 原始位元組 → PUT 縮圖。
 * 一次一張、序列進行；同時開多條連線只會讓 Wi-Fi 更慢，而且進度會變得不誠實。
 */
import { api } from './api.js';
import { t } from './i18n.js';
import { standardize, formatBytes } from './image.js';
import { deviceId, deviceInfo } from './device.js';

/** 設備報到（同一天同一專案同一台＝同一筆），回傳可用來建立照片的 deviceRecordId */
export async function registerDevice(token) {
  return api.post(`/api/m/${token}/device`, { deviceId: deviceId(), info: deviceInfo() });
}

/** 從剪貼簿或拖放事件中挑出圖片檔（貼上截圖時檔名可能是空的，要補一個） */
export function imagesFromDataTransfer(dataTransfer) {
  const files = [];
  for (const item of dataTransfer?.items ?? []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file || !file.type.startsWith('image/')) continue;
    files.push(file.name ? file : new File([file], t('paste.filename', { stamp: Date.now() }), { type: file.type }));
  }
  if (!files.length) {
    for (const file of dataTransfer?.files ?? []) {
      if (file.type.startsWith('image/')) files.push(file);
    }
  }
  return files;
}

/**
 * 上傳一張照片。
 * @param {{token:string, deviceRecordId:string, file:File, limits:object, note?:string,
 *          onStage?:(stage:'processing'|'uploading')=>void, onProgress?:(ratio:number)=>void}} params
 * @returns {Promise<{photoId:string, fallback:boolean}>}
 */
export async function uploadPhoto({ token, deviceRecordId, file, limits, note, onStage, onProgress }) {
  onStage?.('processing');
  const prepared = await standardize(file, {
    maxEdgePx: limits.maxEdgePx,
    jpegQuality: limits.jpegQuality,
    thumbEdgePx: limits.thumbEdgePx,
  });

  if (prepared.image.size > limits.maxFileBytes) {
    throw new Error(t('mobile.tooBig', {
      size: formatBytes(prepared.image.size),
      limit: formatBytes(limits.maxFileBytes),
    }));
  }

  const created = await api.post(`/api/m/${token}/photos`, {
    deviceRecordId,
    originalFileName: file.name,
    width: prepared.width,
    height: prepared.height,
    note: note || undefined,
  });

  onStage?.('uploading');
  const query = new URLSearchParams({ kind: 'image' });
  if (prepared.width) query.set('w', String(prepared.width));
  if (prepared.height) query.set('h', String(prepared.height));

  await api.putBlob(`/api/m/${token}/photos/${created.photoId}/blob?${query}`, prepared.image, { onProgress });
  if (prepared.thumb) {
    await api.putBlob(`/api/m/${token}/photos/${created.photoId}/blob?kind=thumb`, prepared.thumb);
  }

  return { photoId: created.photoId, fallback: prepared.fallback };
}
