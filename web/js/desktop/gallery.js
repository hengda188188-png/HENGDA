/**
 * 主區：快搜尋 + 篩選列（狀態／使用者／雲端，各帶筆數）+ 縮圖牆（固定高內捲、可依使用者分組）
 *      + 分頁 + 批次動作（含上傳雲端進度）。
 * UX 原則：篩選條件永遠看得見、數字跟畫面一致、載入用骨架佔位不跳版、常用動作不必開彈窗。
 */
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { icon } from '../ui/icons.js';
import { toast, toastOk, toastError } from '../ui/toast.js';
import { state, notify } from './state.js';
import { openViewer } from './viewer.js';
import { copyText } from '../ui/clipboard.js';
import { formatBytes, decodeImage } from '../lib/image.js';
import { openEditor } from '../ui/editor.js';

/**
 * 圖片載入失敗（檔案遺失/404）不留空白框——換成跟「沒有縮圖資料」同一套 icon+文字提示。
 * 禁止空白無用框架設計規範：任何 <img> 只要有機會 404（縮圖/大圖/任何遠端資源),都要接 onerror 掛回退占位,
 * 不能讓瀏覽器預設的空白/破圖示直接晾在固定尺寸容器裡。
 */
function appendImgWithFallback(container, src, alt) {
  const img = document.createElement('img');
  img.src = src;
  img.alt = alt;
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    // 只拔掉這張壞圖、補回退占位——不用 innerHTML 整個清空 container(會連累之後才插入的其他子節點,例如 thumbCard 的 surface 按鈕)
    img.remove();
    const fallback = document.createElement('span');
    fallback.className = 'img-fallback-icon';
    fallback.innerHTML = icon('image');
    container.appendChild(fallback);
    const hint = document.createElement('span');
    hint.className = 'flag';
    hint.textContent = t('gallery.fileMissing');
    container.appendChild(hint);
  }, { once: true });
  container.appendChild(img);
  return img;
}

let els = {};
let loading = false;
/** 使用者勾選要上傳的照片（跨頁保留，換專案才清空） */
const selected = new Set();

const STATUS_CHIPS = [
  { value: 'all', label: 'status.all', countKey: 'all' },
  { value: 'pending', label: 'status.pending', countKey: 'pending' },
  { value: 'confirmed', label: 'status.confirmed', countKey: 'confirmed' },
  { value: 'excluded', label: 'status.excluded', countKey: 'excluded' },
];

const DRIVE_CHIPS = [
  { value: 'all', label: 'status.all' },
  { value: 'uploaded', label: 'filter.driveUploaded', countKey: 'uploaded' },
  { value: 'pending', label: 'filter.drivePending' },
];

