/** 設定頁：Google 授權三步驟 + 上傳/影像參數。密鑰只送出、不回讀（伺服器不吐）。 */
import { api } from '../lib/api.js';
import { applyI18n, t } from '../lib/i18n.js';
import { toastOk, toastError } from '../ui/toast.js';

const els = {};
let settings = null;
let driveState = null;


async function boot() {
  applyI18n();
  Object.assign(els, {
    clientId: document.querySelector('[data-role="client-id"]'),
    clientSecret: document.querySelector('[data-role="client-secret"]'),
    credsHelp: document.querySelector('[data-role="creds-help"]'),
    driveStateTag: document.querySelector('[data-role="drive-state"]'),
    accountState: document.querySelector('[data-role="account-state"]'),
    connect: document.querySelector('[data-act="connect"]'),
    disconnect: document.querySelector('[data-act="disconnect"]'),
    folderId: document.querySelector('[data-role="folder-id"]'),
    folderState: document.querySelector('[data-role="folder-state"]'),
    maxFileMb: document.querySelector('[data-role="max-file-mb"]'),
    modeHint: document.querySelector('[data-role="mode-hint"]'),
    paneOauth: document.querySelector('[data-role="pane-oauth"]'),
    paneService: document.querySelector('[data-role="pane-service"]'),
    saKey: document.querySelector('[data-role="sa-key"]'),
    saEmail: document.querySelector('[data-role="sa-email"]'),
    saFile: document.querySelector('[data-role="sa-file"]'),
    credsFile: document.querySelector('[data-role="creds-file"]'),
    testState: document.querySelector('[data-role="test-state"]'),
    testBtn: document.querySelector('[data-act="test-drive"]'),
    authState: document.querySelector('[data-role="auth-state"]'),
    authHint: document.querySelector('[data-role="auth-hint"]'),
    authCurrentWrap: document.querySelector('[data-role="auth-current-wrap"]'),
    authCurrent: document.querySelector('[data-role="auth-current"]'),
    authNew: document.querySelector('[data-role="auth-new"]'),
    authSave: document.querySelector('[data-act="auth-save"]'),
    authRemove: document.querySelector('[data-act="auth-remove"]'),
    authLogout: document.querySelector('[data-act="auth-logout"]'),
  });
  els.saKey.placeholder = t('settings.saKeyPlaceholder');
  els.credsHelp.textContent = t('settings.credsHelp');

  document.querySelector('[data-act="save-creds"]').addEventListener('click', saveCredentials);
  document.querySelector('[data-act="save-settings"]').addEventListener('click', saveSettings);
  document.querySelector('[data-act="check-folder"]').addEventListener('click', checkFolder);
  els.connect.addEventListener('click', connect);
  els.disconnect.addEventListener('click', disconnect);

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
  });
  document.querySelector('[data-act="sa-import"]').addEventListener('click', importServiceAccount);
  document.querySelector('[data-act="sa-forget"]').addEventListener('click', forgetServiceAccount);
  document.querySelector('[data-act="sa-pick"]').addEventListener('click', () => els.saFile.click());
  els.saFile.addEventListener('change', async () => {
    const file = els.saFile.files?.[0];
    els.saFile.value = '';
    if (!file) return;
    els.saKey.value = await file.text();
    await importServiceAccount();
  });

  document.querySelector('[data-act="creds-pick"]').addEventListener('click', () => els.credsFile.click());
  els.credsFile.addEventListener('change', async () => {
    const file = els.credsFile.files?.[0];
    els.credsFile.value = '';
    if (!file) return;
    try {
      const result = await api.post('/api/drive/credentials-file', { keyFile: await file.text() });
      const type = result.clientType === 'installed' ? t('settings.credsTypeInstalled') : t('settings.credsTypeWeb');
      toastOk(t('settings.credsFileOk', { type }));
      await loadDriveStatus();
    } catch (err) {
      toastError(err);
    }
  });
  els.testBtn.addEventListener('click', testDrive);

  els.authSave.addEventListener('click', saveConsolePassword);
  els.authRemove.addEventListener('click', removeConsolePassword);
  els.authLogout.addEventListener('click', async () => {
    await api.post('/api/auth/logout');
    location.href = '/login';
  });

  await Promise.all([loadSettings(), loadDriveStatus(), loadAuthStatus()]);

  // 從 OAuth 回來的分頁會關掉，這裡定期同步一次狀態
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadDriveStatus();
  });
}

