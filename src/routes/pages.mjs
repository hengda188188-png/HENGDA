/** 頁面與靜態資源（後台工具：全站 noindex，不給搜尋引擎索引）。 */
import path from 'node:path';
import { WEB_DIR } from '../config.mjs';
import { sendFile, sendJson } from '../lib/http.mjs';
import { listenerCount } from '../lib/bus.mjs';

const noIndex = (res) => res.setHeader('x-robots-tag', 'noindex, nofollow');

export async function desktopPage({ res }) {
  noIndex(res);
  await sendFile(res, WEB_DIR, 'desktop.html');
}

export async function settingsPage({ res }) {
  noIndex(res);
  await sendFile(res, WEB_DIR, 'settings.html');
}

export async function mobilePage({ res }) {
  noIndex(res);
  await sendFile(res, WEB_DIR, 'mobile.html');
}

export async function staticAsset({ res, params }) {
  noIndex(res);
  await sendFile(res, WEB_DIR, params.path);
}

export async function favicon({ res }) {
  await sendFile(res, path.join(WEB_DIR), 'favicon.svg');
}

export async function health({ res }) {
  sendJson(res, 200, { ok: true, sseClients: listenerCount(), uptimeSec: Math.round(process.uptime()) });
}
