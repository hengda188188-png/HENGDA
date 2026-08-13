/**
 * 手機端上傳流程（不需要輸入名字）：
 * 掃碼 → 設備自動報到（裝置識別碼 → 伺服器給 4 碼短碼）→ 選圖
 * → 本機標準化（轉正/縮圖/壓縮）→ 建立紀錄 → PUT 原始位元組（帶進度）→ PUT 縮圖。
 * 一張一張序列上傳，避免手機同時開多條連線把 Wi-Fi 塞爆、也讓進度誠實。
 */
import { api } from '../lib/api.js';
import { applyI18n, t } from '../lib/i18n.js';
import { toastError } from '../ui/toast.js';
import { registerDevice, uploadPhoto, imagesFromDataTransfer } from '../lib/uploader.js';

const token = location.pathname.split('/').filter(Boolean)[1] ?? '';

let context = null;
let device = null;
let queue = [];
let running = false;

const els = {};

async function boot() {
  applyI18n();
  Object.assign(els, {
    projectName: document.querySelector('[data-role="project-name"]'),
    projectNote: document.querySelector('[data-role="project-note"]'),
    deviceCode: document.querySelector('[data-role="device-code"]'),
    deviceState: document.querySelector('[data-role="device-state"]'),
    remaining: document.querySelector('[data-role="remaining"]'),
    queue: document.querySelector('[data-role="queue"]'),
    queueEmpty: document.querySelector('[data-role="queue-empty"]'),
    uploadedTotal: document.querySelector('[data-role="uploaded-total"]'),
    fileInput: document.querySelector('[data-role="file-input"]'),
    cameraInput: document.querySelector('[data-role="camera-input"]'),
    caption: document.querySelector('[data-role="caption"]'),
  });
  els.deviceState.textContent = t('mobile.registering');

  try {
    context = await api.get(`/api/m/${token}/context`);
  } catch (err) {
    els.projectName.textContent = t('mobile.invalidLink');
    toastError(err);
    document.querySelectorAll('button').forEach((b) => (b.disabled = true));
    return;
  }

  els.projectName.textContent = context.project.name;
  els.projectNote.textContent = context.project.note;
  els.remaining.textContent = t('mobile.remaining', { n: context.limits.remaining });

  await checkIn();

  document.querySelector('[data-act="pick"]').addEventListener('click', () => {
    if (!requireDevice()) return;
    els.fileInput.click();
  });
  document.querySelector('[data-act="camera"]').addEventListener('click', () => {
    if (!requireDevice()) return;
    els.cameraInput.click();
  });
  els.fileInput.addEventListener('change', onPick);
  els.cameraInput.addEventListener('change', onPick);

  // 在電腦上開這頁時可以直接貼上或拖放（手機瀏覽器支援的話也一併吃）
  document.addEventListener('paste', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const files = imagesFromDataTransfer(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    enqueue(files);
  });
  document.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    const files = imagesFromDataTransfer(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    enqueue(files);
  });

  // 電腦端指派歸屬後，手機這邊也看得到（回到前景時同步一次）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkIn().catch(() => {});
  });

  await refreshTotal();
}

/** 設備報到：同一天同一專案同一台手機 → 同一筆紀錄 */
async function checkIn() {
  try {
    device = await registerDevice(token);
    renderDevice();
  } catch (err) {
    els.deviceState.textContent = err.message;
    toastError(err);
  }
}

function renderDevice() {
  if (!device) return;
  els.deviceCode.textContent = t('mobile.deviceCode', { code: device.shortCode });
  els.deviceState.textContent = device.label
    ? t('mobile.deviceNamed', { name: device.label })
    : t('mobile.deviceWaiting');
}

function requireDevice() {
  if (device?.deviceRecordId) return true;
  toastError(t('mobile.needDevice'));
  return false;
}

function onPick(e) {
  const files = [...(e.target.files ?? [])];
  e.target.value = '';
  enqueue(files);
}

/** 選檔、拍照、貼上、拖放都走這裡進佇列
 * 備註是選填、批次性的：拍照/選圖當下先打（或留空直接傳），套用到「這一次」選的所有照片；
 * 送出後清空輸入框，避免下一批不相干的照片被誤套上舊備註。
 */
