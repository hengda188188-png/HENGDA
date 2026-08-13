/**
 * 電腦端直接貼上／拖放圖片就上傳到目前這個專案。
 *
 * 走的是跟手機一模一樣的那條路（專案 token → 設備報到 → 上傳），
 * 所以電腦也會被當成一台「設備」出現在今日設備面板，歸屬一樣可以指派。
 */
import { t } from '../lib/i18n.js';
import { toast, toastOk, toastError } from '../ui/toast.js';
import { registerDevice, uploadPhoto, imagesFromDataTransfer } from '../lib/uploader.js';
import { state } from './state.js';

let busy = false;
/** 每個專案報到一次就好，不必每張都問 */
const deviceCache = new Map();

async function deviceFor(project) {
  if (deviceCache.has(project.id)) return deviceCache.get(project.id);
  const device = await registerDevice(project.token);
  deviceCache.set(project.id, device.deviceRecordId);
  return device.deviceRecordId;
}

async function handleFiles(files) {
  const project = state.project;
  if (!project?.token) {
    toastError(t('paste.noProject'));
    return;
  }
  if (busy) {
    toastError(t('paste.busy'));
    return;
  }

  const limits = state.bootstrap?.settings;
  if (!limits) return;
  const accepted = files.slice(0, limits.maxFilesPerRequest);
  if (files.length > accepted.length) {
    toastError(t('mobile.tooMany', { max: limits.maxFilesPerRequest, remaining: accepted.length, taken: accepted.length }));
  }

  busy = true;
  let done = 0;
  let failed = 0;
  toast(t('paste.start', { n: accepted.length }), 'info');
  try {
    const deviceRecordId = await deviceFor(project);
    for (const file of accepted) {
      try {
        await uploadPhoto({ token: project.token, deviceRecordId, file, limits });
        done += 1;
      } catch (err) {
        failed += 1;
        toastError(err);
      }
    }
  } catch (err) {
    toastError(err);
  } finally {
    busy = false;
  }
  if (done) toastOk(t('paste.done', { n: done }));
  if (failed) toastError(t('paste.failed', { n: failed }));
  // 上傳完照片會由 SSE 推回來，這裡不必自己重載清單
}

export function initPasteUpload() {
  document.addEventListener('paste', (e) => {
    // 在輸入框裡貼字不該被當成貼圖
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const files = imagesFromDataTransfer(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  });

  // 拖放進來也一起支援：跟貼上是同一件事，多寫這幾行省得使用者再問
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    document.body.dataset.dropping = 'true';
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget) return;
    delete document.body.dataset.dropping;
  });
  document.addEventListener('drop', (e) => {
    const files = imagesFromDataTransfer(e.dataTransfer);
    delete document.body.dataset.dropping;
    if (!files.length) return;
    e.preventDefault();
    handleFiles(files);
  });
}
