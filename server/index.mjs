import { createTerminal } from './app.mjs';
const app = await createTerminal({ root: process.env.HETUN_TERMINAL_STATE, host: process.env.HETUN_TERMINAL_HOST || '127.0.0.1', port: Number(process.env.HETUN_TERMINAL_PORT || 8792), directHttp: process.env.HETUN_TERMINAL_DIRECT_HTTP === 'true', origin: process.env.HETUN_TERMINAL_ORIGIN });
console.log('河豚终端已启动：' + await app.listen());
console.log('初始管理员凭据保存在外部运行目录 bootstrap-admin.txt；首次登录必须修改。');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await app.close(); process.exit(0); });
