/** 登入頁：只有在設了工作台密碼時才會被導到這裡。 */
import { api } from '../lib/api.js';
import { applyI18n, t } from '../lib/i18n.js';

const els = {};

async function boot() {
  applyI18n();
  Object.assign(els, {
    form: document.querySelector('[data-role="form"]'),
    password: document.querySelector('[data-role="password"]'),
    error: document.querySelector('[data-role="error"]'),
  });

  // 沒設密碼卻跑到這頁（例如剛剛才被取消），直接放行回工作台
  try {
    const status = await api.get('/api/auth/status');
    if (!status.enabled || status.signedIn) {
      location.replace('/');
      return;
    }
  } catch {
    /* 拿不到狀態就照常顯示表單 */
  }

  els.password.focus();
  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.error.textContent = '';
    try {
      await api.post('/api/auth/login', { password: els.password.value });
      const target = new URLSearchParams(location.search).get('next');
      location.replace(target && target.startsWith('/') ? target : '/');
    } catch (err) {
      els.error.textContent = err.message ?? t('login.failed');
      els.password.select();
    }
  });
}

boot();