export function initGallery(root) {
  els = {
    search: root.querySelector('[data-role="photo-search"]'),
    searchClear: root.querySelector('[data-act="clear-search"]'),
    searchHint: root.querySelector('[data-role="search-hint"]'),
    statusChips: root.querySelector('[data-role="status-chips"]'),
    deviceChips: root.querySelector('[data-role="device-chips"]'),
    driveChips: root.querySelector('[data-role="drive-chips"]'),
    clearFilters: root.querySelector('[data-act="clear-filters"]'),
    sortToggle: root.querySelector('[data-role="sort-toggle"]'),
    pageSize: root.querySelector('[data-role="photo-pagesize"]'),
    grid: root.querySelector('[data-role="gallery"]'),
    pager: root.querySelector('[data-role="gallery-pager"]'),
    count: root.querySelector('[data-role="gallery-count"]'),
    confirmAll: root.querySelector('[data-act="confirm-page"]'),
    csv: root.querySelector('[data-act="download-csv"]'),
    actionBar: root.querySelector('.action-bar'),
    selectCount: root.querySelector('[data-role="select-count"]'),
    uploadSelected: root.querySelector('[data-act="upload-selected"]'),
    uploadSelectedLabel: root.querySelector('[data-role="upload-selected-label"]'),
    uploadAll: root.querySelector('[data-act="upload-all"]'),
    compareSelected: root.querySelector('[data-act="compare-selected"]'),
    copyLinks: root.querySelector('[data-act="copy-links"]'),
    fixLinks: root.querySelector('[data-act="fix-links"]'),
    job: root.querySelector('[data-role="job"]'),
    jobText: root.querySelector('[data-role="job-text"]'),
    jobBar: root.querySelector('[data-role="job-bar"]'),
    jobLink: root.querySelector('[data-role="job-link"]'),
  };

  els.search.value = state.filters.q;
  els.search.placeholder = t('search.placeholder');
  els.search.addEventListener('input', debounce(() => {
    state.filters.q = els.search.value.trim();
    state.filters.page = 1;
    loadPhotos();
  }, 220));
  els.search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.search.value) {
      e.stopPropagation();
      clearSearch();
    }
  });
  els.searchClear.addEventListener('click', clearSearch);

  // 全域快捷鍵：/ 聚焦搜尋（在輸入框裡時不攔）
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (document.querySelector('.ov-backdrop')) return;
    e.preventDefault();
    els.search.focus();
    els.search.select();
  });

  els.clearFilters.addEventListener('click', () => {
    state.filters.q = '';
    state.filters.status = 'all';
    state.filters.device = 'all';
    state.filters.drive = 'all';
    state.filters.page = 1;
    els.search.value = '';
    loadPhotos();
  });

  els.sortToggle.addEventListener('click', () => {
    state.filters.sort = state.filters.sort === 'device' ? 'time' : 'device';
    state.filters.page = 1;
    loadPhotos();
  });

  els.pageSize.addEventListener('change', () => {
    state.photos.pageSize = Number(els.pageSize.value);
    state.filters.page = 1;
    loadPhotos();
  });

  els.confirmAll.addEventListener('click', () => confirmMany(state.photos.rows, els.confirmAll));
  els.uploadSelected.addEventListener('click', () => uploadToDrive({ ids: [...selected] }));
  els.uploadAll.addEventListener('click', () => uploadToDrive({}));
  els.compareSelected.addEventListener('click', openComparison);
  root.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', () => quickPick(btn.dataset.pick));
  });
  els.csv.addEventListener('click', () => {
    if (state.projectId) location.href = `/api/projects/${state.projectId}/manifest.csv`;
  });
  els.copyLinks.addEventListener('click', copyAllLinks);
  els.fixLinks.addEventListener('click', fixShareLinks);
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function clearSearch() {
  els.search.value = '';
  state.filters.q = '';
  state.filters.page = 1;
  els.search.focus();
  loadPhotos();
}

export async function loadPhotos() {
  if (!state.projectId) {
    renderEmpty(t('project.empty'));
    return;
  }
  showSkeleton();
  const params = new URLSearchParams({
    q: state.filters.q,
    status: state.filters.status,
    device: state.filters.device,
    drive: state.filters.drive,
    sort: state.filters.sort,
    page: String(state.filters.page),
    pageSize: String(state.photos.pageSize),
  });
  try {
    state.photos = await api.get(`/api/projects/${state.projectId}/photos?${params}`);
  } catch (err) {
    toastError(err);
    renderEmpty(t('common.error'));
    return;
  } finally {
    loading = false;
  }
  renderFilters();
  renderGrid();
  renderPager();
  renderSelection();
  notify('photos');
  loadJob();
}

function showSkeleton() {
  if (loading) return;
  loading = true;
  els.grid.innerHTML = '';
  const count = Math.min(state.photos.pageSize || 12, 12);
  for (let i = 0; i < count; i++) {
    const box = document.createElement('div');
    box.className = 'skeleton skeleton-card';
    els.grid.appendChild(box);
  }
}

// ── 篩選列 ──────────────────────────────────────────────
function chipButton({ label, count, pressed, onClick, disabled = false }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.setAttribute('aria-pressed', String(pressed));
  btn.disabled = disabled;
  const text = document.createElement('span');
  text.textContent = label;
  btn.appendChild(text);
  if (count !== undefined && count !== null) {
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(count);
    btn.appendChild(n);
  }
  btn.addEventListener('click', onClick);
  return btn;
}