async function loadSettings() {
  const data = await api.get('/api/settings');
  settings = data.settings;
  document.querySelectorAll('[data-key]').forEach((el) => {
    const value = settings[el.dataset.key];
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value;
  });
  els.maxFileMb.value = Math.round(settings.maxFileBytes / 1024 / 1024);
  els.folderId.value = settings.driveTargetFolderId ?? '';
}

async function loadDriveStatus() {
  driveState = await api.get('/api/drive/status');
  renderMode();
  const connected = driveState.authorized;
  els.driveStateTag.textContent = connected ? t('settings.connected', { account: driveState.account || '—' }) : t('settings.notConnected');
  els.driveStateTag.className = `tag ${connected ? 'tag-confirmed' : 'tag-pending'}`;
  els.connect.textContent = connected ? t('settings.reconnect') : t('settings.connect');
  els.connect.disabled = !driveState.hasCredentials;
  els.disconnect.disabled = !connected;
  els.accountState.textContent = driveState.hasCredentials
    ? driveState.clientIdMasked
    : t('settings.noCreds');
  if (driveState.hasCredentials && !els.clientId.value) els.clientId.placeholder = driveState.clientIdMasked;
}

/** 兩種憑證方式各自一塊畫面，避免混在一起看不懂要填哪個 */
function renderMode() {
  const mode = driveState.mode ?? 'oauth';
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  });
  els.modeHint.textContent = mode === 'service' ? t('settings.mode.serviceHint') : t('settings.mode.oauthHint');
  els.paneOauth.classList.toggle('hidden', mode === 'service');
  els.paneService.classList.toggle('hidden', mode !== 'service');
  els.saEmail.value = driveState.serviceAccountEmail ?? '';
}

async function switchMode(mode) {
  try {
    if (mode === 'service' && !driveState.serviceAccountEmail) {
      // 還沒匯入金鑰檔：先把畫面切過去讓使用者貼，不動伺服器狀態
      driveState = { ...driveState, mode: 'service' };
      renderMode();
      return;
    }
    driveState = await api.post('/api/drive/mode', { mode });
    renderMode();
    await loadDriveStatus();
  } catch (err) {
    toastError(err);
  }
}

async function importServiceAccount() {
  const raw = els.saKey.value.trim();
  if (!raw) {
    toastError(`${t('settings.saKey')}：${t('common.required')}`);
    return;
  }
  try {
    driveState = await api.post('/api/drive/service-account', { keyFile: raw });
    els.saKey.value = ''; // 不留在畫面上
    toastOk(t('settings.saImported'));
    await loadDriveStatus();
    if (!settings.driveTargetFolderId) toastError(t('settings.saNeedFolder'));
  } catch (err) {
    toastError(err);
  }
}

async function forgetServiceAccount() {
  try {
    driveState = await api.post('/api/drive/mode', { mode: 'oauth', forget: true });
    els.saKey.value = '';
    await loadDriveStatus();
    toastOk(t('settings.saved'));
  } catch (err) {
    toastError(err);
  }
}

async function saveCredentials() {
  try {
    await api.post('/api/drive/credentials', {
      clientId: els.clientId.value.trim(),
      clientSecret: els.clientSecret.value.trim(),
    });
    els.clientSecret.value = '';
    toastOk(t('settings.saved'));
    await loadDriveStatus();
  } catch (err) {
    toastError(err);
  }
}

