/** 設定頁 + Google 雲端硬碟授權與上傳工作。 */
import path from 'node:path';
import { sendJson, readJsonBody, badRequest, HttpError } from '../lib/http.mjs';
import { settings, saveSettings, DEFAULT_SETTINGS } from '../config.mjs';
import * as store from '../store.mjs';
import * as drive from '../lib/google-drive.mjs';
import { emit } from '../lib/bus.mjs';
import { safeFileName } from '../lib/security.mjs';
import { buildManifestCsv } from './photos.mjs';
import { log } from '../lib/log.mjs';

// ── 設定 ───────────────────────────────────────────────────────
export async function getSettings({ res }) {
  sendJson(res, 200, { settings: settings(), defaults: DEFAULT_SETTINGS });
}

export async function postSettings({ req, res }) {
  const body = await readJsonBody(req);
  sendJson(res, 200, { settings: saveSettings(body) });
}

// ── 授權 ───────────────────────────────────────────────────────
export async function getStatus({ res }) {
  sendJson(res, 200, drive.driveStatus());
}

export async function postCredentials({ req, res }) {
  const body = await readJsonBody(req);
  sendJson(res, 200, drive.saveCredentials(body));
}

/** 直接匯入 Google 憑證頁下載的 JSON 檔 */
export async function postCredentialsFile({ req, res }) {
  const body = await readJsonBody(req);
  sendJson(res, 200, drive.saveCredentialsFromJson(body.keyFile ?? body, redirectUri()));
}

/**
 * 補建共用連結：已經上傳過、但還沒有專屬共用連結的照片（例如舊版本傳上去的），
 * 一次把權限補齊並回填連結。
 */
export async function postShareLinks({ res, params }) {
  const project = store.requireProject(params.id);
  const photos = store.allPhotosOfProject(project.id).filter((p) => p.drive?.fileId && !p.drive?.shareLink);
  if (!photos.length) {
    sendJson(res, 200, { updated: 0, alreadyDone: store.allPhotosOfProject(project.id).filter((p) => p.drive?.shareLink).length });
    return;
  }
  let updated = 0;
  const errors = [];
  for (const photo of photos) {
    try {
      const shared = await drive.shareFileForEditing(photo.drive.fileId);
      store.setPhotoDrive(photo.id, { ...photo.drive, shareLink: shared.link, shareRole: shared.role });
      emit('photo:updated', project.id, { photo: store.decoratePhoto(store.getPhoto(photo.id)) });
      updated += 1;
    } catch (err) {
      errors.push({ photoId: photo.id, message: err.message });
    }
  }
  sendJson(res, 200, { updated, errors });
}

/** 連線測試：真的傳一個小檔上去再刪掉，確認整條路是通的 */
export async function postTest({ res }) {
  const s = settings();
  const result = await drive.testConnection({
    rootFolderName: s.driveRootFolderName,
    targetFolderId: s.driveTargetFolderId,
  });
  sendJson(res, 200, result);
}

/** OAuth 回導網址一律用 127.0.0.1（Google 只允許 loopback 走 http） */
function redirectUri() {
  return `http://127.0.0.1:${settings().port}/api/drive/callback`;
}

export async function getAuthUrl({ res }) {
  sendJson(res, 200, { url: drive.buildAuthUrl(redirectUri()), redirectUri: redirectUri() });
}