function renderFilters() {
  const { stats, deviceStats } = state.photos;

  els.statusChips.innerHTML = '';
  STATUS_CHIPS.forEach((chip) => {
    els.statusChips.appendChild(chipButton({
      label: t(chip.label),
      count: stats[chip.countKey] ?? 0,
      pressed: state.filters.status === chip.value,
      onClick: () => {
        state.filters.status = chip.value;
        state.filters.page = 1;
        loadPhotos();
      },
    }));
  });

  els.driveChips.innerHTML = '';
  DRIVE_CHIPS.forEach((chip) => {
    els.driveChips.appendChild(chipButton({
      label: t(chip.label),
      count: chip.countKey ? stats[chip.countKey] ?? 0 : undefined,
      pressed: state.filters.drive === chip.value,
      onClick: () => {
        state.filters.drive = chip.value;
        state.filters.page = 1;
        loadPhotos();
      },
    }));
  });

  els.deviceChips.innerHTML = '';
  els.deviceChips.appendChild(chipButton({
    label: t('device.all'),
    count: (deviceStats ?? []).reduce((sum, d) => sum + d.total, 0),
    pressed: state.filters.device === 'all',
    onClick: () => {
      state.filters.device = 'all';
      state.filters.page = 1;
      loadPhotos();
    },
  }));
  (deviceStats ?? []).forEach((d) => {
    els.deviceChips.appendChild(chipButton({
      label: d.displayName,
      count: d.total,
      pressed: state.filters.device === d.id,
      onClick: () => {
        state.filters.device = state.filters.device === d.id ? 'all' : d.id;
        state.filters.page = 1;
        loadPhotos();
      },
    }));
  });

  const hasFilter = state.filters.q || state.filters.status !== 'all' || state.filters.device !== 'all' || state.filters.drive !== 'all';
  els.clearFilters.classList.toggle('hidden', !hasFilter);
  els.searchClear.classList.toggle('hidden', !state.filters.q);
  els.searchHint.classList.toggle('hidden', Boolean(state.filters.q));
  els.sortToggle.setAttribute('aria-pressed', String(state.filters.sort === 'uploader'));
  els.sortToggle.querySelector('span').textContent = state.filters.sort === 'device' ? t('view.uploader') : t('view.time');
  els.count.textContent = state.filters.q
    ? t('search.result', { n: state.photos.total })
    : t('gallery.total', { n: state.photos.total });
}

// ── 縮圖牆 ──────────────────────────────────────────────
function renderEmpty(message) {
  els.grid.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = icon('image');
  const text = document.createElement('p');
  text.textContent = message;
  box.appendChild(text);
  els.grid.appendChild(box);
  els.count.textContent = '';
  els.pager.innerHTML = '';
}

function renderGrid() {
  const { rows, stats } = state.photos;
  if (!rows.length) {
    renderEmpty(stats.projectTotal ? t('gallery.emptyFiltered') : t('gallery.empty'));
    return;
  }

  els.grid.innerHTML = '';
  let lastUploader = null;
  rows.forEach((photo, index) => {
    if (state.filters.sort === 'device' && photo.uploaderName !== lastUploader) {
      lastUploader = photo.uploaderName;
      els.grid.appendChild(groupHeader(photo.uploaderName));
    }
    els.grid.appendChild(thumbCard(photo, index));
  });
}

