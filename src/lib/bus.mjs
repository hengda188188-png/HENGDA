/** 專案層級的事件匯流排：手機一上傳完，電腦端 SSE 立刻收到（F5 即時同步）。 */
const listeners = new Set();

/**
 * @param {(event:{type:string, projectId:string, payload:any})=>void} fn
 * @returns {()=>void} 取消訂閱
 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(type, projectId, payload = {}) {
  const event = { type, projectId, payload, at: new Date().toISOString() };
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* 單一訂閱者爆掉不能拖垮其他人 */
    }
  }
}

export const listenerCount = () => listeners.size;
