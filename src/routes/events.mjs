/** SSE 即時同步：手機一傳完，電腦端立刻長出縮圖（F5）。 */
import { subscribe } from '../lib/bus.mjs';
import { log } from '../lib/log.mjs';

const HEARTBEAT_MS = 25_000;

export async function stream({ req, res, query }) {
  const projectId = query.get('projectId') ?? '';

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);
  res.write(`event: ready\ndata: ${JSON.stringify({ projectId })}\n\n`);

  const send = (event) => {
    if (projectId && event.projectId && event.projectId !== projectId) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on('close', close);
  req.on('error', (err) => {
    log.warn('SSE 連線中斷', err.message);
    close();
  });

  await new Promise((resolve) => req.on('close', resolve));
}