function groupHeader(uploaderName) {
  const head = document.createElement('div');
  head.className = 'group-head';

  const avatar = document.createElement('span');
  avatar.className = 'av';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = (uploaderName || '?').slice(0, 1);
  avatar.style.cssText = 'width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent-strong);font-size:11px;font-weight:600;border:1px solid var(--accent-border)';

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = uploaderName;

  const groupRows = state.photos.rows.filter((p) => p.uploaderName === uploaderName);
  const count = document.createElement('span');
  count.className = 'small muted';
  count.textContent = t('group.count', { n: groupRows.length });

  const spacer = document.createElement('span');
  spacer.style.flex = '1';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'btn btn-sm';
  confirmBtn.textContent = t('group.confirmAll');
  confirmBtn.addEventListener('click', () => confirmMany(groupRows, confirmBtn));

  head.append(avatar, who, count, spacer, confirmBtn);
  return head;
}

function thumbCard(photo, index) {
  const card = document.createElement('div');
  card.className = 'thumb';
  card.dataset.photoId = photo.id;
  card.dataset.selected = String(selected.has(photo.id));

  const pic = document.createElement('div');
  pic.className = 'pic';

  // 單擊＝看資訊（不放大）；雙擊＝放大。這樣挑照片時不會一直被彈窗打斷
  const surface = document.createElement('button');
  surface.type = 'button';
  surface.className = 'thumb-open';
  surface.setAttribute('aria-label', `${photo.name || photo.originalFileName || t('gallery.unnamed')}`);
  // 縮圖主體單擊就進入大圖＋右側操作面板；批次選取使用角落勾選鈕，避免隱藏的雙擊規則。
  surface.addEventListener('click', () => openViewer(index));

  if (photo.thumb || photo.edited || photo.image) {
    const kind = photo.edited ? 'edited' : photo.thumb ? 'thumb' : 'image';
    appendImgWithFallback(
      pic,
      `/api/photos/${photo.id}/file?kind=${kind}&v=${photo.version}`,
      photo.name || photo.originalFileName || t('gallery.unnamed')
    );
  } else {
    pic.innerHTML = icon('image');
    const hint = document.createElement('span');
    hint.className = 'flag';
    hint.textContent = t('gallery.needThumb');
    pic.appendChild(hint);
  }
  pic.appendChild(surface);

  // 勾選框（要上傳哪幾張）
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'pick';
  pick.innerHTML = icon('check');
  pick.setAttribute('aria-label', t('select.pick'));
  pick.setAttribute('aria-pressed', String(selected.has(photo.id)));
  pick.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelected(photo.id);
  });
  pic.appendChild(pick);

  // 放大鈕（不想用雙擊的人點這個）
  const zoom = document.createElement('button');
  zoom.type = 'button';
  zoom.className = 'zoom';
  zoom.innerHTML = icon('zoom');
  zoom.setAttribute('aria-label', t('select.zoom'));
  zoom.addEventListener('click', (e) => {
    e.stopPropagation();
    openViewer(index);
  });
  pic.appendChild(zoom);

  const quick = document.createElement('div');
  quick.className = 'quick';
  quick.appendChild(quickButton('check', t('quick.confirm'), photo.status === 'confirmed', () =>
    setPhotoStatus(photo, photo.status === 'confirmed' ? 'pending' : 'confirmed')
  ));
  quick.appendChild(quickButton('crop', t('viewer.crop'), false, () => openViewer(index, { edit: true })));
  quick.appendChild(quickButton('cloud', t('batch.uploadOne'), false, () => uploadToDrive({ ids: [photo.id], single: true })));
  if (photo.drive?.shareLink || photo.drive?.link) {
    quick.appendChild(quickButton('link', t('photo.copyLink'), false, () =>
      copyText(photo.drive.shareLink ?? photo.drive.link, t('photo.copied'))
    ));
  }
  pic.appendChild(quick);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.append(
    inlineField({ photo, field: 'name', className: 'thumb-name', placeholder: t('thumb.namePlaceholder'), label: t('viewer.name') }),
    inlineField({ photo, field: 'note', className: 'thumb-note', placeholder: t('thumb.notePlaceholder'), label: t('viewer.note') })
  );

  const info = document.createElement('div');
  info.className = 'thumb-device';
  const who = document.createElement('span');
  who.className = 'truncate';
  who.textContent = photo.uploaderName;
  const code = document.createElement('span');
  code.className = 'mono muted';
  code.textContent = photo.device ? photo.device.shortCode : '';
  info.append(who, code);

  meta.append(info, badgesFor(photo));
  card.append(pic, meta);
  return card;
}

