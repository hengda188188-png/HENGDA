/** 電腦端入口：載入資料 → 掛畫面 → 訂閱 SSE。 */
import { api, subscribeEvents } from '../lib/api.js';
import { applyI18n, t } from '../lib/i18n.js';
import { toast, toastError } from '../ui/toast.js';
import { state, readUrl, onChange } from './state.js';
import { initProjects, loadProjects, renderAddresses, openProjectSettings, refreshCurrentProject } from './projects.js';
import { initGallery, loadPhotos, renderJob, patchPhotoInGrid, resetSelection } from './gallery.js';
import { initDevices, loadDevices } from './devices.js';
import { syncOpenPhoto } from './viewer.js';
import { initPasteUpload } from './paste-upload.js';

let unsubscribe = null;

async function boot() {
  applyI18n();
  readUrl(); // 初始狀態從網址讀，不先閃預設頁再跳

  const root = document.body;
  initProjects(root);
  initGallery(root);
  initDevices(root, {
    onSelect: (deviceId) => {
      state.filters.device = deviceId;
      state.filters.page = 1;
      loadPhotos();
    },
  });

  document.querySelector('[data-act="project-settings"]').addEventListener('click', openProjectSettings);
  initPasteUpload();

  try {
    state.bootstrap = await api.get('/api/bootstrap');
  } catch (err) {
    toastError(err);
    return;
  }
  state.photos.pageSize = state.bootstrap.settings.pageSize;
  document.querySelector('[data-role="photo-pagesize"]').value = String(state.photos.pageSize);
  renderAddresses();

  await loadProjects();
  await loadPhotos();
  await loadDevices();
  renderProjectHeader();

  onChange((scope) => {
    if (scope === 'photos') return;
    if (scope === 'project' || scope === 'all') {
      renderProjectHeader();
      resetSelection(); // 換專案別帶著上一個專案的勾選
      resubscribe();
      loadPhotos();
      loadDevices();
    }
  });
  resubscribe();

  document.addEventListener('photo:local-update', (e) => patchPhotoInGrid(e.detail));
  document.addEventListener('device:renamed', () => loadPhotos());
  document.addEventListener('photo:local-delete', () => loadPhotos());
  document.addEventListener('photo:local-created', () => loadPhotos());
}

function renderProjectHeader() {
  const title = document.querySelector('[data-role="project-title"]');
  const note = document.querySelector('[data-role="project-note"]');
  const settingsBtn = document.querySelector('[data-act="project-settings"]');
  title.textContent = state.project?.name ?? t('project.empty');
  note.textContent = state.project?.note ?? '';
  settingsBtn.disabled = !state.project;
  document.title = state.project ? `${state.project.name} · ${t('app.name')}` : t('app.name');
}

function renderConnStatus(status) {
  const el = document.querySelector('[data-role="conn-status"]');
  if (!el) return;
  el.dataset.state = status;
  el.querySelector('[data-role="conn-status-label"]').textContent = t(`conn.${status}`);
}

function resubscribe() {
  unsubscribe?.();
  if (!state.projectId) return;
  unsubscribe = subscribeEvents(state.projectId, {
    onStatusChange: renderConnStatus,
    // 斷線重連後整批補一次（多台電腦共用時，漏事件會讓畫面停在舊資料）
    onReconnect: async () => {
      await loadProjects();
      await loadPhotos();
      await loadDevices();
    },
    'photo:created': async (event) => {
      await loadPhotos();
      await loadDevices();
      const who = event.payload?.photo?.uploaderName;
      toast(who ? t('event.uploadedBy', { who }) : t('gallery.total', { n: state.photos.total }), 'ok', 1800);
    },
    'photo:updated': (event) => {
      const photo = event.payload?.photo;
      if (!photo) return;
      syncOpenPhoto(photo);
      if (!patchPhotoInGrid(photo)) loadPhotos();
    },
    'photo:deleted': () => loadPhotos(),
    'project:updated': async () => {
      await refreshCurrentProject();
      renderProjectHeader();
      await loadProjects();
    },
    'project:created': () => loadProjects(),
    'device:seen': () => loadDevices(),
    // 歸屬名稱是照片顯示的「上傳者」來源，改了要連照片一起重取，
    // 否則別台電腦的縮圖會一直停在舊的 #短碼（實測踩過）
    'device:updated': async () => {
      await loadDevices();
      await loadPhotos();
    },
    'drive:progress': (event) => {
      if (event.payload?.job) renderJob(event.payload.job);
    },
  });
}

window.addEventListener('beforeunload', () => unsubscribe?.());
boot();
