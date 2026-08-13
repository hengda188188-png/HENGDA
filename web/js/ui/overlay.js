/**
 * 浮層底座（可複用件，日後應回吐 products/ui-kit）：
 * - 集中式 z 軸：ovTop() 遞增發號，禁各處硬編碼 z-index
 * - 全域 ESC 只關「最上層」那一個
 * - 彈窗尺寸由呼叫端內聯指定，主題不全域壓死
 */
import { icon } from './icons.js';
import { t } from '../lib/i18n.js';

const stack = [];
let zCounter = 1000; // 起點對齊 --z-modal

export const ovTop = () => (zCounter += 10);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length) return;
  const top = stack[stack.length - 1];
  if (top.closeOnEsc !== false) {
    e.stopPropagation();
    top.close();
  }
});

/**
 * @param {{title?:string, body:HTMLElement, footer?:HTMLElement, width?:string, height?:string,
 *          onClose?:()=>void, closeOnEsc?:boolean, closeOnBackdrop?:boolean, variant?:'panel'|'viewer'}} options
 */
export function openModal(options) {
  const { title = '', body, footer = null, width = 'min(560px, 94vw)', height = 'auto', variant = 'panel' } = options;

  const previouslyFocused = document.activeElement;
  const backdrop = document.createElement('div');
  backdrop.className = 'ov-backdrop';
  backdrop.style.zIndex = String(ovTop());

  const box = document.createElement('div');
  box.className = `ov-box ov-${variant}`;
  box.style.width = width;
  box.style.height = height;
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  if (title) box.setAttribute('aria-label', title);

  const head = document.createElement('div');
  head.className = 'ov-head';
  head.innerHTML = `<h2 class="ov-title"></h2>`;
  head.querySelector('.ov-title').textContent = title;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn btn-icon';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', t('common.close'));
  closeBtn.innerHTML = icon('x');
  head.appendChild(closeBtn);

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'ov-body';
  bodyWrap.appendChild(body);

  box.append(head, bodyWrap);
  if (footer) {
    const footWrap = document.createElement('div');
    footWrap.className = 'ov-foot';
    footWrap.appendChild(footer);
    box.appendChild(footWrap);
  }
  backdrop.appendChild(box);
  document.body.appendChild(backdrop);
  if (stack.length === 0) document.body.style.overflow = 'hidden';

  const handle = {
    element: box,
    closeOnEsc: options.closeOnEsc,
    close() {
      const index = stack.indexOf(handle);
      if (index === -1) return;
      stack.splice(index, 1);
      backdrop.remove();
      if (stack.length === 0) document.body.style.overflow = '';
      options.onClose?.();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus({ preventScroll: true });
    },
  };

  closeBtn.addEventListener('click', () => handle.close());
  if (options.closeOnBackdrop !== false) {
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) handle.close();
    });
  }

  stack.push(handle);
  (box.querySelector('[data-autofocus]') ?? closeBtn).focus({ preventScroll: true });
  return handle;
}

/** 確認對話框（取代 window.confirm，樣式一致且可鍵盤操作） */
export function confirmDialog({ title, message, confirmText, danger = false }) {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.className = 'ov-message';
    body.textContent = message;

    const footer = document.createElement('div');
    footer.className = 'ov-actions';
    const cancel = document.createElement('button');
    cancel.className = 'btn';
    cancel.type = 'button';
    cancel.textContent = t('common.cancel');
    const ok = document.createElement('button');
    ok.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    ok.type = 'button';
    ok.textContent = confirmText ?? t('common.ok');
    ok.dataset.autofocus = '1';
    footer.append(cancel, ok);

    let settled = false;
    const modal = openModal({
      title,
      body,
      footer,
      width: 'min(420px, 92vw)',
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
    cancel.addEventListener('click', () => {
      settled = true;
      modal.close();
      resolve(false);
    });
    ok.addEventListener('click', () => {
      settled = true;
      modal.close();
      resolve(true);
    });
  });
}