/** 狀態標籤：狀態 + 雲端狀態（含「編輯後待更新」這個最容易被忽略的情況） */
function badgesFor(photo) {
  const badges = document.createElement('div');
  badges.className = 'badges';

  const status = document.createElement('span');
  status.className = `tag tag-${photo.status}`;
  status.textContent = t(`status.${photo.status}`);
  badges.appendChild(status);

  if (photo.cloudStale) {
    const stale = document.createElement('span');
    stale.className = 'tag tag-stale';
    stale.textContent = t('status.cloudStale');
    stale.title = t('status.cloudStaleHint');
    badges.appendChild(stale);
  } else if (photo.drive?.fileId) {
    const uploaded = document.createElement('span');
    uploaded.className = 'tag tag-uploaded';
    uploaded.textContent = t('status.uploaded');
    badges.appendChild(uploaded);
  }

  const date = document.createElement('span');
  date.className = 'small muted';
  date.textContent = photo.dateKey ?? '';
  badges.appendChild(date);
  return badges;
}

// ── 選取與資訊列 ────────────────────────────────────────
function toggleSelected(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  refreshCardState(id);
  renderSelection();
}

function refreshCardState(id) {
  const card = els.grid.querySelector(`[data-photo-id="${id}"]`);
  if (!card) return;
  card.dataset.selected = String(selected.has(id));
  const pick = card.querySelector('.pick');
  if (pick) pick.setAttribute('aria-pressed', String(selected.has(id)));
}

/** 標籤快速選取：一鍵挑出「還沒上雲端」「編輯後待更新」這種常見批次 */
function quickPick(kind) {
  const rows = state.photos.rows;
  if (kind === 'none') selected.clear();
  else if (kind === 'page') rows.forEach((p) => selected.add(p.id));
  else if (kind === 'notUploaded') rows.filter((p) => !p.drive?.fileId).forEach((p) => selected.add(p.id));
  else if (kind === 'stale') rows.filter((p) => p.cloudStale).forEach((p) => selected.add(p.id));
  else if (kind === 'confirmed') rows.filter((p) => p.status === 'confirmed').forEach((p) => selected.add(p.id));
  rows.forEach((p) => refreshCardState(p.id));
  renderSelection();
}

function renderSelection() {
  const n = selected.size;
  els.selectCount.textContent = n ? t('select.count', { n }) : '';
  els.uploadSelectedLabel.textContent = n ? t('batch.uploadSelected', { n }) : t('batch.uploadNothingSelected');
  els.uploadSelected.disabled = n === 0 || state.job?.status === 'running';
  els.compareSelected.disabled = n < 2;
  els.uploadAll.disabled = state.job?.status === 'running';
}

/** 換專案時把選取與檢視狀態清掉，避免帶著上一個專案的選取跑 */
export function resetSelection() {
  selected.clear();
}

/**
 * 縮圖上的就地編輯欄位。
 * Enter 儲存、Esc 還原；失焦也存。存的時候只送有變的欄位，並帶 version 走樂觀鎖。
 */
function inlineField({ photo, field, className, placeholder, label }) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = `thumb-input ${className}`;
  input.value = photo[field] ?? '';
  input.placeholder = placeholder;
  input.maxLength = field === 'name' ? 120 : 1000;
  input.setAttribute('aria-label', `${label}：${photo.originalFileName || photo.id}`);
  input.title = t('thumb.editHint');

  let original = input.value;

  const save = async () => {
    const value = input.value.trim();
    if (value === original) return;
    try {
      const updated = await api.patch(`/api/photos/${photo.id}`, { [field]: value, version: photo.version });
      original = updated[field] ?? '';
      input.value = original;
      Object.assign(photo, updated);
      const at = state.photos.rows.findIndex((p) => p.id === updated.id);
      if (at !== -1) state.photos.rows[at] = updated;
      input.classList.add('saved');
      setTimeout(() => input.classList.remove('saved'), 900);
    } catch (err) {
      if (err.status === 409 && err.extra?.current) {
        Object.assign(photo, err.extra.current);
        original = photo[field] ?? '';
        input.value = original;
        toastError(t('viewer.conflict'));
      } else {
        input.value = original;
        toastError(err);
      }
    }
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // 別讓 / 快捷鍵搶走輸入
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      input.value = original;
      input.blur();
    }
  });
  input.addEventListener('blur', save);
  return input;
}

