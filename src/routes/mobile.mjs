/**
 * 手機端 API：一律用專案 token 授權（規則 R1）。
 * 手機不需要、也拿不到任何管理端資訊——只能對「自己掃到的那個專案」新增照片。
 */
import { sendJson, readJsonBody, unauthorized, badRequest, HttpError } from '../lib/http.mjs';
import { settings } from '../config.mjs';
import * as store from '../store.mjs';
import { receiveImage } from '../lib/blob.mjs';
import { emit } from '../lib/bus.mjs';
import { safeEqual } from '../lib/security.mjs';

/** token → 專案；不符一律 401，且錯誤訊息不透露專案是否存在 */
function projectFromToken(token) {
  const project = store.getProjectByToken(token);
  if (!project || !safeEqual(project.token, token)) throw unauthorized('這個上傳連結無效或已被重新產生，請重新掃碼');
  if (project.status !== 'active') throw new HttpError(403, 'E_ARCHIVED', '這個專案已封存，無法再上傳');
  return project;
}

export async function getContext({ res, params }) {
  const project = projectFromToken(params.token);
  const s = settings();
  sendJson(res, 200, {
    project: { id: project.id, name: project.name, note: project.note },
    limits: {
      maxEdgePx: s.maxEdgePx,
      jpegQuality: s.jpegQuality,
      thumbEdgePx: s.thumbEdgePx,
      maxFileBytes: s.maxFileBytes,
      maxFilesPerRequest: s.maxFilesPerRequest,
      remaining: Math.max(0, s.maxPhotosPerProject - store.countPhotos(project.id)),
    },
  });
}

/**
 * 設備報到：手機不必輸入名字，只送裝置識別碼與裝置特徵。
 * 瀏覽器拿不到硬體序號（iOS/Android 都禁止），所以用手機端產生的固定 UUID 當識別碼，
 * 伺服器導出好念的 4 碼短碼給電腦端指派歸屬。同一天同一專案同一台 → 同一筆。
 */
export async function postDevice({ req, res, params }) {
  const project = projectFromToken(params.token);
  const body = await readJsonBody(req);
  const device = store.ensureDevice({
    projectId: project.id,
    deviceId: body.deviceId,
    info: { ...(body.info ?? {}), ua: req.headers['user-agent'] ?? body.info?.ua },
  });
  emit('device:seen', project.id, { device });
  sendJson(res, 200, {
    deviceRecordId: device.id,
    shortCode: device.shortCode,
    label: device.label,
    displayName: store.deviceDisplayName(device),
    model: device.model,
    dateKey: device.dateKey,
  });
}

/** 建立照片紀錄 → 回傳 photoId，接著手機再 PUT 兩個檔（image / thumb） */
export async function postPhoto({ req, res, params }) {
  const project = projectFromToken(params.token);
  const body = await readJsonBody(req);
  const photo = store.createPhoto({
    projectId: project.id,
    deviceId: body.deviceRecordId,
    originalFileName: body.originalFileName,
    width: body.width,
    height: body.height,
    note: body.note,
  });
  sendJson(res, 201, { photoId: photo.id, version: photo.version });
}

const KIND_DIR = { image: 'original', thumb: 'thumb' };

/** 原始位元組直傳（不走 multipart，少一整類解析漏洞；也讓進度條精準） */
export async function putBlob({ req, res, params, query }) {
  const project = projectFromToken(params.token);
  const photo = store.requirePhoto(params.photoId);
  if (photo.projectId !== project.id) throw unauthorized('這張照片不屬於本專案');

  const kind = query.get('kind') ?? 'image';
  if (!KIND_DIR[kind]) throw badRequest('kind 只能是 image / thumb');
  if (kind === 'image' && photo.image) throw badRequest('這張照片已經上傳過了', 'E_ALREADY_UPLOADED');

  const info = await receiveImage(req, store.photoDir(project.id, KIND_DIR[kind]), photo.id, {
    maxBytes: settings().maxFileBytes,
  });

  const width = Number(query.get('w'));
  const height = Number(query.get('h'));
  const updated = store.setPhotoBlob(photo.id, kind, {
    ...info,
    ...(kind === 'image' ? { w: Number.isFinite(width) ? width : null, h: Number.isFinite(height) ? height : null } : {}),
  });

  // 圖片本體到齊才通知電腦端顯示（縮圖可能稍後才到）
  const decorated = store.decoratePhoto(updated);
  if (kind === 'image') emit('photo:created', project.id, { photo: decorated });
  else emit('photo:updated', project.id, { photo: decorated });

  sendJson(res, 200, { ok: true, photoId: photo.id, bytes: info.bytes, mime: info.mime });
}

/** 手機端只看「自己這台」傳過什麼 */
export async function getRecent({ res, params, query }) {
  const project = projectFromToken(params.token);
  const deviceRecordId = query.get('device') ?? '';
  const rows = store
    .allPhotosOfProject(project.id)
    .filter((p) => (deviceRecordId ? p.deviceId === deviceRecordId : true))
    .slice(-30)
    .reverse()
    .map((p) => ({ id: p.id, name: p.name, originalFileName: p.originalFileName, hasThumb: Boolean(p.thumb), createdAt: p.createdAt }));
  sendJson(res, 200, { rows, total: store.countPhotos(project.id) });
}
