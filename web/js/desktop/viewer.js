/** 放大彈窗：看大圖、左右切換、標註名稱／備註、確認／排除、裁切、刪除。 */
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog } from '../ui/overlay.js';
import { toastOk, toastError } from '../ui/toast.js';
import { openEditor } from '../ui/editor.js';
import { formatBytes, decodeImage } from '../lib/image.js';
import { state } from './state.js';
import { copyText } from '../ui/clipboard.js';

let modal = null;
let index = 0;
let photo = null;
let els = {};
let saveTimer = null;
let saving = false;
let pendingSave = false;

export function openViewer(startIndex, options = {}) {
  index = startIndex;
  photo = state.photos.rows[index];
  if (!photo) return;

  const body = document.createElement('div');
  body.className = 'viewer-grid';
  body.innerHTML = `
    <div class="viewer-stage">
      <button type="button" class="viewer-nav prev" data-act="prev" aria-label="${t('viewer.prev')}">${icon('chevronLeft')}</button>
      <img data-role="image" alt="">
      <div class="viewer-fallback hidden" data-role="image-fallback">${icon('image')}<span>${t('gallery.fileMissing')}</span></div>
      <button type="button" class="viewer-nav next" data-act="next" aria-label="${t('viewer.next')}">${icon('chevronRight')}</button>
    </div>
    <aside class="viewer-side" aria-label="${t('viewer.actionsTitle')}">
      <div class="viewer-side-head">
        <h2>${t('viewer.actionsTitle')}</h2>
        <button type="button" class="btn btn-sm btn-icon" data-act="panel-toggle" aria-label="${t('viewer.panelCollapse')}">${icon('chevronRight')}</button>
      </div>
      <div class="viewer-side-content">
      <section class="viewer-section">
        <h3>${t('viewer.statusSection')}</h3>
        <div class="viewer-status" role="group" aria-label="${t('viewer.statusSection')}">
          <button type="button" class="chip" data-status="pending">${t('status.pending')}</button>
          <button type="button" class="chip" data-status="confirmed">${t('status.confirmed')}</button>
          <button type="button" class="chip" data-status="excluded">${t('status.excluded')}</button>
        </div>
      </section>
      <section class="viewer-section">
        <h3>${t('viewer.infoSection')}</h3>
      <div class="fld fld-lg">
        <label for="vw-name">${t('viewer.name')}</label>
        <input id="vw-name" type="text" maxlength="120" data-role="name" data-i18n-placeholder="viewer.namePlaceholder" data-autofocus="1">
      </div>
      <div class="fld fld-lg">
        <label for="vw-note">${t('viewer.note')}</label>
        <textarea id="vw-note" maxlength="1000" rows="4" data-role="note" data-i18n-placeholder="viewer.notePlaceholder"></textarea>
      </div>
      </section>
      <section class="viewer-section">
        <h3>${t('viewer.editSection')}</h3>
      <div class="viewer-actions">
        <button type="button" class="btn btn-sm btn-primary" data-act="crop">${icon('crop')}<span>${t('viewer.crop')}</span></button>
        <button type="button" class="btn btn-sm hidden" data-act="revert">${icon('refresh')}<span>${t('crop.revert')}</span></button>
      </div>
      </section>
      <section class="viewer-section viewer-section-meta">
        <h3>${t('viewer.cloudSection')}</h3>
      <div class="viewer-meta" data-role="meta"></div>
      <div data-role="drive"></div>
      </section>
      <div class="viewer-side-footer">
        <button type="button" class="btn btn-sm btn-danger" data-act="delete">${icon('trash')}<span>${t('viewer.delete')}</span></button>
        <span data-role="saved" class="small muted" aria-live="polite"></span>
      </div>
      </div>
    </aside>
  `;

  els = {
    image: body.querySelector('[data-role="image"]'),
    imageFallback: body.querySelector('[data-role="image-fallback"]'),
    name: body.querySelector('[data-role="name"]'),
    note: body.querySelector('[data-role="note"]'),
    meta: body.querySelector('[data-role="meta"]'),
    drive: body.querySelector('[data-role="drive"]'),
    saved: body.querySelector('[data-role="saved"]'),
    prev: body.querySelector('[data-act="prev"]'),
    next: body.querySelector('[data-act="next"]'),
    statusButtons: [...body.querySelectorAll('[data-status]')],
    side: body.querySelector('.viewer-side'),
    panelToggle: body.querySelector('[data-act="panel-toggle"]'),
    crop: body.querySelector('[data-act="crop"]'),
    revert: body.querySelector('[data-act="revert"]'),
    delete: body.querySelector('[data-act="delete"]'),
  };
  els.name.placeholder = t('viewer.namePlaceholder');
  els.note.placeholder = t('viewer.notePlaceholder');
  // 檔案 404（切換照片時常見:資料還在、實體檔不在）不留破圖示——切成 icon+文字提示；換下一張圖片先收起來，等新圖真的載入/失敗再決定
  els.image.addEventListener('error', () => {
    els.image.classList.add('hidden');
    els.imageFallback.classList.remove('hidden');
  });
  els.image.addEventListener('load', () => {
    els.image.classList.remove('hidden');
    els.imageFallback.classList.add('hidden');
  });

  modal = openModal({
    title: '',
    body,
    width: 'min(1180px, 96vw)',
    height: 'min(760px, 92vh)',
    variant: 'viewer',
    onClose: () => {
      flushSave();
      modal = null;
    },
  });

  els.prev.addEventListener('click', () => move(-1));
  els.next.addEventListener('click', () => move(1));
  els.name.addEventListener('input', scheduleSave);
  els.note.addEventListener('input', scheduleSave);
  els.name.addEventListener('blur', flushSave);
  els.note.addEventListener('blur', flushSave);
  els.statusButtons.forEach((button) => button.addEventListener('click', () => setStatus(button.dataset.status)));
  els.panelToggle.addEventListener('click', toggleSidePanel);
  els.crop.addEventListener('click', startEdit);
  els.revert.addEventListener('click', revertEdit);
  els.delete.addEventListener('click', removePhoto);

  modal.element.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') move(-1);
    if (e.key === 'ArrowRight') move(1);
  });

  render();
  if (options.edit) startEdit();
}