function quickButton(iconName, label, pressed, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.innerHTML = icon(iconName);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-pressed', String(pressed));
  btn.title = label;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

async function setPhotoStatus(photo, status) {
  try {
    const updated = await api.patch(`/api/photos/${photo.id}`, { status, version: photo.version });
    patchPhotoInGrid(updated);
    renderFilters();
  } catch (err) {
    if (err.status === 409 && err.extra?.current) {
      patchPhotoInGrid(err.extra.current);
      toastError(t('viewer.conflict'));
    } else {
      toastError(err);
    }
  }
}

function renderPager() {
  const { page, pageCount, total, stats } = state.photos;
  els.pager.innerHTML = '';

  const summary = document.createElement('span');
  summary.className = 'small muted';
  summary.textContent = `${t('status.confirmed')} ${stats.confirmed ?? 0}｜${t('status.uploaded')} ${stats.uploaded ?? 0}｜${t('gallery.total', { n: total })}`;

  const spacer = document.createElement('span');
  spacer.className = 'spacer';

  const info = document.createElement('span');
  info.className = 'small';
  info.textContent = t('gallery.page', { page, pages: pageCount });

  const prev = pagerButton('chevronLeft', t('gallery.prev'), page <= 1, () => {
    state.filters.page -= 1;
    loadPhotos();
  });
  const next = pagerButton('chevronRight', t('gallery.next'), page >= pageCount, () => {
    state.filters.page += 1;
    loadPhotos();
  });

  els.pager.append(summary, spacer, prev, info, next);
}

function pagerButton(iconName, label, disabled, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-sm btn-icon';
  btn.innerHTML = icon(iconName);
  btn.setAttribute('aria-label', label);
  btn.disabled = disabled;
  btn.addEventListener('click', onClick);
  return btn;
}

async function confirmMany(rows, button) {
  const targets = rows.filter((p) => p.status !== 'confirmed');
  if (!targets.length) return;
  button.disabled = true;
  let failed = 0;
  for (const photo of targets) {
    try {
      await api.patch(`/api/photos/${photo.id}`, { status: 'confirmed', version: photo.version });
    } catch {
      failed += 1;
    }
  }
  button.disabled = false;
  if (failed) toastError(t('batch.confirmFailed', { n: failed }));
  else toastOk(t('batch.confirmOk', { n: targets.length }));
  await loadPhotos();
}

// ── 雲端上傳 ────────────────────────────────────────────
async function uploadToDrive({ ids = null, single = false } = {}) {
  if (!state.projectId) return;
  els.uploadSelected.disabled = true;
  els.uploadAll.disabled = true;
  try {
    const body = ids?.length ? { photoIds: ids } : {};
    const result = await api.post(`/api/projects/${state.projectId}/drive/upload`, body);
    renderJob(result.job);
    toast(single ? t('batch.uploadingOne') : t('batch.uploading', { done: 0, total: result.job.total }), 'info');
    if (ids?.length) selected.clear();
    renderSelection();
  } catch (err) {
    if (err.code === 'E_DRIVE_SETUP' || err.code === 'E_DRIVE_AUTH') {
      toastError(err.message);
      setTimeout(() => (location.href = '/settings'), 1400);
    } else if (err.code === 'E_NOTHING_TO_UPLOAD') {
      toastError(err.message);
    } else {
      toastError(err);
    }
    renderSelection();
  }
}

/** 把整個專案已上傳照片的「專屬共用連結」整理成一份可貼給別人的清單 */
async function copyAllLinks() {
  if (!state.projectId) return;
  const all = await api.get(`/api/projects/${state.projectId}/photos?pageSize=200`);
  const rows = all.rows.filter((p) => p.drive?.shareLink || p.drive?.link);
  if (!rows.length) {
    toastError(t('batch.noLinks'));
    return;
  }
  const text = rows
    .map((p, i) => `${String(i + 1).padStart(2, '0')}. ${p.name || p.originalFileName || p.id}\n${p.drive.shareLink ?? p.drive.link}`)
    .join('\n\n');
  await copyText(text, t('batch.copiedAll', { n: rows.length }));
}

/** 舊版本傳上去的照片沒有專屬共用權限，這裡一次補齊 */
async function fixShareLinks() {
  if (!state.projectId) return;
  els.fixLinks.disabled = true;
  try {
    const result = await api.post(`/api/projects/${state.projectId}/drive/share`);
    toastOk(t('batch.fixed', { n: result.updated }));
    if (result.errors?.length) toastError(result.errors[0].message);
    await loadPhotos();
  } catch (err) {
    toastError(err);
  } finally {
    els.fixLinks.disabled = false;
  }
}

async function loadJob() {
  if (!state.projectId) return;
  try {
    renderJob(await api.get(`/api/projects/${state.projectId}/drive/job`));
  } catch {
    /* 沒有工作紀錄就算了 */
  }
}

export function renderJob(job) {
  const previousStatus = state.job?.status;
  state.job = job;
  if (!job || job.status === 'idle') {
    els.job.classList.add('hidden');
    renderSelection();
    return;
  }
  els.job.classList.remove('hidden');
  const finished = job.status !== 'running';
  renderSelection();

  const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0;
  els.jobBar.style.width = `${pct}%`;

  if (job.status === 'running') {
    els.jobText.textContent = `${t('batch.uploading', { done: job.done, total: job.total })}${job.currentName ? `　${job.currentName}` : ''}`;
  } else if (job.status === 'done') {
    els.jobText.textContent = t('batch.uploadDone', { done: job.done });
  } else {
    els.jobText.textContent = t('batch.uploadPartial', { done: job.done, failed: job.failed });
  }

  els.jobLink.innerHTML = '';
  if (job.folderLink) {
    const link = document.createElement('a');
    link.href = job.folderLink;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'small';
    link.textContent = t('batch.openFolder');
    els.jobLink.appendChild(link);
  }
  // 共用連結（可編輯）：拿到連結的人都能改，所以旁邊要把風險講明白
  if (job.shareLink) {
    const wrap = document.createElement('span');
    wrap.className = 'share-link';

    const label = document.createElement('span');
    label.className = 'small';
    label.textContent = t('batch.shareLink');

    const link = document.createElement('a');
    link.href = job.shareLink;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'small mono truncate';
    link.style.maxWidth = '260px';
    link.textContent = job.shareLink;

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm btn-icon';
    copy.innerHTML = icon('copy');
    copy.setAttribute('aria-label', t('batch.shareCopy'));
    copy.title = t('batch.shareCopy');
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(job.shareLink);
        toastOk(t('batch.shareCopied'));
      } catch {
        toast(job.shareLink, 'info', 8000);
      }
    });

    const warn = document.createElement('span');
    warn.className = 'small muted';
    warn.textContent = t('batch.shareWarn');

    wrap.append(label, link, copy, warn);
    els.jobLink.appendChild(wrap);
  }
  if (job.errors?.length) {
    const detail = document.createElement('span');
    detail.className = 'small';
    detail.style.color = 'var(--danger)';
    detail.textContent = `　${job.errors[job.errors.length - 1].message}`;
    els.jobLink.appendChild(detail);
  }
  if (finished && previousStatus === 'running') {
    if (job.status === 'done') toastOk(t('batch.uploadDone', { done: job.done }));
    else toastError(t('batch.uploadPartial', { done: job.done, failed: job.failed }));
  }
}

