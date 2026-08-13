/** 極簡日誌：時間戳 + 等級 + 訊息，錯誤另存 data/error.log 供事後追查（禁靜默失敗）。 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.mjs';

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

function write(level, args) {
  const line = `[${stamp()}] ${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  if (level === 'ERROR') {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.appendFileSync(path.join(DATA_DIR, 'error.log'), line + '\n', 'utf8');
    } catch {
      /* 日誌寫不進去不能反過來弄死主流程 */
    }
  }
}

export const log = {
  info: (...args) => write('INFO ', args),
  warn: (...args) => write('WARN ', args),
  error: (...args) => write('ERROR', args),
};
