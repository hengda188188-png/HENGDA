/**
 * 圖片編輯器（巢狀彈窗，z 由 overlay 集中發號）：裁切／旋轉 ＋ 標註（箭頭／文字／螢光筆）。
 *
 * 座標系原則（避免旋轉後標註跑掉）：
 * - **標註一律存「原圖座標」**，旋轉只是顯示與輸出時的轉換，所以轉幾次都不會累積誤差。
 * - 裁切框存「旋轉後座標」＋ rotate 值，跟輸出流程一致：先旋轉 → 畫標註 → 再裁切。
 * 原圖永不被覆寫（規則 R9），輸出另存 edited。
 */
import { openModal } from './overlay.js';
import { icon } from './icons.js';
import { t } from '../lib/i18n.js';
import { decodeImage, rotateSource } from '../lib/image.js';

const RATIOS = [
  { key: 'free', label: 'crop.ratio.free', value: null },
  { key: '1:1', label: null, value: 1 },
  { key: '4:3', label: null, value: 4 / 3 },
  { key: '3:4', label: null, value: 3 / 4 },
  { key: '16:9', label: null, value: 16 / 9 },
];

const TOOLS = [
  { key: 'crop', icon: 'crop', label: 'edit.tool.crop', hint: 'edit.hintCrop' },
  { key: 'arrow', icon: 'arrow', label: 'edit.tool.arrow', hint: 'edit.hintArrow' },
  { key: 'text', icon: 'text', label: 'edit.tool.text', hint: 'edit.hintText' },
  { key: 'marker', icon: 'marker', label: 'edit.tool.marker', hint: 'edit.hintMarker' },
];

const COLORS = [
  { key: 'red', value: '#e0332a', label: 'color.red' },
  { key: 'yellow', value: '#f5c518', label: 'color.yellow' },
  { key: 'blue', value: '#2563eb', label: 'color.blue' },
  { key: 'green', value: '#16a34a', label: 'color.green' },
  { key: 'black', value: '#111827', label: 'color.black' },
];

const SIZES = [
  { key: 'thin', scale: 0.004 },
  { key: 'medium', scale: 0.007 },
  { key: 'thick', scale: 0.012 },
];

const MIN_CROP = 24;

// ── 座標轉換：原圖 ↔ 旋轉後畫面 ─────────────────────────
export function toRotated({ x, y }, w, h, rotate) {
  switch (((rotate % 360) + 360) % 360) {
    case 90: return { x: h - y, y: x };
    case 180: return { x: w - x, y: h - y };
    case 270: return { x: y, y: w - x };
    default: return { x, y };
  }
}

export function fromRotated({ x, y }, w, h, rotate) {
  switch (((rotate % 360) + 360) % 360) {
    case 90: return { x: y, y: h - x };
    case 180: return { x: w - x, y: h - y };
    case 270: return { x: w - y, y: x };
    default: return { x, y };
  }
}

/**
 * 把標註畫到 canvas 上（座標已是旋轉後空間）。
 * 抽成獨立函式，讓「畫面預覽」與「輸出檔案」走同一段程式，不會看起來一樣、存出來不一樣。
 */
export function drawAnnotations(ctx, annotations, { width, height, rotate, scale = 1, offsetX = 0, offsetY = 0 }) {
  const unit = Math.max(width, height);
  for (const item of annotations) {
    const stroke = Math.max(1, unit * item.size * scale);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (item.type === 'arrow') {
      const a = mapPoint(item.from, width, height, rotate, scale, offsetX, offsetY);
      const b = mapPoint(item.to, width, height, rotate, scale, offsetX, offsetY);
      ctx.strokeStyle = item.color;
      ctx.fillStyle = item.color;
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const head = stroke * 3.2;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 7), b.y - head * Math.sin(angle - Math.PI / 7));
      ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 7), b.y - head * Math.sin(angle + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    } else if (item.type === 'marker') {
      ctx.strokeStyle = item.color;
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = stroke * 4;
      ctx.beginPath();
      item.points.forEach((point, i) => {
        const p = mapPoint(point, width, height, rotate, scale, offsetX, offsetY);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.stroke();
    } else if (item.type === 'text') {
      const p = mapPoint(item.at, width, height, rotate, scale, offsetX, offsetY);
      const fontSize = Math.max(10, unit * item.size * 3.4 * scale);
      ctx.font = `600 ${fontSize}px system-ui, "Microsoft JhengHei", sans-serif`;
      ctx.textBaseline = 'top';
      const padding = fontSize * 0.28;
      const metrics = ctx.measureText(item.text);
      ctx.fillStyle = 'rgba(255,255,255,.88)';
      ctx.fillRect(p.x - padding, p.y - padding, metrics.width + padding * 2, fontSize + padding * 2);
      ctx.fillStyle = item.color;
      ctx.fillText(item.text, p.x, p.y);
    }
    ctx.restore();
  }
}

