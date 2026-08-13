/**
 * 今日上傳設備面板：手機掃碼報到後就會出現在這裡（即使還沒傳照片），
 * 直接在這裡打名字＝指派歸屬。歸屬只綁「這個專案的今天」，明天或換專案要重新指派。
 */
import { api } from '../lib/api.js';
import { t } from '../lib/i18n.js';
import { toastOk, toastError } from '../ui/toast.js';
import { state } from './state.js';

let els = {};
let onSelect = null;
let rows = [];
let dateKey = '';
/** 'today' = 只看今天（歸屬只對當天有效）；'all' = 回頭查過去幾天誰傳的 */
let dateScope = 'today';

export function initDevices(root, handlers = {}) {
  els = {
    list: root.querySelector('[data-role="device-list"]'),
    total: root.querySelector('[data-role="device-total"]'),
    hint: root.querySelector('[data-role="device-hint"]'),
  };
  onSelect = handlers.onSelect;
  els.hint.textContent = t('device.scopeHint');

  root.querySelectorAll('[data-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dateScope = btn.dataset.date;
      root.querySelectorAll('[data-date]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.date === dateScope)));
      loadDevices();
    });
  });
}

export async function loadDevices() {
  if (!state.projectId) {
    rows = [];
    render();
    return;
  }
  try {
    const data = await api.get(`/api/projects/${state.projectId}/devices?date=${dateScope}`);
    rows = data.rows;
    dateKey = data.dateKey;
  } catch (err) {
    toastError(err);
    rows = [];
  }
  render();
}

function render() {
  if (!els.list) return;
  els.list.innerHTML = '';
  els.total.textContent = dateScope === 'all' ? t('device.dateAll') : dateKey ? t('device.today', { date: dateKey }) : '';

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'small muted';
    empty.textContent = t('device.empty');
    els.list.appendChild(empty);
    return;
  }

  // 「全部設備」快選
  els.list.appendChild(allRow());
  rows.forEach((device) => els.list.appendChild(deviceRow(device)));
}

function allRow() {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'member-row';
  row.setAttribute('aria-pressed', String(state.filters.device === 'all'));

  const avatar = document.createElement('span');
  avatar.className = 'av';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = '＊';

  const label = document.createElement('span');
  label.className = 'nm truncate';
  label.textContent = t('device.all');

  const count = document.createElement('span');
  count.className = 'n';
  count.textContent = t('device.count', { n: rows.length });

  row.append(avatar, label, count);
  row.addEventListener('click', () => onSelect?.('all'));
  return row;
}

function deviceRow(device) {
  const row = document.createElement('div');
  row.className = 'device-row';
  row.dataset.deviceId = device.id;
  if (state.filters.device === device.id) row.dataset.active = 'true';

  const head = document.createElement('div');
  head.className = 'device-head';

  const code = document.createElement('button');
  code.type = 'button';
  code.className = 'device-code mono';
  code.textContent = device.shortCode;
  code.title = t('device.of', { model: device.model, code: device.shortCode });
  code.setAttribute('aria-label', `${t('device.all')}：${device.shortCode}`);
  code.addEventListener('click', () => onSelect?.(state.filters.device === device.id ? 'all' : device.id));

  const meta = document.createElement('div');
  meta.className = 'device-meta';
  const model = document.createElement('div');
  model.className = 'small truncate';
  // 看「全部日期」時要標出是哪一天的紀錄，不然同一台手機好幾天會分不清
  model.textContent = dateScope === 'all' ? `${device.model}｜${device.dateKey}` : device.model;
  const stat = document.createElement('div');
  stat.className = 'small muted';
  stat.textContent = t('device.photos', { n: device.photoCount });
  meta.append(model, stat);

  head.append(code, meta);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'device-label';
  input.maxLength = 40;
  input.value = device.label;
  input.placeholder = t('device.assignPlaceholder');
  input.setAttribute('aria-label', `${t('device.assign')}（${device.shortCode}）`);

  const save = async () => {
    const label = input.value.trim();
    if (label === device.label) return;
    try {
      const updated = await api.patch(`/api/devices/${device.id}`, { label, version: device.version });
      Object.assign(device, updated);
      input.value = updated.label;
      toastOk(t('device.saved'));
      document.dispatchEvent(new CustomEvent('device:renamed', { detail: updated }));
    } catch (err) {
      if (err.status === 409 && err.extra?.current) {
        Object.assign(device, err.extra.current);
        input.value = device.label;
        toastError(t('viewer.conflict'));
      } else {
        input.value = device.label;
        toastError(err);
      }
    }
  };

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      input.value = device.label;
      input.blur();
    }
  });
  input.addEventListener('blur', save);

  row.append(head, input);
  return row;
}

/** 別的地方（SSE）改了設備就重載 */
export const refreshDevices = loadDevices;
