import { failure } from './store.mjs';

export function authorizationMutation(url, method) {
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) return false;
  const route = String(url || '').split('?')[0];
  return /^\/api\/(?:licenses(?:\/[^/]+(?:\/rotate)?)?|bindings\/[^/]+|authorization-policy|settings|migration\/(?:start|cancel|address|finish|import))$/.test(route);
}

export function createAuthorizationWatch({ heartbeatMs = 15000, maxConnections = 1000, perBinding = 3 } = {}) {
  const watchers = new Set();
  function remove(watcher) {
    if (!watchers.delete(watcher)) return;
    clearInterval(watcher.timer);
    watcher.res.removeListener('close', watcher.cleanup);
    watcher.res.removeListener('error', watcher.cleanup);
    if (!watcher.res.destroyed) watcher.res.destroy();
  }
  function write(watcher, text) {
    try {
      if (watcher.res.destroyed || watcher.res.writableEnded || !watcher.res.write(text)) remove(watcher);
    } catch { remove(watcher); }
  }
  return {
    get size() { return watchers.size; },
    add(res, binding) {
      if (watchers.size >= maxConnections) throw failure('通知连接已达上限', 503);
      if ([...watchers].filter(w => w.bindingId === binding.id).length >= perBinding) throw failure('此设备通知连接过多', 429);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const watcher = { res, bindingId: binding.id };
      watcher.cleanup = () => remove(watcher);
      watchers.add(watcher);
      res.once('close', watcher.cleanup);
      res.once('error', watcher.cleanup);
      watcher.timer = setInterval(() => write(watcher, ': heartbeat\n\n'), heartbeatMs);
      watcher.timer.unref();
      write(watcher, ': connected\n\n');
    },
    notify() { for (const watcher of watchers) write(watcher, 'event: authorization\ndata: changed\n\n'); },
    close() { for (const watcher of watchers) remove(watcher); }
  };
}