function move(delta) {
  const next = index + delta;
  if (next < 0 || next >= state.photos.rows.length) return;
  flushSave();
  index = next;
  photo = state.photos.rows[index];
  render();
}

/**
 * @param {{force?:boolean}} options force=true 才會覆寫使用者正在編輯的欄位（只有 409 衝突時用）。
 * 不這樣做的話，自動儲存回來的資料會把「打到一半的字」蓋掉（實測踩過：輸入被吃掉前兩個字）。
 */
function render(options = {}) {
  if (!photo || !modal) return;
  const kind = photo.edited ? 'edited' : 'image';
  els.image.classList.remove('hidden');
  els.imageFallback.classList.add('hidden');
  els.image.src = `/api/photos/${photo.id}/file?kind=${kind}&v=${photo.version}`;
  els.image.alt = photo.name || photo.originalFileName || t('gallery.unnamed');
  setFieldValue(els.name, photo.name, options.force);
  setFieldValue(els.note, photo.note, options.force);

  els.prev.disabled = index === 0;
  els.next.disabled = index >= state.photos.rows.length - 1;

  els.statusButtons.forEach((button) => {
    const active = button.dataset.status === photo.status;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('is-active', active);
  });
  els.revert.classList.toggle('hidden', !photo.edited);

  const blob = photo.edited ?? photo.image;
  const size = blob ? formatBytes(blob.bytes) : '-';
  const dimension = blob?.w && blob?.h ? `${blob.w}×${blob.h}` : '';
  const deviceLine = photo.device
    ? `${t('device.of', { model: photo.device.model, code: photo.device.shortCode })}｜${photo.dateKey ?? ''}`
    : '';
  els.meta.textContent = [
    t('viewer.meta', { uploader: photo.uploaderName, time: new Date(photo.createdAt).toLocaleString(), size }),
    dimension,
    deviceLine,
    photo.edited ? t('viewer.edited') : '',
    photo.annotations?.length ? t('edit.annotationCount', { n: photo.annotations.length }) : '',
  ].filter(Boolean).join('｜');

  els.drive.innerHTML = '';
  if (photo.drive?.link) {
    const box = document.createElement('div');
    box.className = 'share-box';

    const label = document.createElement('div');
    label.className = 'small muted';
    label.textContent = photo.drive.shareLink ? t('photo.shareLink') : t('photo.noShareLink');

    const url = document.createElement('input');
    url.type = 'text';
    url.readOnly = true;
    url.className = 'mono';
    url.value = photo.drive.shareLink ?? photo.drive.link;
    url.setAttribute('aria-label', t('photo.shareLink'));
    url.addEventListener('focus', () => url.select());

    const actions = document.createElement('div');
    actions.className = 'viewer-actions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-sm';
    copy.innerHTML = `${icon('copy')}<span>${t('photo.copyLink')}</span>`;
    copy.addEventListener('click', () => copyText(url.value, t('photo.copied')));

    const open = document.createElement('a');
    open.className = 'btn btn-sm';
    open.href = photo.drive.link;
    open.target = '_blank';
    open.rel = 'noopener';
    open.textContent = t('photo.openInDrive');

    actions.append(copy, open);
    box.append(label, url, actions);
    els.drive.appendChild(box);
  } else if (photo.drive?.error) {
    const err = document.createElement('span');
    err.className = 'small';
    err.style.color = 'var(--danger)';
    err.textContent = photo.drive.error;
    els.drive.appendChild(err);
  }
}

