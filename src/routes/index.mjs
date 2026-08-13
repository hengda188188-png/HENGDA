/**
 * 單一路由入口（系統優先·防死代碼：所有功能都必須從這張表被呼叫得到）。
 * 每條路由都對應 feature-map.json 的 covers 欄位。
 */
import { parseUrl, sendError, sendJson, HttpError, rateLimit } from '../lib/http.mjs';
import { log } from '../lib/log.mjs';
import * as pages from './pages.mjs';
import * as projects from './projects.mjs';
import * as photos from './photos.mjs';
import * as mobile from './mobile.mjs';
import * as drive from './drive.mjs';
import * as events from './events.mjs';
import * as auth from './auth.mjs';
import { isEnabled as passwordEnabled, hasValidCookie, isOpenPath } from '../lib/console-auth.mjs';

/** 寫入類方法要吃速率限制（規則 R11） */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const routes = [
  // 頁面與靜態資源
  ['GET', '/', pages.desktopPage],
  ['GET', '/settings', pages.settingsPage],
  ['GET', '/m/:token', pages.mobilePage],
  ['GET', '/assets/*path', pages.staticAsset],
  ['GET', '/favicon.ico', pages.favicon],
  ['GET', '/healthz', pages.health],
  ['GET', '/login', auth.loginPage],
  ['GET', '/api/auth/status', auth.getAuthStatus],
  ['POST', '/api/auth/login', auth.postLogin],
  ['POST', '/api/auth/logout', auth.postLogout],
  ['POST', '/api/auth/password', auth.postSetPassword],
  ['POST', '/api/auth/password/remove', auth.postRemovePassword],

  // 電腦端 API
  ['GET', '/api/bootstrap', projects.bootstrap],
  ['GET', '/api/users', projects.getUsers],
  ['POST', '/api/users', projects.postUser],
  ['GET', '/api/projects', projects.getProjects],
  ['POST', '/api/projects', projects.postProject],
  ['GET', '/api/projects/:id', projects.getOneProject],
  ['PATCH', '/api/projects/:id', projects.patchProject],
  ['POST', '/api/projects/:id/token', projects.postRegenerateToken],
  ['GET', '/api/projects/:id/qr', projects.getQr],
  ['GET', '/api/projects/:id/photos', photos.getPhotos],
  ['GET', '/api/projects/:id/devices', projects.getDevices],
  ['PATCH', '/api/devices/:id', projects.patchDevice],
  ['GET', '/api/projects/:id/manifest.csv', photos.getManifestCsv],

  ['GET', '/api/photos/:id', photos.getOnePhoto],
  ['PATCH', '/api/photos/:id', photos.patchPhoto],
  ['DELETE', '/api/photos/:id', photos.deleteOnePhoto],
  ['PUT', '/api/photos/:id/edited', photos.putEdited],
  ['PUT', '/api/photos/:id/thumb', photos.putThumb],
  ['DELETE', '/api/photos/:id/edited', photos.deleteEdited],
  ['GET', '/api/photos/:id/file', photos.getPhotoFile],

  ['GET', '/api/events', events.stream],

  // 設定與 Google 雲端
  ['GET', '/api/settings', drive.getSettings],
  ['POST', '/api/settings', drive.postSettings],
  ['GET', '/api/drive/status', drive.getStatus],
  ['POST', '/api/drive/credentials', drive.postCredentials],
  ['POST', '/api/drive/credentials-file', drive.postCredentialsFile],
  ['POST', '/api/drive/test', drive.postTest],
  ['GET', '/api/drive/auth-url', drive.getAuthUrl],
  ['GET', '/api/drive/callback', drive.oauthCallback],
  ['POST', '/api/drive/revoke', drive.postRevoke],
  ['POST', '/api/drive/service-account', drive.postServiceAccount],
  ['POST', '/api/drive/mode', drive.postMode],
  ['POST', '/api/drive/folder-check', drive.postFolderCheck],
  ['POST', '/api/projects/:id/drive/upload', drive.postUploadProject],
  ['GET', '/api/projects/:id/drive/job', drive.getUploadJob],
  ['POST', '/api/projects/:id/drive/share', drive.postShareLinks],

  // 手機端 API（token 授權）
  ['GET', '/api/m/:token/context', mobile.getContext],
  ['POST', '/api/m/:token/device', mobile.postDevice],
  ['POST', '/api/m/:token/photos', mobile.postPhoto],
  ['PUT', '/api/m/:token/photos/:photoId/blob', mobile.putBlob],
  ['GET', '/api/m/:token/recent', mobile.getRecent],
];

const compiled = routes.map(([method, pattern, handler]) => {
  const names = [];
  const regexSource = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '/([^/]+)';
    })
    .replace(/\/\*([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '/(.*)';
    });
  return { method, handler, names, regex: new RegExp(`^${regexSource}$`), pattern };
});

export async function handleRequest(req, res) {
  const started = Date.now();
  const { pathname, query } = parseUrl(req);
  let matchedPattern = 'none';

  try {
    // 密碼閘門：只擋電腦端工作台與管理 API，手機掃碼上傳整條鏈照常放行
    if (passwordEnabled() && !isOpenPath(pathname) && !hasValidCookie(req)) {
      if (pathname.startsWith('/api/')) throw new HttpError(401, 'E_NEED_LOGIN', '請先輸入工作台密碼');
      res.writeHead(302, { location: '/login', 'cache-control': 'no-store' });
      res.end();
      return;
    }

    let allowedButWrongMethod = false;
    for (const route of compiled) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      if (route.method !== req.method) {
        allowedButWrongMethod = true;
        continue;
      }
      const params = {};
      route.names.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
      matchedPattern = route.pattern;
      if (WRITE_METHODS.has(req.method)) rateLimit(req);
      await route.handler({ req, res, params, query });
      return;
    }
    if (allowedButWrongMethod) throw new HttpError(405, 'E_METHOD', '不支援的請求方法');
    throw new HttpError(404, 'E_NOT_FOUND', '找不到這個位址');
  } catch (err) {
    if (res.headersSent || res.writableEnded) {
      log.error(`${req.method} ${pathname} 回應已送出後才出錯`, err.message);
      return;
    }
    if (err instanceof HttpError) {
      if (err.status >= 500) log.error(`${req.method} ${pathname}`, err.code, err.message);
      sendError(res, err.status, err.code, err.message, err.extra);
    } else {
      log.error(`${req.method} ${pathname} 未預期錯誤`, err.stack ?? err.message);
      sendError(res, 500, 'E_INTERNAL', '伺服器發生錯誤，詳情請看 data/error.log');
    }
  } finally {
    const ms = Date.now() - started;
    if (ms > 1000) log.warn(`慢請求 ${req.method} ${pathname} (${matchedPattern}) ${ms}ms`);
  }
}

export { sendJson };
