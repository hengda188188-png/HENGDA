/** 後端呼叫封裝：統一錯誤格式 → 丟出帶 code 的 Error，呼叫端可以判斷 409/401 等情況。 */
import { t } from './i18n.js';

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra ?? {};
  }
}

async function request(method, url, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, 'E_NETWORK', t('error.network'));
  }
  const text = await res.text();
  const data = text ? safeParse(text) : {};
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? 'E_UNKNOWN', err.message ?? t('error.server', { status: res.status }), err);
  }
  return data;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),

  /** 原始位元組上傳（帶進度）。用 XHR 才拿得到 upload.onprogress。 */
  putBlob(url, blob, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      xhr.setRequestHeader('content-type', blob.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        const data = safeParse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(xhr.status, data?.error?.code ?? 'E_UNKNOWN', data?.error?.message ?? t('error.upload', { status: xhr.status })));
      };
      xhr.onerror = () => reject(new ApiError(0, 'E_NETWORK', t('error.uploadAborted')));
      xhr.ontimeout = () => reject(new ApiError(0, 'E_TIMEOUT', t('error.uploadTimeout')));
      xhr.timeout = 5 * 60 * 1000;
      xhr.send(blob);
    });
  },
};

/**
 * 訂閱伺服器推播（SSE），斷線自動重連由瀏覽器負責。
 * @param {object} handlers 事件處理器；額外支援 onReconnect(重連後整批補資料)、onStatusChange('connecting'|'open'|'reconnecting')
 * @returns {()=>void} 取消訂閱
 */
export function subscribeEvents(projectId, handlers) {
  const source = new EventSource(`/api/events?projectId=${encodeURIComponent(projectId ?? '')}`);
  handlers.onStatusChange?.('connecting');

  // 斷線期間發生的事件收不到 → 重連時整批補一次，避免多台電腦畫面各說各話
  let everOpened = false;
  source.addEventListener('open', () => {
    handlers.onStatusChange?.('open');
    if (everOpened) handlers.onReconnect?.();
    everOpened = true;
  });
  // EventSource 斷線會自動重連(瀏覽器內建)，這段只負責讓 UI 知道「目前正在補連線」，不用自己重建連線
  source.addEventListener('error', () => {
    if (source.readyState !== EventSource.CLOSED) handlers.onStatusChange?.('reconnecting');
  });

  for (const [type, fn] of Object.entries(handlers)) {
    if (type === 'onReconnect' || type === 'onStatusChange') continue;
    source.addEventListener(type, (e) => {
      try {
        fn(JSON.parse(e.data));
      } catch (err) {
        console.error('[sse] 處理事件失敗', type, err);
      }
    });
  }
  return () => source.close();
}