function toggleSidePanel() {
  const collapsed = els.side.classList.toggle('is-collapsed');
  els.panelToggle.setAttribute('aria-label', t(collapsed ? 'viewer.panelExpand' : 'viewer.panelCollapse'));
  els.panelToggle.innerHTML = icon(collapsed ? 'chevronLeft' : 'chevronRight');
}

function setFieldValue(el, value, force = false) {
  if (!force && document.activeElement === el) return; // 使用者正在打字，不要蓋掉
  if (el.value !== value) el.value = value;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  els.saved.textContent = '';
  saveTimer = setTimeout(flushSave, 600);
}

/** 同一時間只跑一次儲存，避免兩個請求互相把 version 打成 409 */
async function flushSave() {
  clearTimeout(saveTimer);
  if (!photo || !modal) return;
  if (saving) {
    pendingSave = true;
    return;
  }
  const name = els.name.value.trim();
  const note = els.note.value.trim();
  if (name === photo.name && note === photo.note) return;

  saving = true;
  try {
    await patch({ name, note });
  } finally {
    saving = false;
    if (pendingSave) {
      pendingSave = false;
      await flushSave();
    }
  }
}

async function setStatus(status) {
  if (status === photo.status) return;
  await patch({ status });
}

/** 統一走樂觀鎖；409 就把最新內容拉回來（規則 R6 的使用者面處理） */
async function patch(fields) {
  const target = photo;
  try {
    const updated = await api.patch(`/api/photos/${target.id}`, { ...fields, version: target.version });
    replacePhoto(updated);
    els.saved.textContent = t('viewer.saved');
    setTimeout(() => {
      if (els.saved) els.saved.textContent = '';
    }, 1500);
  } catch (err) {
    if (err.status === 409 && err.extra?.current) {
      replacePhoto(err.extra.current, { force: true }); // 衝突時以伺服器為準，並明確告知
      toastError(t('viewer.conflict'));
    } else {
      toastError(err.message ?? t('viewer.saveFailed'));
    }
  }
}

