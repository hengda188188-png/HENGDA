/**
 * photo-relay 單一入口。
 * 啟動 → 載入資料 → 掛路由 → 印出電腦端網址與手機端提示。
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { settings } from './src/config.mjs';
import { handleRequest } from './src/routes/index.mjs';
import * as store from './src/store.mjs';
import { listLanAddresses } from './src/lib/lan-ip.mjs';
import { log } from './src/lib/log.mjs';

store.init();

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

// 手機傳大圖時，慢速網路不要被預設 timeout 砍斷
server.requestTimeout = 10 * 60_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 60_000;

const port = settings().port;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`埠 ${port} 已被占用。改用其他埠：set PHOTO_RELAY_PORT=4902 後重新啟動，或到設定頁改埠。`);
    process.exit(1);
  }
  log.error('伺服器錯誤', err.message);
});

server.listen(port, '0.0.0.0', () => {
  const addresses = listLanAddresses();
  log.info('photo-relay 已啟動');
  log.info(`  電腦端工作台：http://localhost:${port}`);
  if (addresses.length) {
    log.info(`  手機掃碼會連到：http://${addresses[0].address}:${port}  （${addresses[0].iface}）`);
  } else {
    log.warn('  偵測不到區網 IP —— 手機將無法連線，請先讓這台電腦連上 Wi-Fi。');
  }

  // 桌面捷徑會帶 --open：啟動後直接把工作台開起來，使用者不必自己貼網址
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', `http://localhost:${port}`], { detached: true, stdio: 'ignore' }).unref();
  }
});

const shutdown = async (signal) => {
  log.info(`收到 ${signal}，正在收尾…`);
  server.close();
  await store.flush();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('未處理的 Promise 錯誤', err?.stack ?? String(err)));
