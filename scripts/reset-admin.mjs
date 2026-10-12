import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { passwordRecord, atomic } from '../server/store.mjs';
const root = process.env.HETUN_TERMINAL_STATE;
if (!root || !path.isAbsolute(root)) throw Error('需要外部运行目录。仅在停止终端服务后执行。');
await fs.access(path.join(root, 'admin.json'));
let password = '';
if (process.argv.includes('--stdin')) {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    password += chunk.toString('utf8');
  }
}
const custom = password.length > 0;
if (!custom) password = crypto.randomBytes(18).toString('base64url');
await atomic(path.join(root, 'admin.json'), { username: 'admin', ...await passwordRecord(password), mustChange: !custom });
if (custom) {
  await fs.unlink(path.join(root, 'bootstrap-admin.txt')).catch(e => { if (e.code !== 'ENOENT') throw e; });
} else {
  await fs.writeFile(path.join(root, 'bootstrap-admin.txt'), '用户名：admin\n密码：' + password + '\n首次登录必须修改密码。\n', { mode: 0o600 });
}
console.log(custom ? '管理员密码已修改。' : '管理员已重置为随机密码。');