async function connect() {
  try {
    const { url } = await api.get('/api/drive/auth-url');
    window.open(url, '_blank', 'noopener');
  } catch (err) {
    toastError(err);
  }
}

async function disconnect() {
  try {
    await api.post('/api/drive/revoke');
    toastOk(t('settings.saved'));
    await loadDriveStatus();
  } catch (err) {
    toastError(err);
  }
}

async function checkFolder() {
  try {
    const result = await api.post('/api/drive/folder-check', { folderId: els.folderId.value.trim() });
    els.folderState.textContent = result.cleared ? '' : t('settings.folderOk', { name: result.name });
    els.folderState.style.color = '';
    toastOk(t('settings.saved'));
  } catch (err) {
    els.folderState.textContent = err.message;
    els.folderState.style.color = 'var(--danger)';
  }
}

/** 真的傳一個小檔上雲端再刪掉，確認整條路是通的（不要等到現場才發現沒設好） */
async function testDrive() {
  els.testBtn.disabled = true;
  els.testState.style.color = '';
  els.testState.textContent = t('settings.testing');
  try {
    const result = await api.post('/api/drive/test');
    els.testState.textContent = t('settings.testOk', { folder: result.folderName, account: result.account || '—' });
    els.testState.style.color = 'var(--ok)';
    if (result.folderLink) {
      const link = document.createElement('a');
      link.href = result.folderLink;
      link.target = '_blank';
      link.rel = 'noopener';
      link.className = 'small';
      link.style.marginLeft = '8px';
      link.textContent = t('settings.testFolder');
      els.testState.appendChild(link);
    }
    toastOk(t('settings.testOk', { folder: result.folderName, account: result.account || '—' }));
  } catch (err) {
    els.testState.textContent = err.message;
    els.testState.style.color = 'var(--danger)';
  } finally {
    els.testBtn.disabled = false;
  }
}

// ── 工作台存取密碼 ─────────────────────────────────────
let authEnabled = false;

async function loadAuthStatus() {
  const status = await api.get('/api/auth/status');
  authEnabled = status.enabled;
  els.authState.textContent = authEnabled ? t('auth.state.on') : t('auth.state.off');
  els.authState.className = `tag ${authEnabled ? 'tag-confirmed' : 'tag-pending'}`;
  els.authHint.textContent = authEnabled ? t('auth.hintOn') : t('auth.hintOff');
  els.authSave.textContent = authEnabled ? t('auth.change') : t('auth.set');
  els.authCurrentWrap.classList.toggle('hidden', !authEnabled);
  els.authRemove.classList.toggle('hidden', !authEnabled);
  els.authLogout.classList.toggle('hidden', !authEnabled);
}

async function saveConsolePassword() {
  try {
    await api.post('/api/auth/password', {
      password: els.authNew.value,
      currentPassword: els.authCurrent.value,
    });
    els.authNew.value = '';
    els.authCurrent.value = '';
    toastOk(t('auth.saved'));
    await loadAuthStatus();
  } catch (err) {
    toastError(err);
  }
}

async function removeConsolePassword() {
  try {
    await api.post('/api/auth/password/remove', { currentPassword: els.authCurrent.value });
    els.authCurrent.value = '';
    toastOk(t('auth.removed'));
    await loadAuthStatus();
  } catch (err) {
    toastError(err);
  }
}

async function saveSettings() {
  const patch = {};
  document.querySelectorAll('[data-key]').forEach((el) => {
    patch[el.dataset.key] = el.type === 'checkbox' ? el.checked : Number(el.value);
  });
  patch.maxFileBytes = Math.round(Number(els.maxFileMb.value) * 1024 * 1024);
  try {
    const data = await api.post('/api/settings', patch);
    settings = data.settings;
    toastOk(t('settings.saved'));
  } catch (err) {
    toastError(err);
  }
}

boot();