/** SSE：某張照片變動時就地更新，不整頁重畫（避免版面跳動） */
export function patchPhotoInGrid(photo) {
  const index = state.photos.rows.findIndex((p) => p.id === photo.id);
  if (index === -1) return false;
  state.photos.rows[index] = photo;
  const card = els.grid.querySelector(`[data-photo-id="${photo.id}"]`);
  if (card) card.replaceWith(thumbCard(photo, index));
  return true;
}

async function openComparison() {
  const photos = [...selected].map((id) => state.photos.rows.find((row) => row.id === id)).filter(Boolean);
  if (photos.length < 2) {
    toastError(t('compare.needTwo'));
    return;
  }
  try {
    const sources = await Promise.all(photos.map(async (item) => {
      const kind = item.edited ? 'edited' : 'image';
      const response = await fetch(`/api/photos/${item.id}/file?kind=${kind}&v=${item.version}`);
      if (!response.ok) throw new Error(t('gallery.fileMissing'));
      return decodeImage(await response.blob());
    }));
    const composite = await comparisonBlob(photos, sources);
    sources.forEach((source) => source.close?.());
    await openEditor({
      blob: composite,
      onApply: async (result) => {
        const params = new URLSearchParams({
          asNew: '1', suffix: t('compare.suffix'), w: String(result.width), h: String(result.height),
          cx: String(Math.round(result.crop.x)), cy: String(Math.round(result.crop.y)),
          cw: String(Math.round(result.crop.w)), ch: String(Math.round(result.crop.h)), rotate: String(result.rotate),
        });
        const saved = await api.putBlob(`/api/photos/${photos[0].id}/edited?${params}`, result.blob);
        const sourceText = photos.map((item) => item.name || item.originalFileName || item.id).join(' ↔ ');
        await api.patch(`/api/photos/${saved.id}`, {
          name: `${t('compare.title')}：${sourceText}`,
          note: photos.map((item) => t('compare.source', { name: item.name || item.originalFileName || item.id })).join('\n'),
          annotations: result.annotations,
          status: 'confirmed',
          version: saved.version,
        });
        toastOk(t('compare.saved'));
        selected.clear();
        await loadPhotos();
        await uploadToDrive({ ids: [saved.id], single: true });
      },
    });
  } catch (error) {
    toastError(error);
  }
}

