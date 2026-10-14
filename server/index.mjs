import { createTerminal } from './app.mjs';
let app;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await app?.close(); }
  catch { console.error('终端关闭失败，请检查运行日志'); process.exitCode = 1; }
}
try {
  app = await createTerminal({ root: process.env.HETUN_TERMINAL_STATE, host: process.env.HETUN_TERMINAL_HOST || '127.0.0.1', port: Number(process.env.HETUN_TERMINAL_PORT || 8792), directHttp: process.env.HETUN_TERMINAL_DIRECT_HTTP === 'true', origin: process.env.HETUN_TERMINAL_ORIGIN });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
  console.log('河豚终端已启动：' + await app.listen());
  console.log('初始管理员凭据保存在外部运行目录 bootstrap-admin.txt；首次登录必须修改。');
} catch (error) {
  await stop();
  console.error('终端启动失败：' + (error.code || error.message));
  process.exitCode = 1;
}