function replacePhoto(updated, options = {}) {
  const at = state.photos.rows.findIndex((p) => p.id === updated.id);
  if (at !== -1) state.photos.rows[at] = updated;
  if (photo?.id === updated.id) {
    photo = updated;
    render(options);
  }
  document.dispatchEvent(new CustomEvent('photo:local-update', { detail: updated }));
}

/** 一律拿「原圖」進編輯器：標註與裁切都相對原圖，重編輯不會一層疊一層越裁越糊 */
async function startEdit() {
  const source = `/api/photos/${photo.id}/file?kind=image&v=${photo.version}`;
  const target = photo;
  try {
    const res = await fetch(source);
    if (!res.ok) throw new Error(t('common.error'));
    const blob = await res.blob();
    await openEditor({
      blob,
      annotations: target.annotations ?? [],
      rotate: target.crop?.rotate ?? 0,
      onApply: async (result) => {
        const params = new URLSearchParams({
          w: String(result.width),
          h: String(result.height),
          cx: String(Math.round(result.crop.x)),
          cy: String(Math.round(result.crop.y)),
          cw: String(Math.round(result.crop.w)),
          ch: String(Math.round(result.crop.h)),
          rotate: String(result.rotate),
        });
        if (result.saveAsNew) {
          params.set('asNew', '1');
          params.set('suffix', t('edit.suffix'));
        }

        const saved = await api.putBlob(`/api/photos/${target.id}/edited?${params}`, result.blob);

        if (result.saveAsNew) {
          // 新照片要自己的縮圖，不然縮圖牆會去載完整大圖
          const thumb = await makeThumb(result.blob);
          if (thumb) await api.putBlob(`/api/photos/${saved.id}/thumb`, thumb).catch(() => {});
          await api.patch(`/api/photos/${saved.id}`, { annotations: result.annotations, version: saved.version + 1 })
            .catch(() => {}); // 標註存不進去不影響圖片本身
          toastOk(t('edit.savedAsNew'));
          document.dispatchEvent(new CustomEvent('photo:local-created'));
          modal?.close();
          return;
        }

        // 標註以向量形式另存，下次打開編輯器還能繼續改（不是只把像素燒進圖裡）
        const withMarks = await api.patch(`/api/photos/${target.id}`, {
          annotations: result.annotations,
          version: saved.version,
        });
        replacePhoto(withMarks);
        toastOk(t('edit.saved'));
      },
    });
  } catch (err) {
    toastError(err);
  }
}

async function revertEdit() {
  try {
    const updated = await api.del(`/api/photos/${photo.id}/edited`);
    replacePhoto(updated);
    toastOk(t('crop.reverted'));
  } catch (err) {
    toastError(err);
  }
}

async function removePhoto() {
  const ok = await confirmDialog({
    title: t('viewer.delete'),
    message: t('viewer.delete.confirm'),
    confirmText: t('viewer.delete'),
    danger: true,
  });
  if (!ok) return;
  try {
    await api.del(`/api/photos/${photo.id}`);
    modal.close();
    document.dispatchEvent(new CustomEvent('photo:local-delete', { detail: { id: photo.id } }));
  } catch (err) {
    toastError(err);
  }
}

/** 另存新照片時順手做一張縮圖，讓縮圖牆不用載完整大圖 */
async function makeThumb(blob, edge = 512) {
  try {
    const source = await decodeImage(blob);
    const w = source.width ?? source.naturalWidth;
    const h = source.height ?? source.naturalHeight;
    const scale = Math.min(1, edge / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
    source.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  } catch {
    return null;
  }
}

/** 外部（SSE）更新目前開著的照片 */
export function syncOpenPhoto(updated) {
  if (modal && photo?.id === updated.id) {
    photo = updated;
    render();
  }
}
