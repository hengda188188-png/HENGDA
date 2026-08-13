/** 左欄：QR 卡片 + 專案清單（搜尋／分頁／新增／改名／封存）。 */
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { icon } from '../ui/icons.js';
import { openModal, confirmDialog } from '../ui/overlay.js';
import { openFloatingWindow } from '../ui/floating-window.js';
import { toast, toastOk, toastError } from '../ui/toast.js';
import { copyText } from '../ui/clipboard.js';
import { state, notify } from './state.js';

let els = {};
let projectPage = { rows: [], total: 0, page: 1, pageCount: 1 };
const QR_OPEN_KEY = 'photo-relay:qr-open';
let qrHandle = null;
let qrDetailsOpen = false;

/** 多專案並行時，側欄要看得出「最近誰動過」，不能只有名稱——粗顆粒相對時間即可，不用到秒 */
function relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return t('time.justNow');
  if (min < 60) return t('time.minutesAgo', { n: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hoursAgo', { n: hr });
  return t('time.daysAgo', { n: Math.floor(hr / 24) });
}

/** QR 是短暫任務、但常常要開著同時操作別的東西——用可拖移/可收合浮動視窗，不是 Modal：
 * 不鎖背景、不擋其他操作，收合鈕縮成只剩標題列(跟圖示差不多)，拖了會記住位置直到重整頁面。 */
function setQrOpen(open) {
  if (!open && qrHandle) {
    const current = qrHandle;
    qrHandle = null;
    current.close();
    return;
  }
  if (open && qrHandle) return;
  els.dock.dataset.open = String(open);
  els.toggle.setAttribute('aria-expanded', String(open));
  els.toggleLabel.textContent = open ? t('qr.hide') : t('qr.show');
  localStorage.setItem(QR_OPEN_KEY, open ? '1' : '0');
  if (!open) return;
  renderQr();
  qrDetailsOpen = false;
  els.panelInner.classList.remove('is-details-open');
  const qrWidth = Math.min(340, window.innerWidth - 32);
  const qrHeight = Math.min(300, window.innerHeight - 32);
  qrHandle = openFloatingWindow({
    title: t('qr.title'),
    body: els.panelInner,
    x: Math.max(16, window.innerWidth - qrWidth - 16),
    y: Math.max(16, window.innerHeight - qrHeight - 16),
    w: qrWidth,
    h: qrHeight,
    className: 'fw-win--qr',
    labels: {
      collapse: t('qr.hide'),
      expand: t('qr.show'),
      close: t('common.close'),
    },
    onClose: () => {
      els.panelHost.append(els.panelInner);
      qrHandle = null;
      els.dock.dataset.open = 'false';
      els.toggle.setAttribute('aria-expanded', 'false');
      els.toggleLabel.textContent = t('qr.show');
      localStorage.setItem(QR_OPEN_KEY, '0');
    },
  });
  updateQrDetails();
}

function updateQrDetails() {
  els.panelInner.classList.toggle('is-details-open', qrDetailsOpen);
  els.detailsToggle.setAttribute('aria-expanded', String(qrDetailsOpen));
  els.detailsLabel.textContent = t(qrDetailsOpen ? 'qr.detailsHide' : 'qr.detailsShow');
  if (!qrHandle) return;
  const width = qrDetailsOpen ? Math.min(560, window.innerWidth - 32) : Math.min(340, window.innerWidth - 32);
  const height = qrDetailsOpen ? Math.min(390, window.innerHeight - 32) : Math.min(300, window.innerHeight - 32);
  qrHandle.resize(width, height, { anchor: 'right-bottom' });
}

export function initProjects(root) {
  // QR 入口必須是 body 的直接浮動子層，避免受到 app/grid、側欄或圖片浮層的
  // overflow 與 stacking context 影響；它不參與任何工作台框架排版。
  const qrDock = root.querySelector('[data-role="qr-dock"]');
  if (qrDock?.parentElement !== root) root.append(qrDock);
  els = {
    dock: qrDock,
    toggle: root.querySelector('[data-act="qr-toggle"]'),
    toggleLabel: root.querySelector('[data-role="qr-toggle-label"]'),
    qrBox: root.querySelector('[data-role="qr-box"]'),
    panelHost: root.querySelector('#qr-panel'),
    panelInner: root.querySelector('#qr-panel .qr-panel-inner'),
    detailsToggle: root.querySelector('[data-act="qr-details-toggle"]'),
    detailsLabel: root.querySelector('[data-role="qr-details-label"]'),
    qrUrl: root.querySelector('[data-role="qr-url"]'),
    addressSelect: root.querySelector('[data-role="address"]'),
    copyBtn: root.querySelector('[data-act="copy-url"]'),
    regenBtn: root.querySelector('[data-act="regen-token"]'),
    list: root.querySelector('[data-role="project-list"]'),
    search: root.querySelector('[data-role="project-search"]'),
    showArchived: root.querySelector('[data-role="show-archived"]'),
    newBtn: root.querySelector('[data-act="new-project"]'),
    pager: root.querySelector('[data-role="project-pager"]'),
  };

  els.search.addEventListener('input', debounce(() => {
    state.projectFilters.q = els.search.value.trim();
    state.projectFilters.page = 1;
    loadProjects();
  }, 250));

  els.showArchived.addEventListener('change', () => {
    state.projectFilters.status = els.showArchived.checked ? 'all' : 'active';
    state.projectFilters.page = 1;
    loadProjects();
  });

  els.toggle.addEventListener('click', () => setQrOpen(els.dock.dataset.open !== 'true'));
  els.detailsToggle.addEventListener('click', () => {
    qrDetailsOpen = !qrDetailsOpen;
    updateQrDetails();
  });
  // 記住上次是開還是關：每次進來都要重新點一次很煩
  setQrOpen(localStorage.getItem(QR_OPEN_KEY) === '1');

  els.newBtn.addEventListener('click', openNewProject);
  els.regenBtn.addEventListener('click', regenerateToken);
  els.copyBtn.addEventListener('click', copyUrl);
  els.addressSelect.addEventListener('change', () => {
    state.address = els.addressSelect.value;
    notify('project');
    renderQr();
  });
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function renderAddresses() {
  const addresses = state.bootstrap?.addresses ?? [];
  els.addressSelect.innerHTML = '';
  if (!addresses.length) {
    const option = document.createElement('option');
    option.textContent = t('qr.noLan');
    els.addressSelect.appendChild(option);
    els.addressSelect.disabled = true;
    return;
  }
  els.addressSelect.disabled = false;
  addresses.forEach((a) => {
    const option = document.createElement('option');
    option.value = a.address;
    option.textContent = `${a.address}（${a.iface}）`;
    els.addressSelect.appendChild(option);
  });
  if (!state.address || !addresses.some((a) => a.address === state.address)) {
    state.address = addresses[0].address;
  }
  els.addressSelect.value = state.address;
}

export async function loadProjects() {
  const params = new URLSearchParams({
    q: state.projectFilters.q,
    status: state.projectFilters.status,
    page: String(state.projectFilters.page),
    pageSize: '20',
  });
  projectPage = await api.get(`/api/projects?${params}`);
  renderProjectList();

  if (!state.projectId && projectPage.rows.length) {
    await selectProject(projectPage.rows[0].id);
  } else if (state.projectId) {
    const found = projectPage.rows.find((p) => p.id === state.projectId);
    if (found) {
      state.project = found;
      renderQr();
    }
  }
}

function renderProjectList() {
  els.list.innerHTML = '';
  if (!projectPage.rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty small';
    empty.textContent = t('project.empty');
    els.list.appendChild(empty);
  }
  for (const project of projectPage.rows) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'project-item';
    item.setAttribute('aria-current', String(project.id === state.projectId));

    const name = document.createElement('div');
    name.className = 'nm truncate';
    name.textContent = project.name;

    const sub = document.createElement('div');
    sub.className = 'small muted truncate';
    const bits = [`${project.photoCount} ${t('project.photos')}`];
    if (project.uploadedCount) bits.push(`${project.uploadedCount} ${t('status.uploaded')}`);
    if (project.status === 'archived') bits.push(t('project.archived'));
    sub.textContent = bits.join('｜');

    // 多專案並行時的關鍵線索：這個專案最近什麼時候有人動過（清單本身已依此排序，最新的在最上面）
    const activity = document.createElement('div');
    activity.className = 'small muted truncate project-activity';
    activity.textContent = relativeTime(project.updatedAt || project.createdAt);

    item.append(name, sub, activity);
    item.addEventListener('click', () => selectProject(project.id));
    els.list.appendChild(item);
  }
  renderProjectPager();
}

function renderProjectPager() {
  els.pager.innerHTML = '';
  if (projectPage.pageCount <= 1) {
    els.pager.classList.add('hidden');
    return;
  }
  els.pager.classList.remove('hidden');
  const info = document.createElement('span');
  info.className = 'small muted';
  info.textContent = t('gallery.page', { page: projectPage.page, pages: projectPage.pageCount });

  const prev = pagerButton('chevronLeft', t('gallery.prev'), projectPage.page <= 1, () => {
    state.projectFilters.page -= 1;
    loadProjects();
  });
  const next = pagerButton('chevronRight', t('gallery.next'), projectPage.page >= projectPage.pageCount, () => {
    state.projectFilters.page += 1;
    loadProjects();
  });
  els.pager.append(prev, info, next);
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

export async function selectProject(projectId) {
  state.projectId = projectId;
  state.filters.page = 1;
  state.project = projectPage.rows.find((p) => p.id === projectId) ?? (await api.get(`/api/projects/${projectId}`));
  renderProjectList();
  renderQr();
  notify('project');
}

export async function refreshCurrentProject() {
  if (!state.projectId) return;
  try {
    state.project = await api.get(`/api/projects/${state.projectId}`);
  } catch {
    /* 專案可能剛被刪；忽略 */
  }
}

function renderQr() {
  if (els.dock?.dataset.open !== 'true') return; // 收合狀態不浪費資源去畫
  if (!state.project) {
    els.qrBox.innerHTML = '';
    els.qrUrl.textContent = '';
    return;
  }
  const src = `/api/projects/${state.project.id}/qr?address=${encodeURIComponent(state.address)}&v=${state.project.version}`;
  const img = document.createElement('img');
  img.src = src;
  img.alt = t('qr.title');
  img.width = 240;
  img.height = 240;
  els.qrBox.innerHTML = '';
  els.qrBox.appendChild(img);

  const port = state.bootstrap?.settings?.port ?? location.port;
  els.qrUrl.textContent = state.address ? `http://${state.address}:${port}/m/${state.project.token}` : t('qr.noLan');
}

async function copyUrl() {
  const text = els.qrUrl.textContent;
  if (!text) return;
  await copyText(text, t('qr.copied'));
}

async function regenerateToken() {
  if (!state.project) return;
  const ok = await confirmDialog({
    title: t('qr.regen'),
    message: t('qr.regen.confirm'),
    confirmText: t('qr.regen'),
    danger: true,
  });
  if (!ok) return;
  try {
    state.project = await api.post(`/api/projects/${state.project.id}/token`);
    renderQr();
    toastOk(t('qr.regen.ok'));
  } catch (err) {
    toastError(err);
  }
}

function openNewProject() {
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="fld fld-lg" style="margin-bottom:12px">
      <label for="np-name">${t('project.newName')}</label>
      <input id="np-name" type="text" maxlength="60" data-autofocus="1" autocomplete="off">
    </div>
    <div class="fld fld-md" style="margin-bottom:12px">
      <label for="np-owner">${t('project.newOwner')}</label>
      <input id="np-owner" type="text" maxlength="40" list="np-users" autocomplete="off">
      <datalist id="np-users"></datalist>
    </div>
    <div class="fld fld-lg">
      <label for="np-note">${t('project.newNote')}</label>
      <textarea id="np-note" maxlength="500"></textarea>
    </div>
  `;
  const users = state.bootstrap?.users ?? [];
  const datalist = body.querySelector('#np-users');
  users.forEach((u) => {
    const option = document.createElement('option');
    option.value = u.name;
    datalist.appendChild(option);
  });

  const footer = document.createElement('div');
  footer.className = 'ov-actions';
  footer.innerHTML = `<button type="button" class="btn" data-act="cancel">${t('common.cancel')}</button>
    <button type="button" class="btn btn-primary" data-act="save">${t('project.new')}</button>`;

  const modal = openModal({ title: t('project.new'), body, footer, width: 'min(480px, 94vw)' });
  footer.querySelector('[data-act="cancel"]').addEventListener('click', () => modal.close());
  footer.querySelector('[data-act="save"]').addEventListener('click', async () => {
    const name = body.querySelector('#np-name').value.trim();
    if (!name) {
      toastError(`${t('project.newName')}：${t('common.required')}`);
      return;
    }
    try {
      const project = await api.post('/api/projects', {
        name,
        ownerName: body.querySelector('#np-owner').value.trim(),
        note: body.querySelector('#np-note').value.trim(),
      });
      modal.close();
      toastOk(t('project.create.ok'));
      state.projectFilters.q = '';
      els.search.value = '';
      await loadProjects();
      await selectProject(project.id);
      setQrOpen(true); // 新專案第一次自動開啟掃碼面板
    } catch (err) {
      toastError(err);
    }
  });
}

/** 專案設定（改名／說明／封存）——由上方工具列呼叫 */
export function openProjectSettings() {
  if (!state.project) return;
  const project = state.project;
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="fld fld-lg" style="margin-bottom:12px">
      <label for="ps-name">${t('project.newName')}</label>
      <input id="ps-name" type="text" maxlength="60" data-autofocus="1">
    </div>
    <div class="fld fld-lg">
      <label for="ps-note">${t('project.newNote')}</label>
      <textarea id="ps-note" maxlength="500"></textarea>
    </div>
  `;
  body.querySelector('#ps-name').value = project.name;
  body.querySelector('#ps-note').value = project.note;

  const footer = document.createElement('div');
  footer.className = 'ov-actions';
  const archiveLabel = project.status === 'archived' ? t('project.unarchive') : t('project.archive');
  footer.innerHTML = `<button type="button" class="btn btn-danger" data-act="archive">${archiveLabel}</button>
    <span style="flex:1"></span>
    <button type="button" class="btn" data-act="cancel">${t('common.cancel')}</button>
    <button type="button" class="btn btn-primary" data-act="save">${t('common.ok')}</button>`;

  const modal = openModal({ title: t('project.rename'), body, footer, width: 'min(480px, 94vw)' });
  footer.querySelector('[data-act="cancel"]').addEventListener('click', () => modal.close());

  footer.querySelector('[data-act="save"]').addEventListener('click', async () => {
    try {
      state.project = await api.patch(`/api/projects/${project.id}`, {
        name: body.querySelector('#ps-name').value.trim(),
        note: body.querySelector('#ps-note').value.trim(),
        version: project.version,
      });
      modal.close();
      await loadProjects();
      notify('project');
    } catch (err) {
      toastError(err);
    }
  });

  footer.querySelector('[data-act="archive"]').addEventListener('click', async () => {
    try {
      state.project = await api.patch(`/api/projects/${project.id}`, {
        status: project.status === 'archived' ? 'active' : 'archived',
        version: project.version,
      });
      modal.close();
      await loadProjects();
      notify('project');
    } catch (err) {
      toastError(err);
    }
  });
}