export async function oauthCallback({ res, query }) {
  const error = query.get('error');
  const code = query.get('code');
  let message;
  let ok = false;
  if (error) {
    message = `授權被取消或失敗：${error}`;
    // 失敗也要留痕：不留的話從日誌看不出「使用者根本沒走完」還是「Google 擋掉」
    log.error('Google 授權回導失敗', error, query.get('error_description') ?? '');
  } else if (!code) {
    message = '沒有收到授權碼';
    log.error('Google 授權回導缺少授權碼');
  } else {
    try {
      const status = await drive.exchangeCode(code, redirectUri());
      ok = true;
      message = `已完成授權${status.account ? `（${status.account}）` : ''}，可以關閉這個分頁回到工作台。`;
    } catch (err) {
      message = err.message;
      log.error('Google 授權碼換權杖失敗', err.message);
    }
  }
  log.info('收到 Google 授權回導', ok ? '成功' : '未完成');
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' });
  res.end(
    `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google 授權結果</title>` +
      `<style>body{font-family:system-ui,"Microsoft JhengHei",sans-serif;background:#f6f7f9;color:#1f2937;display:grid;place-items:center;height:100vh;margin:0}` +
      `.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 32px;max-width:440px;text-align:center}` +
      `h1{font-size:18px;margin:0 0 10px}p{margin:0;line-height:1.7;color:#4b5563}</style></head>` +
      `<body><div class="card"><h1>${ok ? '授權成功' : '授權未完成'}</h1><p>${escapeHtml(message)}</p></div></body></html>`
  );
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function postRevoke({ res }) {
  sendJson(res, 200, drive.revoke());
}

/** 匯入服務帳戶金鑰檔（零登入模式） */
export async function postServiceAccount({ req, res }) {
  const body = await readJsonBody(req);
  sendJson(res, 200, drive.saveServiceAccount(body.keyFile ?? body));
}

/** 切換憑證模式：oauth（一次授權）／service（金鑰檔） */
export async function postMode({ req, res }) {
  const body = await readJsonBody(req);
  if (body.mode === 'service') {
    const status = drive.driveStatus();
    if (!status.serviceAccountEmail) throw new HttpError(400, 'E_DRIVE_SETUP', '還沒匯入服務帳戶金鑰檔');
    sendJson(res, 200, status);
    return;
  }
  sendJson(res, 200, body.forget ? drive.removeServiceAccount() : drive.useOAuthMode());
}

export async function postFolderCheck({ req, res }) {
  const body = await readJsonBody(req);
  const id = String(body.folderId ?? '').trim();
  if (!id) {
    saveSettings({ driveTargetFolderId: '' });
    sendJson(res, 200, { cleared: true });
    return;
  }
  const folder = await drive.checkFolder(id);
  saveSettings({ driveTargetFolderId: folder.id });
  sendJson(res, 200, folder);
}

// ── 上傳工作 ────────────────────────────────────────────────────
/** 每個專案同時只能有一個上傳工作（避免重複上傳） */
const jobs = new Map();

export async function getUploadJob({ res, params }) {
  store.requireProject(params.id);
  sendJson(res, 200, jobs.get(params.id) ?? { status: 'idle' });
}

export async function postUploadProject({ req, res, params }) {
  const project = store.requireProject(params.id);
  const body = await readJsonBody(req);

  const existing = jobs.get(project.id);
  if (existing?.status === 'running') throw new HttpError(409, 'E_JOB_RUNNING', '這個專案正在上傳中，請等它跑完');

  const status = drive.driveStatus();
  if (!status.hasCredentials) throw new HttpError(400, 'E_DRIVE_SETUP', '尚未設定 Google 用戶端 ID／密鑰，請先到設定頁完成');
  if (!status.authorized) throw new HttpError(400, 'E_DRIVE_AUTH', '尚未授權 Google 帳號，請先到設定頁按「連結 Google 帳號」');

  const targets = store.photosForUpload(project.id, {
    includeUploaded: Boolean(body.includeUploaded),
    ids: Array.isArray(body.photoIds) ? body.photoIds : null,
  });
  if (!targets.length) {
    throw badRequest(
      Array.isArray(body.photoIds) && body.photoIds.length
        ? '選取的照片都已經是雲端最新版了，不需要重傳'
        : '沒有可上傳的照片：請先把要上傳的照片標記為「已確認」，或直接勾選要傳的張數',
      'E_NOTHING_TO_UPLOAD'
    );
  }

  const job = {
    status: 'running',
    projectId: project.id,
    total: targets.length,
    done: 0,
    failed: 0,
    currentName: '',
    errors: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    folderLink: '',
    shareLink: '',
    shareRole: '',
  };
  jobs.set(project.id, job);
  emit('drive:progress', project.id, { job });

  runUpload(project, targets, job).catch((err) => {
    job.status = 'failed';
    job.finishedAt = new Date().toISOString();
    job.errors.push({ photoId: '', message: err.message });
    log.error('雲端上傳工作失敗', err.message);
    emit('drive:progress', project.id, { job });
  });

  sendJson(res, 202, { started: true, job });
}

async function runUpload(project, targets, job) {
  const s = settings();
  const parentId = s.driveTargetFolderId || (await drive.ensureRootFolder(s.driveRootFolderName));
  const folderId = await drive.ensureFolder(safeFileName(project.name, '未命名專案'), parentId);
  store.updateProject(project.id, { driveFolderId: folderId });
  job.folderLink = `https://drive.google.com/drive/folders/${folderId}`;

  // 產生「知道連結的人可編輯」的共用連結（董事長要求）；失敗不中斷上傳，只記錄原因
  try {
    const shared = await drive.shareFolderForEditing(folderId);
    job.shareLink = shared.link;
    job.shareRole = 'writer';
  } catch (err) {
    job.errors.push({ photoId: '', message: `共用連結建立失敗（照片仍會上傳）：${err.message}` });
    log.error('建立共用連結失敗', err.message);
  }
  emit('drive:progress', project.id, { job });

  const all = store.allPhotosOfProject(project.id);

  for (const raw of targets) {
    const photo = store.decoratePhoto(raw);
    const blob = photo.edited ?? photo.image;
    if (!blob) {
      job.failed += 1;
      job.errors.push({ photoId: photo.id, message: '這張照片沒有實體檔案' });
      emit('drive:progress', project.id, { job });
      continue;
    }
    const kindDir = photo.edited ? 'edited' : 'original';
    const filePath = path.join(store.photoDir(project.id, kindDir), blob.file);
    const seq = String(all.findIndex((p) => p.id === photo.id) + 1).padStart(3, '0');
    const ext = path.extname(blob.file) || '.jpg';
    const baseName = safeFileName(photo.name || photo.originalFileName?.replace(/\.[^.]+$/, '') || photo.id);
    const fileName = `${seq}-${baseName}${ext}`;

    job.currentName = fileName;
    emit('drive:progress', project.id, { job });

    try {
      const uploaded = await drive.uploadFile({
        filePath,
        name: fileName,
        mimeType: blob.mime ?? 'image/jpeg',
        parents: [folderId],
        description: [
          photo.note,
          `歸屬：${photo.uploaderName}`,
          photo.device ? `設備：${photo.device.shortCode}（${photo.device.model}）` : '',
          photo.dateKey ? `日期：${photo.dateKey}` : '',
        ].filter(Boolean).join('\n'),
      });
      const record = {
        fileId: uploaded.id,
        link: uploaded.webViewLink,
        name: uploaded.name,
        at: new Date().toISOString(),
      };
      // 每張圖各自掛一份「知道連結的人可編輯」，這樣才有專屬的分享連結可以單獨給人
      try {
        const shared = await drive.shareFileForEditing(uploaded.id);
        record.shareLink = shared.link;
        record.shareRole = shared.role;
      } catch (err) {
        record.shareError = err.message;
        log.error('建立單張共用連結失敗', uploaded.name, err.message);
      }
      store.setPhotoDrive(photo.id, record);
      job.done += 1;
      emit('photo:updated', project.id, { photo: store.decoratePhoto(store.getPhoto(photo.id)) });
    } catch (err) {
      job.failed += 1;
      job.errors.push({ photoId: photo.id, name: fileName, message: err.message });
      store.setPhotoDrive(photo.id, { error: err.message, at: new Date().toISOString() });
      log.error('照片上傳失敗', fileName, err.message);
    }
    emit('drive:progress', project.id, { job });
  }

  if (settings().uploadCsvManifest) {
    try {
      await drive.uploadText({
        name: `${safeFileName(project.name)}-清單.csv`,
        text: buildManifestCsv(store.getProject(project.id)),
        parents: [folderId],
      });
    } catch (err) {
      job.errors.push({ photoId: '', message: `清單 CSV 上傳失敗：${err.message}` });
    }
  }

  job.currentName = '';
  job.status = job.failed ? 'partial' : 'done';
  job.finishedAt = new Date().toISOString();
  emit('drive:progress', project.id, { job });
  log.info(`專案「${project.name}」上傳完成：成功 ${job.done} / 失敗 ${job.failed}`);
}
