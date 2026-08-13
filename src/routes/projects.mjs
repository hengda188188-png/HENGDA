/** 專案 / 使用者 / QR 相關端點。 */
import { sendJson, readJsonBody, badRequest, notFound } from '../lib/http.mjs';
import { settings } from '../config.mjs';
import * as store from '../store.mjs';
import { listLanAddresses, mobileUrl } from '../lib/lan-ip.mjs';
import { toSVG } from '../lib/qrcode.mjs';
import { driveStatus } from '../lib/google-drive.mjs';
import { emit } from '../lib/bus.mjs';

/** 開頁必要資料一次給齊（避免前端連打多支 API） */
export async function bootstrap({ res }) {
  const s = settings();
  sendJson(res, 200, {
    settings: {
      port: s.port,
      maxEdgePx: s.maxEdgePx,
      jpegQuality: s.jpegQuality,
      thumbEdgePx: s.thumbEdgePx,
      maxFileBytes: s.maxFileBytes,
      maxFilesPerRequest: s.maxFilesPerRequest,
      maxPhotosPerProject: s.maxPhotosPerProject,
      pageSize: s.pageSize,
      keepOriginalFile: s.keepOriginalFile,
    },
    addresses: listLanAddresses(),
    drive: driveStatus(),
    users: store.listUsers(),
  });
}

export async function getUsers({ res }) {
  sendJson(res, 200, { rows: store.listUsers() });
}

export async function postUser({ req, res }) {
  const body = await readJsonBody(req);
  sendJson(res, 201, store.ensureUser(body.name));
}

export async function getProjects({ res, query }) {
  sendJson(res, 200, store.listProjects({
    q: query.get('q') ?? '',
    status: query.get('status') ?? 'active',
    page: Number(query.get('page') ?? 1),
    pageSize: query.get('pageSize'),
  }));
}

export async function postProject({ req, res }) {
  const body = await readJsonBody(req);
  const project = store.createProject({ name: body.name, note: body.note, ownerName: body.ownerName });
  // projectId 傳空字串＝廣播給所有連線中的電腦，別台才看得到新專案（多人共用必要）
  emit('project:created', '', { project: store.projectSummary(project) });
  sendJson(res, 201, store.projectSummary(project));
}

export async function getOneProject({ res, params }) {
  const project = store.getProject(params.id);
  if (!project) throw notFound('專案不存在');
  sendJson(res, 200, store.projectSummary(project));
}

export async function patchProject({ req, res, params }) {
  const body = await readJsonBody(req);
  const project = store.updateProject(params.id, body, body.version);
  emit('project:updated', '', { project: store.projectSummary(project) });
  sendJson(res, 200, store.projectSummary(project));
}

export async function postRegenerateToken({ res, params }) {
  const project = store.regenerateToken(params.id);
  emit('project:updated', project.id, { project: store.projectSummary(project) });
  sendJson(res, 200, store.projectSummary(project));
}

/** 專案的設備清單（預設只看今天：歸屬只對「當天＋該專案」有效） */
export async function getDevices({ res, params, query }) {
  sendJson(res, 200, store.listDevices(params.id, { date: query.get('date') ?? 'today' }));
}

/** 電腦端指派歸屬名稱給某台設備 */
export async function patchDevice({ req, res, params }) {
  const body = await readJsonBody(req);
  const device = store.labelDevice(params.id, body.label, body.version);
  emit('device:updated', device.projectId, { device });
  sendJson(res, 200, { ...device, displayName: store.deviceDisplayName(device) });
}

/** QR 圖：內容 = 手機頁網址。address 由前端指定（多網卡可切換） */
export async function getQr({ res, params, query }) {
  const project = store.getProject(params.id);
  if (!project) throw notFound('專案不存在');

  const addresses = listLanAddresses();
  const requested = query.get('address');
  const chosen = requested && addresses.some((a) => a.address === requested) ? requested : addresses[0]?.address;
  if (!chosen) throw badRequest('偵測不到區網 IP，請確認電腦已連上 Wi-Fi', 'E_NO_LAN');

  const url = mobileUrl(chosen, settings().port, project.token);
  const format = query.get('format') ?? 'svg';
  if (format === 'json') {
    sendJson(res, 200, { url, address: chosen, addresses });
    return;
  }
  const svg = toSVG(url, { ecl: 'M', margin: 3, title: `掃碼上傳到「${project.name}」` });
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'no-store',
    'x-relay-url': encodeURIComponent(url),
  });
  res.end(svg);
}