function enqueue(files) {
  if (!files.length) return;
  if (!requireDevice()) return;

  const max = context.limits.maxFilesPerRequest;
  const accepted = files.slice(0, Math.min(max, context.limits.remaining));
  if (files.length > accepted.length) {
    toastError(t('mobile.tooMany', { max, remaining: context.limits.remaining, taken: accepted.length }));
  }

  const note = els.caption?.value.trim() ?? '';
  accepted.forEach((file) => {
    queue.push({
      id: `q${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
      file,
      note,
      status: 'waiting',
      progress: 0,
      previewUrl: URL.createObjectURL(file),
      message: '',
    });
  });
  if (els.caption) els.caption.value = '';
  renderQueue();
  runQueue();
}

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.some((item) => item.status === 'waiting')) {
    const item = queue.find((i) => i.status === 'waiting');
    await uploadOne(item);
  }
  running = false;
  await refreshTotal();
}

async function uploadOne(item) {
  try {
    const result = await uploadPhoto({
      token,
      deviceRecordId: device.deviceRecordId,
      file: item.file,
      note: item.note,
      limits: context.limits,
      onStage: (stage) => {
        item.status = stage;
        item.message = stage === 'processing' ? t('mobile.compressing') : t('mobile.uploading');
        renderQueue();
      },
      onProgress: (ratio) => {
        item.progress = ratio;
        updateProgress(item);
      },
    });

    item.status = 'done';
    item.message = result.fallback ? t('mobile.doneRaw') : t('mobile.done');
    context.limits.remaining = Math.max(0, context.limits.remaining - 1);
    els.remaining.textContent = t('mobile.remaining', { n: context.limits.remaining });
  } catch (err) {
    item.status = 'failed';
    item.message = err.message ?? t('mobile.failed');
    toastError(err);
  }
  renderQueue();
}

function updateProgress(item) {
  const bar = els.queue.querySelector(`[data-item="${item.id}"] [data-role="bar"]`);
  if (bar) bar.style.width = `${Math.round(item.progress * 100)}%`;
}

function renderQueue() {
  els.queueEmpty.classList.toggle('hidden', queue.length > 0);
  els.queue.innerHTML = '';

  [...queue].reverse().forEach((item) => {
    const row = document.createElement('div');
    row.className = 'm-item';
    row.dataset.item = item.id;

    const pic = document.createElement('div');
    pic.className = 'pic';
    const img = document.createElement('img');
    img.src = item.previewUrl;
    img.alt = item.file.name;
    pic.appendChild(img);

    const mid = document.createElement('div');
    mid.style.minWidth = '0';
    const name = document.createElement('div');
    name.className = 'nm';
    name.textContent = item.file.name;
    const status = document.createElement('div');
    status.className = `st ${item.status === 'failed' ? 'err' : item.status === 'done' ? 'ok' : ''}`;
    status.textContent = item.message || t(`mobile.${item.status === 'done' ? 'done' : 'uploading'}`);
    mid.append(name, status);
    if (item.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'small muted truncate';
      noteEl.textContent = item.note;
      mid.appendChild(noteEl);
    }

    if (item.status === 'uploading') {
      const progress = document.createElement('div');
      progress.className = 'progress';
      const bar = document.createElement('i');
      bar.dataset.role = 'bar';
      bar.style.width = `${Math.round(item.progress * 100)}%`;
      progress.appendChild(bar);
      mid.appendChild(progress);
    }

    row.append(pic, mid);

    if (item.status === 'failed') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn btn-sm';
      retry.textContent = t('mobile.retry');
      retry.addEventListener('click', () => {
        item.status = 'waiting';
        item.message = '';
        renderQueue();
        runQueue();
      });
      row.appendChild(retry);
    }

    els.queue.appendChild(row);
  });
}

async function refreshTotal() {
  if (!device?.deviceRecordId) return;
  try {
    const recent = await api.get(`/api/m/${token}/recent?device=${encodeURIComponent(device.deviceRecordId)}`);
    els.uploadedTotal.textContent = t('mobile.uploadedTotal', { n: recent.rows.length });
  } catch {
    /* 統計失敗不影響上傳 */
  }
}

boot();
