import { initializePackages } from './authorization-packages.mjs';
import {authorizationLog} from './authorization-log.mjs';
import { initializeCommunications } from './communications.mjs';
import { initializeAuthority } from './authority.mjs';
import { initializeCenter } from './product-center.mjs';
import fs from 'node:fs/promises';
import { recoverMigration } from './migration.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(crypto.scrypt);
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export async function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 32)).toString('hex') };
}
export async function checkPassword(password, record) {
  const actual = await scrypt(password, record.salt, 32);
  return crypto.timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
}
export async function atomic(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, file);
  } catch (e) { await fs.unlink(temp).catch(() => {}); throw e; }
}
export async function openStore(root) {
  await recoverMigration(root);
  // Transfer plaintext is never retained after a crashed migration or export.
  for(const entry of await fs.readdir(root,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;}))if(entry.isDirectory()&&/^\.transfer-[A-Za-z0-9]+$/.test(entry.name)){const temporary=path.resolve(root,entry.name);if(path.dirname(temporary)!==path.resolve(root))throw Error('迁移临时目录越界');await fs.rm(temporary,{recursive:true,force:true});}
  for (const d of ['keys', 'files', 'logs']) await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
  const file = path.join(root, 'data.json');
  let state;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    state = { schemaVersion: 1, customers: [], licenses: [], bindings: [], releases: [], jobs: [], nodes: [], audit: [], settings: { offlineDays: 7, checkHours: 24 } };
  }
  if (state.schemaVersion !== 1) throw new Error('数据版本不兼容，禁止覆盖');
  state.authorizationLogs ??= []; state.revocations ??= []; state.settings.authorizationLogDays ??= 365;
  initializeCenter(state);
  initializePackages(state);
  initializeCommunications(state);
  initializeAuthority(state);
  let admin;
  try { admin = JSON.parse(await fs.readFile(path.join(root, 'admin.json'), 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const password = crypto.randomBytes(18).toString('base64url');
    admin = { username: 'admin', ...await passwordRecord(password), mustChange: true };
    await atomic(path.join(root, 'admin.json'), admin);
    await fs.writeFile(path.join(root, 'bootstrap-admin.txt'), '用户名：admin\n密码：' + password + '\n首次登录必须修改密码。此文件为私有运行数据。\n', { mode: 0o600, flag: 'wx' });
  }
  let privateKey, publicKey;
  try {
    privateKey = await fs.readFile(path.join(root, 'keys/private.pem'), 'utf8');
    publicKey = await fs.readFile(path.join(root, 'keys/public.pem'), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (await fs.stat(path.join(root, 'keys/private.pem')).then(() => true, () => false)) throw new Error('授权公钥缺失，禁止替换已有私钥');
    const pair = crypto.generateKeyPairSync('ed25519');
    privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
    publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
    await fs.writeFile(path.join(root, 'keys/private.pem'), privateKey, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(path.join(root, 'keys/public.pem'), publicKey, { mode: 0o600, flag: 'wx' });
  }
  // 断电后的任务不假装完成，也不把同一任务同时分发两次。
  for (const job of state.jobs) if (job.status === 'running') Object.assign(job, { status: 'failed', error: '终端重启中断了构建，请重新提交', finishedAt: now() });
  await atomic(file, state);
  let tail = Promise.resolve();
  const store = {
    root, state, admin, privateKey, publicKey,
    commit: () => atomic(file, store.state),
    audit(action, target) {
      store.state.audit.unshift({ id: crypto.randomUUID(), action, target, at: now() });
      const l=store.state.licenses.find(x=>x.id===target)||store.state.revocations.find(x=>x.id===target),b=store.state.bindings.find(x=>x.id===target);
      if(l||b)authorizationLog(store,{licenseId:l?.id||b.licenseId,activationId:b?.id,product:b?.product,deviceId:b?.binding,type:'admin-action',result:'applied',action});
      store.state.audit.length = Math.min(store.state.audit.length, 2000);
    },
    serial(fn) {
      const run = tail.catch(() => {}).then(async () => {
        const before = structuredClone(store.state);
        try { return await fn(); } catch (e) { store.state = before; throw e; }
      });
      tail = run;
      return run;
    },
    drain: () => tail.catch(() => {}),
    async changePassword(password) {
      const next = { username: 'admin', ...await passwordRecord(password), mustChange: false };
      await atomic(path.join(root, 'admin.json'), next);
      store.admin = next;
      await fs.unlink(path.join(root, 'bootstrap-admin.txt')).catch(e => { if (e.code !== 'ENOENT') throw e; });
    }
  };
  return store;
}
