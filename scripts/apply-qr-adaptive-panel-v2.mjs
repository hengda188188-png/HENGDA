import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'web', 'js', 'desktop', 'projects.js');
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

function literal(before, after, label) {
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label} 錨點數量應為 1，實際為 ${count}`);
  source = source.replace(before, after);
}

literal(
  "import { openModal, confirmDialog } from '../ui/overlay.js';",
  "import { openModal, confirmDialog } from '../ui/overlay.js';\nimport { openAdaptivePanel } from '../ui/adaptive-panel.js';",
  'adaptive panel import');
literal(
  "const QR_OPEN_KEY = 'photo-relay:qr-open';",
  "const QR_OPEN_KEY = 'photo-relay:qr-open';\nlet qrHandle = null;",
  'QR handle');

if (!source.includes('body: els.panelInner')) {
  const pattern = /\/\*\* QR 面板開合[^\n]*\nfunction setQrOpen\(open\) \{[\s\S]*?\n\}\n\nexport function initProjects/;
  const matches = source.match(pattern);
  if (!matches) throw new Error('找不到 setQrOpen 函式邊界');
  source = source.replace(pattern, `/** QR 是短暫任務：桌機 Drawer／手機 Sheet，不再把整個工作區往下推。 */
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
}

export function initProjects`);
}

literal(
  "    qrBox: root.querySelector('[data-role=\"qr-box\"]'),",
  "    qrBox: root.querySelector('[data-role=\"qr-box\"]'),\n    panelHost: root.querySelector('#qr-panel'),\n    panelInner: root.querySelector('#qr-panel .qr-panel-inner'),",
  'QR panel refs');
literal(
  "      await selectProject(project.id);\n    } catch (err) {",
  "      await selectProject(project.id);\n      setQrOpen(true); // 新專案第一次自動開啟掃碼面板\n    } catch (err) {",
  'new project opens QR');

fs.writeFileSync(file, source, 'utf8');
console.log('QR adaptive panel migration applied');

