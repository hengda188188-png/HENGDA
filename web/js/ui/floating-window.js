/** 可拖移／可收合成浮動圖示的視窗（不是 Modal）：不鎖 body 捲動、不擋背景操作。
 * 展開時拖標題列移動；收合後拖圓形圖示移動、短按圖示則重新展開。 */
import { icon } from './icons.js';
import { ovTop } from './overlay.js';

/**
 * @param {{title?:string, body:HTMLElement, x?:number, y?:number, w?:number, h?:number,
 * className?:string, labels?:{collapse?:string,expand?:string,close?:string}, onClose?:()=>void}} opts
 */
export function openFloatingWindow({ title = '', body, x = 24, y = 72, w = 380, h = 300,
  className = '', labels = {}, onClose } = {}) {
  const el = document.createElement('div');
  el.className = `fw-win ${className}`.trim();
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${w}px`;
  el.style.height = `${h}px`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', title);

  const bar = document.createElement('div');
  bar.className = 'fw-win__bar';
  const heading = document.createElement('span');
  heading.className = 'fw-win__title';
  heading.textContent = title;
  const minBtn = document.createElement('button');
  minBtn.type = 'button';
  minBtn.className = 'fw-win__dot';
  minBtn.setAttribute('aria-label', labels.collapse || 'Collapse');
  minBtn.textContent = '—';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'fw-win__dot';
  closeBtn.setAttribute('aria-label', labels.close || 'Close');
  closeBtn.innerHTML = icon('x');
  bar.append(heading, minBtn, closeBtn);

  const content = document.createElement('div');
  content.className = 'fw-win__body';
  content.append(body);

  const resize = document.createElement('div');
  resize.className = 'fw-win__resize';

  el.append(bar, content, resize);
  document.body.append(el);

  const focus = () => { el.style.zIndex = String(ovTop()); };
  focus();
  el.addEventListener('mousedown', focus);

  let minimized = false;
  let movedDuringPointer = false;

  // 拖移：展開時抓標題列；收合後可直接拖 QR 圖示。
  bar.addEventListener('mousedown', (event) => {
    if (event.target.closest('button') && !minimized) return;
    const sx = event.clientX, sy = event.clientY, ox = el.offsetLeft, oy = el.offsetTop;
    movedDuringPointer = false;
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) movedDuringPointer = true;
      const maxLeft = window.innerWidth - 80, maxTop = window.innerHeight - 38;
      el.style.left = `${Math.min(maxLeft, Math.max(0, ox + ev.clientX - sx))}px`;
      el.style.top = `${Math.min(maxTop, Math.max(0, oy + ev.clientY - sy))}px`;
    };
    const up = () => {
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // 縮放
  resize.addEventListener('mousedown', (event) => {
    event.stopPropagation();
    const sx = event.clientX, sy = event.clientY, ow = el.offsetWidth, oh = el.offsetHeight;
    const move = (ev) => {
      el.style.width = `${Math.max(260, ow + ev.clientX - sx)}px`;
      el.style.height = `${Math.max(160, oh + ev.clientY - sy)}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  // 收合：變成真正的 QR 浮動圖示；再點圖示展開回原本尺寸與位置。
  let savedHeight = el.style.height;
  let savedWidth = el.style.width;
  minBtn.addEventListener('click', () => {
    if (movedDuringPointer) {
      movedDuringPointer = false;
      return;
    }
    if (!minimized) {
      savedHeight = el.style.height || `${h}px`;
      savedWidth = el.style.width || `${w}px`;
    }
    minimized = !minimized;
    content.style.display = minimized ? 'none' : '';
    resize.style.display = minimized ? 'none' : '';
    el.style.height = minimized ? '' : savedHeight;
    el.style.width = minimized ? '' : savedWidth;
    el.classList.toggle('is-min', minimized);
    minBtn.setAttribute('aria-label', minimized ? (labels.expand || 'Expand') : (labels.collapse || 'Collapse'));
    minBtn.innerHTML = minimized ? icon('qr') : '—';
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    onClose?.();
  };
  closeBtn.addEventListener('click', close);

  const setSize = (nextWidth, nextHeight, { anchor = 'none' } = {}) => {
    const oldRight = el.offsetLeft + el.offsetWidth;
    const oldBottom = el.offsetTop + el.offsetHeight;
    el.style.width = `${nextWidth}px`;
    el.style.height = `${nextHeight}px`;
    if (anchor.includes('right')) el.style.left = `${Math.max(0, oldRight - nextWidth)}px`;
    if (anchor.includes('bottom')) el.style.top = `${Math.max(0, oldBottom - nextHeight)}px`;
  };

  requestAnimationFrame(() => el.classList.add('show'));
  return { el, close, focus, resize: setSize };
}
