import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireInstance } from '../server/instance.mjs';
import { createTerminal } from '../server/app.mjs';
import { createAuthorizationWatch, authorizationMutation } from '../server/authorization-watch.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'puffer-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('同一运行目录跨进程拒绝重复实例，异常退出后自动恢复', async t => {
  const root = await directory(t);
  const module = new URL('../server/instance.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { acquireInstance } from ${JSON.stringify(module)}; await acquireInstance(${JSON.stringify(root)}); console.log('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', () => reject(Error('子进程未建立实例保护')));
  });
  await ready;
  await assert.rejects(acquireInstance(root), /已有终端实例/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const release = await acquireInstance(root); await release(); await release();
});
test('重复创建不会修改运行数据，关闭后可以再次打开', async t => {
  const root = await directory(t);
  const app = await createTerminal({ root, port: 0 });
  t.after(() => app.close());
  const before = await fs.readFile(path.join(root, 'data.json'));
  await assert.rejects(createTerminal({ root, port: 0 }), /已有终端实例/);
  assert.deepEqual(await fs.readFile(path.join(root, 'data.json')), before);
  await Promise.all([app.close(), app.close()]);
  const next = await createTerminal({ root, port: 0 }); await next.listen(); await next.close();
});
test('监听失败释放实例保护，不遗留定时器和占用', async t => {
  const root = await directory(t);
  const busy = net.createServer(); await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => busy.close(resolve)));
  const app = await createTerminal({ root, port: busy.address().port });
  await assert.rejects(app.listen(), { code: 'EADDRINUSE' }); await app.close();
  const next = await createTerminal({ root, port: 0 }); await next.listen(); await next.close();
});
test('运行数据损坏时启动失败释放保护', async t => {
  const root = await directory(t);
  await fs.writeFile(path.join(root, 'data.json'), '{broken');
  await assert.rejects(createTerminal({ root, port: 0 }));
  const release = await acquireInstance(await fs.realpath(root)); await release();
});
class Response extends EventEmitter {
  chunks = []; destroyed = false; writableEnded = false; accepting = true;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(chunk); return this.accepting; }
  destroy() { this.destroyed = true; this.emit('close'); }
}
test('通知限制、断开清理、慢连接保护与关闭可重复执行', () => {
  const hub = createAuthorizationWatch({ perBinding: 1, maxConnections: 2 });
  const a = new Response(), b = new Response(); hub.add(a, { id: 'a' });
  assert.throws(() => hub.add(new Response(), { id: 'a' }), { status: 429 });
  hub.add(b, { id: 'b' });
  assert.throws(() => hub.add(new Response(), { id: 'c' }), { status: 503 });
  hub.notify(); assert.match(a.chunks.at(-1), /event: authorization/);
  a.accepting = false; hub.notify(); assert.equal(hub.size, 1); assert.equal(a.destroyed, true);
  b.emit('error', Error('connection closed')); assert.equal(hub.size, 0);
  const c = new Response(); hub.add(c, { id: 'c' }); hub.close(); hub.close(); assert.equal(hub.size, 0);
});
test('公告、版本和登录操作不触发授权通知，授权与迁移操作触发', () => {
  for (const route of ['/api/licenses', '/api/licenses/id', '/api/licenses/id/rotate', '/api/bindings/id', '/api/authorization-policy', '/api/settings', '/api/migration/import']) assert.equal(authorizationMutation(route, 'PATCH'), true, route);
  for (const route of ['/api/login', '/api/password', '/api/announcements', '/api/releases/id', '/api/repositories/id', '/api/migration/export']) assert.equal(authorizationMutation(route, 'POST'), false, route);
  assert.equal(authorizationMutation('/api/licenses', 'GET'), false);
});
