/** 照片：清單、標註、放大取檔、裁切結果回存、刪除、清單 CSV。 */
import path from 'node:path';
import { sendJson, readJsonBody, sendFile, badRequest, notFound } from '../lib/http.mjs';
import { settings } from '../config.mjs';
import * as store from '../store.mjs';
import { receiveImage, removeQuiet } from '../lib/blob.mjs';
import { emit } from '../lib/bus.mjs';
import { safeFileName } from '../lib/security.mjs';

export async function getPhotos({ res, params, query }) {
  sendJson(res, 200, store.listPhotos(params.id, {
    q: query.get('q') ?? '',
    status: query.get('status') ?? 'all',
    device: query.get('device') ?? 'all',
    drive: query.get('drive') ?? 'all',
    sort: query.get('sort') === 'device' ? 'device' : 'time',
    page: Number(query.get('page') ?? 1),
    pageSize: query.get('pageSize'),
  }));
}

export async function getOnePhoto({ res, params }) {
  sendJson(res, 200, store.decoratePhoto(store.requirePhoto(params.id)));
}

export async function patchPhoto({ req, res, params }) {
  const body = await readJsonBody(req);
  const photo = store.decoratePhoto(store.updatePhoto(params.id, body, body.version));
  emit('photo:updated', photo.projectId, { photo });
  sendJson(res, 200, photo);
}

export async function deleteOnePhoto({ res, params }) {
  const photo = await store.deletePhoto(params.id);
  emit('photo:deleted', photo.projectId, { photoId: photo.id });
  sendJson(res, 200, { ok: true, photoId: photo.id });
}

/**
 * 裁切結果回存。原圖永不覆寫（規則 R9）：裁切另存 edited/，可隨時還原。
 * 裁切框座標用 query 帶入，供日後追溯與重現。
 */
/**
 * 儲存編輯結果。兩種模式：
 * - 預設（覆蓋）：存成同一張照片的 edited 版本，原圖永遠保留可還原。
 * - `asNew=1`（另存新照片）：衍生一張新照片，把編輯結果當成它的原圖；來源那張原封不動。
 * 為什麼要兩種：有時候要的是「修正這張」，有時候要的是「保留原始＋另外做一張標註版」。
 */
export async function putEdited({ req, res, params, query }) {
  const source = store.requirePhoto(params.id);
  const asNew = query.get('asNew') === '1';

  const width = Number(query.get('w'));
  const height = Number(query.get('h'));
  const crop = {
    x: Number(query.get('cx')),
    y: Number(query.get('cy')),
    w: Number(query.get('cw')),
    h: Number(query.get('ch')),
    rotate: Number(query.get('rotate') ?? 0),
  };
  const hasCrop = Object.values(crop).every((v) => Number.isFinite(v));
  const size = { w: Number.isFinite(width) ? width : null, h: Number.isFinite(height) ? height : null };

  if (asNew) {
    const created = store.derivePhoto(source.id, { nameSuffix: query.get('suffix') ?? '' });
    const info = await receiveImage(req, store.photoDir(created.projectId, 'original'), created.id, {
      maxBytes: settings().maxFileBytes,
    });
    store.setPhotoBlob(created.id, 'image', { ...info, ...size, at: new Date().toISOString() });
    const fresh = store.decoratePhoto(store.getPhoto(created.id));
    emit('photo:created', fresh.projectId, { photo: fresh });
    sendJson(res, 201, fresh);
    return;
  }

  const dir = store.photoDir(source.projectId, 'edited');
  const previous = source.edited?.file;
  const info = await receiveImage(req, dir, source.id, { maxBytes: settings().maxFileBytes });
  if (previous && previous !== info.file) await removeQuiet(path.join(dir, previous));

  // 記下編輯時間：之後才判斷得出「雲端那份是不是已經過期」
  store.setPhotoBlob(source.id, 'edited', { ...info, ...size, at: new Date().toISOString() });
  const updated = store.decoratePhoto(store.updatePhoto(source.id, { crop: hasCrop ? crop : null }));
  emit('photo:updated', updated.projectId, { photo: updated });
  sendJson(res, 200, updated);
}

/** 管理端補上縮圖（編輯後另存新照片時，前端把它自己產的縮圖送上來） */
export async function putThumb({ req, res, params }) {
  const photo = store.requirePhoto(params.id);
  const info = await receiveImage(req, store.photoDir(photo.projectId, 'thumb'), photo.id, {
    maxBytes: settings().maxFileBytes,
  });
  const updated = store.decoratePhoto(store.setPhotoBlob(photo.id, 'thumb', info));
  emit('photo:updated', updated.projectId, { photo: updated });
  sendJson(res, 200, updated);
}

/** 還原：刪掉裁切版本，回到原圖 */
export async function deleteEdited({ res, params }) {
  const photo = store.requirePhoto(params.id);
  if (photo.edited) {
    await removeQuiet(path.join(store.photoDir(photo.projectId, 'edited'), photo.edited.file));
    store.setPhotoBlob(photo.id, 'edited', null);
  }
  const updated = store.decoratePhoto(store.updatePhoto(photo.id, { crop: null, annotations: null }));
  emit('photo:updated', updated.projectId, { photo: updated });
  sendJson(res, 200, updated);
}

const KIND_DIR = { thumb: 'thumb', image: 'original', edited: 'edited' };

export async function getPhotoFile({ res, params, query }) {
  const photo = store.requirePhoto(params.id);
  const kind = query.get('kind') ?? 'thumb';
  if (!KIND_DIR[kind]) throw badRequest('kind 只能是 thumb / image / edited');

  // 要「顯示用」的圖時，有裁切版就給裁切版
  const resolved = kind === 'image' && query.get('preferEdited') === '1' && photo.edited ? 'edited' : kind;
  const blob = resolved === 'thumb' ? photo.thumb : resolved === 'edited' ? photo.edited : photo.image;
  if (!blob) throw notFound('這張照片還沒有這個版本的檔案');

  await sendFile(res, store.photoDir(photo.projectId, KIND_DIR[resolved]), blob.file, { immutable: true });
}

/** 專案清單 CSV（跟上傳到雲端的那份同源） */
export async function getManifestCsv({ res, params }) {
  const project = store.requireProject(params.id);
  const csv = buildManifestCsv(project);
  // 中文檔名要走 RFC 5987 全編碼，直接塞中文會讓標頭無效（實測 ERR_INVALID_CHAR）
  const fileName = `${safeFileName(project.name)}-清單.csv`;
  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="manifest.csv"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    'cache-control': 'no-store',
  });
  res.end('﻿' + csv);
}

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

export function buildManifestCsv(project) {
  const rows = store.allPhotosOfProject(project.id);
  const header = ['序號', '名稱', '備註', '歸屬', '設備短碼', '設備機型', '日期', '原始檔名', '狀態', '已編輯', '雲端連結', '可編輯共用連結', '上傳時間'];
  const lines = [header.map(csvCell).join(',')];
  rows.forEach((photo, i) => {
    lines.push([
      i + 1,
      photo.name,
      photo.note,
      photo.device?.label ?? '',
      photo.device?.shortCode ?? '',
      photo.device?.model ?? '',
      photo.dateKey ?? '',
      photo.originalFileName,
      { pending: '未確認', confirmed: '已確認', excluded: '已排除' }[photo.status] ?? photo.status,
      photo.edited ? '是' : '否',
      photo.drive?.link ?? '',
      photo.drive?.shareLink ?? '',
      photo.createdAt,
    ].map(csvCell).join(','));
  });
  return lines.join('\r\n');
}