function mapPoint(point, width, height, rotate, scale, offsetX, offsetY) {
  const rotated = toRotated(point, width, height, rotate);
  return { x: rotated.x * scale + offsetX, y: rotated.y * scale + offsetY };
}

/**
 * @param {{blob:Blob, annotations?:Array, rotate?:number,
 *          onApply:(r:{blob:Blob,width:number,height:number,crop:object,rotate:number,annotations:Array})=>Promise<void>}} options
 */
export async function openEditor({ blob, annotations = [], rotate: initialRotate = 0, onApply }) {
  const original = await decodeImage(blob);
  const sourceW = original.width ?? original.naturalWidth;
  const sourceH = original.height ?? original.naturalHeight;

  const body = document.createElement('div');
  body.className = 'editor';
  body.innerHTML = `
    <div class="edit-bar">
      <div class="chips" data-role="tools" role="group" aria-label="${t('edit.tool')}"></div>
      <span class="edit-sep"></span>
      <div class="chips" data-role="colors" role="group" aria-label="${t('edit.color')}"></div>
      <span class="edit-sep"></span>
      <label class="small" for="edit-size" style="margin:0">${t('edit.size')}</label>
      <select id="edit-size" data-role="size"></select>
      <label class="small" for="edit-ratio" style="margin:0" data-role="ratio-label">${t('crop.ratio')}</label>
      <select id="edit-ratio" data-role="ratio"></select>
      <span style="flex:1"></span>
      <button type="button" class="btn btn-sm" data-act="rotate">${icon('rotate')}<span>${t('crop.rotate')}</span></button>
      <button type="button" class="btn btn-sm" data-act="undo">${t('edit.undo')}</button>
      <button type="button" class="btn btn-sm" data-act="clear">${t('edit.clear')}</button>
      <button type="button" class="btn btn-sm" data-act="reset">${t('crop.reset')}</button>
    </div>
    <div class="crop-stage" data-role="stage">
      <canvas data-role="canvas"></canvas>
      <canvas data-role="overlay"></canvas>
      <div class="crop-rect" data-role="rect" tabindex="0" role="application" aria-label="${t('crop.title')}">
        <span class="h nw" data-handle="nw"></span><span class="h ne" data-handle="ne"></span>
        <span class="h sw" data-handle="sw"></span><span class="h se" data-handle="se"></span>
      </div>
      <input type="text" class="edit-text-input hidden" data-role="text-input" aria-label="${t('edit.textPrompt')}" maxlength="60">
    </div>
    <p class="small muted" data-role="hint"></p>
  `;

  const footer = document.createElement('div');
  footer.className = 'ov-actions';
  footer.innerHTML = `
    <span class="small muted" data-role="dims"></span>
    <span style="flex:1"></span>
    <div class="chips" role="group" aria-label="${t('edit.saveMode')}">
      <span class="chip-group-label">${t('edit.saveMode')}</span>
      <button type="button" class="chip" data-mode="overwrite" aria-pressed="true"><span>${t('edit.overwrite')}</span></button>
      <button type="button" class="chip" data-mode="new" aria-pressed="false"><span>${t('edit.saveAsNew')}</span></button>
    </div>
    <button type="button" class="btn" data-act="cancel">${t('common.cancel')}</button>
    <button type="button" class="btn btn-primary" data-act="apply" data-autofocus="1">${icon('check')}<span>${t('edit.save')}</span></button>
  `;

  const modal = openModal({ title: t('edit.title'), body, footer, width: 'min(980px, 96vw)' });

  footer.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      saveMode = btn.dataset.mode;
      footer.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === saveMode)));
    });
  });

  const stage = body.querySelector('[data-role="stage"]');
  const canvas = body.querySelector('[data-role="canvas"]');
  const overlay = body.querySelector('[data-role="overlay"]');
  const rectEl = body.querySelector('[data-role="rect"]');
  const hint = body.querySelector('[data-role="hint"]');
  const dims = footer.querySelector('[data-role="dims"]');
  const ratioSelect = body.querySelector('[data-role="ratio"]');
  const ratioLabel = body.querySelector('[data-role="ratio-label"]');
  const sizeSelect = body.querySelector('[data-role="size"]');
  const textInput = body.querySelector('[data-role="text-input"]');

  let tool = 'crop';
  /** overwrite = 存成這張的編輯版（原圖仍保留可還原）；new = 另外長出一張新照片 */
  let saveMode = 'overwrite';
  let color = COLORS[0].value;
  let size = SIZES[1].scale;
  let rotate = ((initialRotate % 360) + 360) % 360;
  let marks = annotations.map((a) => structuredClone(a));
  let working = rotate === 0 ? original : rotateSource(original, rotate);
  let fit = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  let crop = { x: 0, y: 0, w: 0, h: 0 };

  // ── 工具列 ─────────────────────────────────────────
  const toolsBox = body.querySelector('[data-role="tools"]');
  TOOLS.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.tool = item.key;
    btn.innerHTML = `${icon(item.icon)}<span>${t(item.label)}</span>`;
    btn.setAttribute('aria-pressed', String(item.key === tool));
    btn.addEventListener('click', () => selectTool(item.key));
    toolsBox.appendChild(btn);
  });

  const colorsBox = body.querySelector('[data-role="colors"]');
  COLORS.forEach((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.style.setProperty('--swatch', item.value);
    btn.dataset.color = item.value;
    btn.setAttribute('aria-label', t(item.label));
    btn.title = t(item.label);
    btn.setAttribute('aria-pressed', String(item.value === color));
    btn.addEventListener('click', () => {
      color = item.value;
      colorsBox.querySelectorAll('.swatch').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.color === color)));
    });
    colorsBox.appendChild(btn);
  });

  SIZES.forEach((item, i) => {
    const option = document.createElement('option');
    option.value = String(item.scale);
    option.textContent = ['１', '２', '３'][i];
    sizeSelect.appendChild(option);
  });
  sizeSelect.value = String(size);
  sizeSelect.addEventListener('change', () => {
    size = Number(sizeSelect.value);
  });

  RATIOS.forEach((r) => {
    const option = document.createElement('option');
    option.value = r.key;
    option.textContent = r.label ? t(r.label) : r.key;
    ratioSelect.appendChild(option);
  });
  ratioSelect.addEventListener('change', () => {
    applyRatio();
    paintCrop();
  });

  function selectTool(next) {
    tool = next;
    toolsBox.querySelectorAll('.chip').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.tool === tool)));
    const meta = TOOLS.find((item) => item.key === tool);
    hint.textContent = t(meta.hint);
    const cropping = tool === 'crop';
    rectEl.classList.toggle('dim', !cropping);
    ratioSelect.classList.toggle('hidden', !cropping);
    ratioLabel.classList.toggle('hidden', !cropping);
    stage.dataset.tool = tool;
  }

  // ── 畫面 ───────────────────────────────────────────
  const sizeOf = (src) => ({ width: src.width ?? src.naturalWidth, height: src.height ?? src.naturalHeight });

  function fitStage() {
    const { width, height } = sizeOf(working);
    const availW = stage.clientWidth;
    const availH = stage.clientHeight;
    if (!availW || !availH) return;
    const scale = Math.min(availW / width, availH / height);
    fit = {
      x: Math.round((availW - width * scale) / 2),
      y: Math.round((availH - height * scale) / 2),
      w: Math.round(width * scale),
      h: Math.round(height * scale),
      scale,
    };
    for (const el of [canvas, overlay]) {
      el.width = fit.w;
      el.height = fit.h;
      el.style.left = `${fit.x}px`;
      el.style.top = `${fit.y}px`;
      el.style.width = `${fit.w}px`;
      el.style.height = `${fit.h}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, fit.w, fit.h);
    ctx.drawImage(working, 0, 0, fit.w, fit.h);
    paintMarks();
  }

  function paintMarks(preview = null) {
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const list = preview ? [...marks, preview] : marks;
    drawAnnotations(ctx, list, { width: sourceW, height: sourceH, rotate, scale: fit.scale });
  }

  function resetCrop() {
    crop = { x: fit.x, y: fit.y, w: fit.w, h: fit.h };
    applyRatio();
    paintCrop();
  }

  const currentRatio = () => RATIOS.find((r) => r.key === ratioSelect.value)?.value ?? null;

  function applyRatio() {
    const ratio = currentRatio();
    if (!ratio) return;
    let w = crop.w;
    let h = w / ratio;
    if (h > fit.h) {
      h = fit.h;
      w = h * ratio;
    }
    if (w > fit.w) {
      w = fit.w;
      h = w / ratio;
    }
    crop.w = w;
    crop.h = h;
    clampCrop();
  }

  function clampCrop() {
    crop.w = Math.min(Math.max(MIN_CROP, crop.w), fit.w);
    crop.h = Math.min(Math.max(MIN_CROP, crop.h), fit.h);
    crop.x = Math.min(Math.max(fit.x, crop.x), fit.x + fit.w - crop.w);
    crop.y = Math.min(Math.max(fit.y, crop.y), fit.y + fit.h - crop.h);
  }

  function paintCrop() {
    rectEl.style.left = `${crop.x}px`;
    rectEl.style.top = `${crop.y}px`;
    rectEl.style.width = `${crop.w}px`;
    rectEl.style.height = `${crop.h}px`;
    const outW = Math.round(crop.w / fit.scale);
    const outH = Math.round(crop.h / fit.scale);
    dims.textContent = `${outW} × ${outH} px｜${t('edit.annotationCount', { n: marks.length })}`;
  }

  // ── 裁切拖曳 ───────────────────────────────────────
  let drag = null;
  const stagePoint = (e) => {
    const box = stage.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };
  /** 畫面座標 → 原圖座標 */
  const toSource = (point) =>
    fromRotated({ x: (point.x - fit.x) / fit.scale, y: (point.y - fit.y) / fit.scale }, sourceW, sourceH, rotate);

  rectEl.addEventListener('pointerdown', (e) => {
    if (tool !== 'crop') return;
    const handle = e.target.dataset?.handle ?? null;
    drag = { handle, start: stagePoint(e), origin: { ...crop } };
    rectEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  rectEl.addEventListener('pointermove', (e) => {
    if (!drag || tool !== 'crop') return;
    const now = stagePoint(e);
    const dx = now.x - drag.start.x;
    const dy = now.y - drag.start.y;
    const ratio = currentRatio();
    const o = drag.origin;

    if (!drag.handle) {
      crop.x = o.x + dx;
      crop.y = o.y + dy;
    } else {
      const right = o.x + o.w;
      const bottom = o.y + o.h;
      if (drag.handle.includes('w')) {
        crop.x = Math.min(o.x + dx, right - MIN_CROP);
        crop.w = right - crop.x;
      }
      if (drag.handle.includes('e')) crop.w = Math.max(MIN_CROP, o.w + dx);
      if (drag.handle.includes('n')) {
        crop.y = Math.min(o.y + dy, bottom - MIN_CROP);
        crop.h = bottom - crop.y;
      }
      if (drag.handle.includes('s')) crop.h = Math.max(MIN_CROP, o.h + dy);
      if (ratio) {
        crop.h = crop.w / ratio;
        if (drag.handle.includes('n')) crop.y = bottom - crop.h;
      }
    }
    clampCrop();
    paintCrop();
  });

  const endCropDrag = () => {
    drag = null;
  };
  rectEl.addEventListener('pointerup', endCropDrag);
  rectEl.addEventListener('pointercancel', endCropDrag);

  rectEl.addEventListener('keydown', (e) => {
    if (tool !== 'crop') return;
    const step = e.shiftKey ? 10 : 2;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (!moves[e.key]) return;
    e.preventDefault();
    crop.x += moves[e.key][0];
    crop.y += moves[e.key][1];
    clampCrop();
    paintCrop();
  });

  // ── 標註繪製 ───────────────────────────────────────
  let drawing = null;

  overlay.addEventListener('pointerdown', (e) => {
    if (tool === 'crop') return;
    // 一定要擋掉預設行為：否則點下去的預設焦點轉移會馬上讓文字輸入框失焦收掉（實測踩過）
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    const source = toSource(stagePoint(e));

    if (tool === 'text') {
      overlay.releasePointerCapture?.(e.pointerId);
      openTextInput(stagePoint(e), source);
      return;
    }
    if (tool === 'arrow') drawing = { type: 'arrow', color, size, from: source, to: source };
    if (tool === 'marker') drawing = { type: 'marker', color, size, points: [source] };
    paintMarks(drawing);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    const source = toSource(stagePoint(e));
    if (drawing.type === 'arrow') drawing.to = source;
    if (drawing.type === 'marker') drawing.points.push(source);
    paintMarks(drawing);
  });

  const endDraw = () => {
    if (!drawing) return;
    const meaningful =
      drawing.type === 'marker'
        ? drawing.points.length > 2
        : Math.hypot(drawing.to.x - drawing.from.x, drawing.to.y - drawing.from.y) > 8;
    if (meaningful) marks.push(drawing);
    drawing = null;
    paintMarks();
    paintCrop();
  };
  overlay.addEventListener('pointerup', endDraw);
  overlay.addEventListener('pointercancel', endDraw);

  function openTextInput(screenPoint, sourcePoint) {
    textInput.classList.remove('hidden');
    textInput.style.left = `${screenPoint.x}px`;
    textInput.style.top = `${screenPoint.y}px`;
    textInput.value = '';
    textInput.placeholder = t('edit.textPrompt');
    textInput.style.color = color;
    // 等這一輪點擊事件跑完再聚焦與掛 blur，避免同一次點擊就把自己關掉
    requestAnimationFrame(() => textInput.focus());

    let done = false;
    const commit = () => {
      // 一次性保護：把輸入框藏起來會再觸發一次 blur，沒擋的話同一段文字會被加兩次（實測踩過）
      if (done) return;
      done = true;
      const text = textInput.value.trim();
      textInput.classList.add('hidden');
      textInput.removeEventListener('keydown', onKey);
      textInput.removeEventListener('blur', commit);
      if (!text) return;
      marks.push({ type: 'text', color, size, at: sourcePoint, text });
      paintMarks();
      paintCrop();
    };
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
      if (e.key === 'Escape') {
        textInput.value = '';
        commit();
      }
    };
    textInput.addEventListener('keydown', onKey);
    requestAnimationFrame(() => textInput.addEventListener('blur', commit));
  }

  // ── 動作 ───────────────────────────────────────────
  body.querySelector('[data-act="rotate"]').addEventListener('click', () => {
    rotate = (rotate + 90) % 360;
    working = rotate === 0 ? original : rotateSource(original, rotate);
    fitStage();
    resetCrop();
  });

  body.querySelector('[data-act="undo"]').addEventListener('click', () => {
    marks.pop();
    paintMarks();
    paintCrop();
  });

  body.querySelector('[data-act="clear"]').addEventListener('click', () => {
    marks = [];
    paintMarks();
    paintCrop();
  });

  body.querySelector('[data-act="reset"]').addEventListener('click', () => {
    rotate = 0;
    working = original;
    ratioSelect.value = 'free';
    fitStage();
    resetCrop();
  });

  footer.querySelector('[data-act="cancel"]').addEventListener('click', () => modal.close());

  const applyBtn = footer.querySelector('[data-act="apply"]');
  applyBtn.addEventListener('click', async () => {
    applyBtn.disabled = true;
    const label = applyBtn.querySelector('span');
    const previous = label.textContent;
    label.textContent = t('crop.applying');
    try {
      const result = await renderOutput();
      await onApply({ ...result, rotate, annotations: marks, saveAsNew: saveMode === 'new' });
      modal.close();
    } catch (err) {
      label.textContent = previous;
      applyBtn.disabled = false;
      throw err;
    }
  });

  /** 輸出：旋轉 → 畫標註 → 裁切。跟畫面預覽走同一段 drawAnnotations，所見即所得。 */
  async function renderOutput() {
    const rotated = rotate === 0 ? original : rotateSource(original, rotate);
    const rw = rotated.width ?? rotated.naturalWidth;
    const rh = rotated.height ?? rotated.naturalHeight;

    const full = document.createElement('canvas');
    full.width = rw;
    full.height = rh;
    const fullCtx = full.getContext('2d');
    fullCtx.drawImage(rotated, 0, 0);
    drawAnnotations(fullCtx, marks, { width: sourceW, height: sourceH, rotate, scale: 1 });

    const cropRect = {
      x: Math.round((crop.x - fit.x) / fit.scale),
      y: Math.round((crop.y - fit.y) / fit.scale),
      w: Math.round(crop.w / fit.scale),
      h: Math.round(crop.h / fit.scale),
    };
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.min(cropRect.w, rw - cropRect.x));
    out.height = Math.max(1, Math.min(cropRect.h, rh - cropRect.y));
    out.getContext('2d').drawImage(full, cropRect.x, cropRect.y, out.width, out.height, 0, 0, out.width, out.height);

    const outBlob = await new Promise((resolve, reject) => {
      out.toBlob((b) => (b ? resolve(b) : reject(new Error(t('error.encode')))), 'image/jpeg', 0.92);
    });
    return { blob: outBlob, width: out.width, height: out.height, crop: { ...cropRect, rotate } };
  }

  // 等版面完成再量尺寸，避免量到 0
  requestAnimationFrame(() => {
    fitStage();
    resetCrop();
    selectTool('crop');
  });
  const observer = new ResizeObserver(() => {
    const before = { ...crop };
    const prevFit = { ...fit };
    fitStage();
    if (prevFit.w && fit.w) {
      const k = fit.scale / prevFit.scale;
      crop = {
        x: fit.x + (before.x - prevFit.x) * k,
        y: fit.y + (before.y - prevFit.y) * k,
        w: before.w * k,
        h: before.h * k,
      };
      clampCrop();
      paintCrop();
    }
  });
  observer.observe(stage);

  return modal;
}
