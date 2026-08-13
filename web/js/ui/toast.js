/** 輕量提示。成功/失敗都要看得見——禁靜默失敗。 */
import { icon } from './icons.js';
import { t } from '../lib/i18n.js';

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'toast-host';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/** @param {'ok'|'error'|'info'} kind */
export function toast(message, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.innerHTML = icon(kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'image');
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  ensureHost().appendChild(el);

  const timer = setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, kind === 'error' ? Math.max(ms, 5000) : ms);

  el.addEventListener('click', () => {
    clearTimeout(timer);
    el.remove();
  });
}

export const toastOk = (msg) => toast(msg, 'ok');
export const toastError = (err) => toast(typeof err === 'string' ? err : err?.message ?? t('common.error'), 'error');
