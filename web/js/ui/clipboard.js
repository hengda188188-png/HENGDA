/**
 * 複製到剪貼簿（三層退路）。
 *
 * 為什麼不能只用 navigator.clipboard：它需要「安全來源」。
 * 這個工具在 localhost 是安全來源沒問題，但**別台電腦用區網 IP 開（http://192.168.x.x）就不是**，
 * 實測 `window.isSecureContext === false`、`navigator.clipboard === undefined`。
 * 多台電腦共用是本工具的正常用法，所以一定要有非安全來源也能用的退路。
 *
 * 順序：clipboard API → 隱藏 textarea + execCommand → 把文字用提示顯示出來讓人手動選。
 */
import { toast, toastOk } from './toast.js';

/** 舊招但在純 http 仍然有效：塞一個看不見的 textarea 選起來再 execCommand */
function copyByTextarea(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

  area.select();
  area.setSelectionRange(0, area.value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();

  // 還原使用者原本選取的東西，別把人家選到一半的字弄掉
  if (previous) {
    selection.removeAllRanges();
    selection.addRange(previous);
  }
  return ok;
}

/**
 * @param {string} text 要複製的內容
 * @param {string} okMessage 成功時顯示的提示
 * @returns {Promise<boolean>} 是否真的進了剪貼簿
 */
export async function copyText(text, okMessage) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      toastOk(okMessage);
      return true;
    } catch {
      /* 被權限或非安全來源擋掉 → 往下走 */
    }
  }
  if (copyByTextarea(text)) {
    toastOk(okMessage);
    return true;
  }
  // 真的複製不了才把內容攤出來讓人手動選（停久一點，別讓人來不及選）
  toast(text, 'info', 15000);
  return false;
}