async function comparisonBlob(photos, sources) {
  const panelWidth = 600;
  const panelHeight = 460;
  const labelHeight = 56;
  const gap = 16;
  const columns = Math.min(3, Math.ceil(Math.sqrt(photos.length)));
  const rows = Math.ceil(photos.length / columns);
  const canvas = document.createElement('canvas');
  canvas.width = panelWidth * columns + gap * (columns - 1);
  canvas.height = (panelHeight + labelHeight) * rows + gap * (rows - 1);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  sources.forEach((source, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * (panelWidth + gap);
    const y = row * (panelHeight + labelHeight + gap);
    const sw = source.width ?? source.naturalWidth;
    const sh = source.height ?? source.naturalHeight;
    const scale = Math.min(panelWidth / sw, panelHeight / sh);
    const dw = Math.round(sw * scale);
    const dh = Math.round(sh * scale);
    ctx.fillStyle = '#111827';
    ctx.fillRect(x, y, panelWidth, panelHeight);
    ctx.drawImage(source, x + (panelWidth - dw) / 2, y + (panelHeight - dh) / 2, dw, dh);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y + panelHeight, panelWidth, labelHeight);
    ctx.fillStyle = '#1f2937';
    ctx.font = '600 24px system-ui, sans-serif';
    const label = t('compare.source', { name: photos[index].name || photos[index].originalFileName || photos[index].id });
    ctx.fillText(label.slice(0, 34), x + 16, y + panelHeight + 36);
  });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(t('common.error'))), 'image/jpeg', .92));
}
