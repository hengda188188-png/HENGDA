import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  html: path.join(root, 'web', 'desktop.html'),
  projects: path.join(root, 'web', 'js', 'desktop', 'projects.js'),
};

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source; // 可安全重跑
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label} 錨點數量應為 1，實際為 ${count}；停止避免誤改`);
  return source.replace(before, after);
}

let html = fs.readFileSync(files.html, 'utf8');
html = replaceOnce(html,
  '<link rel="stylesheet" href="/assets/css/overlay.css">',
  '<link rel="stylesheet" href="/assets/css/overlay.css">\n<link rel="stylesheet" href="/assets/css/adaptive-panel.css">',
  'adaptive-panel.css');
fs.writeFileSync(files.html, html, 'utf8');

let js = fs.readFileSync(files.projects, 'utf8');
js = replaceOnce(js,
  "import { openModal, confirmDialog } from '../ui/overlay.js';",
  "import { openModal, confirmDialog } from '../ui/overlay.js';\nimport { openAdaptivePanel } from '../ui/adaptive-panel.js';",
  'adaptive panel import');
js = replaceOnce(js,
  "const QR_OPEN_KEY = 'photo-relay:qr-open';",
  "const QR_OPEN_KEY = 'photo-relay:qr-open';\nlet qrHandle = null;",
  'QR handle');
js = replaceOnce(js,
`/** QR 面板開合。收起來時完全不佔空間，展開才往下滑出 */
function setQrOpen(open) {
  els.dock.dataset.open = String(open);
  els.toggle.setAttribute('aria-expanded', String(open));
  els.toggleLabel.textContent = open ? t('qr.hide') : t('qr.show');
  localStorage.setItem(QR_OPEN_KEY, open ? '1' : '0');
  if (open) renderQr(); // 收起時不必畫，展開才渲染
}`,
`/** QR 是短暫任務：桌機 Drawer／手機 Sheet，不再把整個工作區往下推。 */
function setQrOpen(open) {
  if (!open && qrHandle) {
    const current = qrHandle;
    qrHandle = null;
    current.close();
    return;
  }
  if (open && qrHandle) return;
  els.dock.dataset.open = String(open);
  els.toggle.setAttribute('aria-expanded', String(open));
  els.toggleLabel.textContent = open ? t('qr.hide') : t('qr.show');
  localStorage.setItem(QR_OPEN_KEY, open ? '1' : '0');
  if (!open) return;
  renderQr();
  qrHandle = openAdaptivePanel({
    title: t('qr.title'),
    body: els.panelInner,
    width: 'min(460px, 92vw)',
    onClose: () => {
      els.panelHost.append(els.panelInner);
      qrHandle = null;
      els.dock.dataset.open = 'false';
      els.toggle.setAttribute('aria-expanded', 'false');
      els.toggleLabel.textContent = t('qr.show');
      localStorage.setItem(QR_OPEN_KEY, '0');
    },
  });
}`,
  'setQrOpen');
js = replaceOnce(js,
  "qrBox: root.querySelector('[data-role=\"qr-box\"]'),",
  "qrBox: root.querySelector('[data-role=\"qr-box\"]'),\n    panelHost: root.querySelector('#qr-panel'),\n    panelInner: root.querySelector('#qr-panel .qr-panel-inner'),",
  'QR panel refs');
js = replaceOnce(js,
  "      await selectProject(project.id);\n    } catch (err) {",
  "      await selectProject(project.id);\n      setQrOpen(true); // 新專案第一次自動開啟掃碼面板\n    } catch (err) {",
  'new project opens QR');
fs.writeFileSync(files.projects, js, 'utf8');
console.log('QR adaptive panel migration applied');

