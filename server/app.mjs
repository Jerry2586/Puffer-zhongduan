import http from 'node:http';
import { isIP } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore, sha, failure, now, checkPassword } from './store.mjs';
import { PRODUCTS, publicLicense, customerLicense, authorizedBinding, activate, sign, VERSION } from './license.mjs';
import { createRelease, publicRelease, updateManifest, createJob } from './packages.mjs';
const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export async function createTerminal(options) {
  if (!options.root || !path.isAbsolute(options.root)) throw Error('必须指定源码目录外的绝对运行目录');
  await fs.mkdir(options.root, { recursive: true, mode: 0o700 });
  const root = await fs.realpath(options.root), realSource = await fs.realpath(sourceRoot), relative = path.relative(realSource, root);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) throw Error('运行数据不能放在源码目录');
  const host = options.host || '127.0.0.1', port = options.port ?? 8792;
  const directHttp = options.directHttp === true;
  let origin = options.origin || ('http://127.0.0.1:' + port);
  function validateOrigin(value) {
    const u = new URL(value);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !['http:', 'https:'].includes(u.protocol)) throw Error('终端外部地址必须是完整站点地址');
    if (!directHttp && u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw Error('公网站点必须使用 HTTPS');
    return u.origin;
  }
  origin = validateOrigin(origin);
  if (!directHttp && !['127.0.0.1', 'localhost', '::1'].includes(host) && new URL(origin).protocol !== 'https:') throw Error('公网监听需要 HTTPS 站点地址');
  const store = await openStore(root), sessions = new Map(), limits = new Map();
  const secure = () => origin.startsWith('https:');
  const cookie = (value, maxAge = 28800) => 'puffer_session=' + value + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secure() ? '; Secure' : '');
  function json(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data));
  }
  async function body(req, binary = false, max = binary ? 128 * 1024 * 1024 : 64000) {
    const length = Number(req.headers['content-length']);
    if (Number.isFinite(length) && length > max) throw failure('请求过大', 413);
    const chunks = []; let total = 0;
    for await (const chunk of req) { total += chunk.length; if (total > max) throw failure('请求过大', 413); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    if (binary) return bytes;
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw failure('需要 JSON 请求', 415);
    try { const parsed = JSON.parse(bytes.toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('object required'); return parsed; } catch { throw failure('JSON 必须是对象'); }
  }
  function session(req) {
    const id = String(req.headers.cookie || '').match(/(?:^|;\s*)puffer_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const value = sessions.get(id);
    if (!value || value.exp < Date.now()) { if (id) sessions.delete(id); throw failure('请先登录', 401); }
    return { ...value, id };
  }
  function directRequestOrigin(req) {
    let u;
    try { u = new URL('http://' + req.headers.host); } catch { throw failure('访问地址无效', 400); }
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const configuredHost = options.origin ? new URL(origin).hostname.replace(/^\[|\]$/g, '') : '';
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash || (!isIP(hostname) && hostname !== 'localhost' && hostname !== configuredHost)) throw failure('请使用服务器 IP 或已配置的域名和端口访问', 400);
    return u.origin;
  }
  function requestOrigin(req) {
    if (!directHttp || options.origin) return origin;
    return directRequestOrigin(req);
  }
  function sameOrigin(req) {
    const expected = directHttp ? directRequestOrigin(req) : origin;
    if (req.headers.origin !== expected) throw failure('请求来源不匹配，请使用 ' + expected + ' 访问；经过 HTTPS 代理时请在管理菜单 7 配置域名和共存模式', 403);
  }
  function admin(req, write = false) {
    const s = session(req);
    if (write) { sameOrigin(req); if (req.headers['x-csrf-token'] !== s.csrf) throw failure('操作凭证无效，请刷新页面', 403); }
    return s;
  }
  function readyAdmin(req, write = false) { const s = admin(req, write); if (store.admin.mustChange) throw failure('请先修改初始密码', 428); return s; }
  function rate(req) {
    const key = req.socket.remoteAddress, time = Date.now(), old = limits.get(key);
    if (!old || old.until < time) { if (limits.size > 5000) limits.clear(); limits.set(key, { count: 1, until: time + 300000 }); return; }
    old.count++; if (old.count > 8) throw failure('登录尝试过多，请五分钟后再试', 429);
  }
  function find(array, id, label) { const item = array.find(x => x.id === id); if (!item) throw failure(label + '不存在', 404); return item; }
  async function download(res, file, filename, hash) {
    let bytes; try { bytes = await fs.readFile(path.join(root, 'files', file)); } catch (e) { if (e.code === 'ENOENT') throw failure('文件缺失，请联系管理员', 410); throw e; }
    if (sha(bytes) !== hash) throw failure('文件完整性校验失败', 409);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename), 'X-Artifact-SHA256': hash, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
  }
  function releaseAccess(req, r) {
    const { license, binding } = authorizedBinding(store, req, r.kind === 'software' ? r.product : 'packer');
    if (r.status !== 'published') throw failure('版本尚未发布或已下架', 404);
    if (r.kind === 'client-source' && !license.permissions.sourceDownload) throw failure('未授权源码下载', 403);
    return { license, binding };
  }
  function worker(req) {
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const node = store.state.nodes.find(x => x.tokenHash === sha(token) && x.status === 'active');
    if (!node || !token.startsWith('HTW_')) throw failure('构建节点认证失败', 401);
    return node;
  }
  function jobAuthorized(job) {
    if (job.owner === 'admin') return true;
    const l = store.state.licenses.find(x => x.id === job.owner);
    return !!l && l.status === 'active' && Date.parse(l.expiresAt) > Date.now() && l.products.includes('packer') && l.permissions.cloudBuild;
  }
  function cancelUnauthorizedJobs() {
    let changed = false;
    for (const j of store.state.jobs) if (['queued', 'running'].includes(j.status) && !jobAuthorized(j)) {
      Object.assign(j, { status: 'cancelled', finishedAt: now(), error: '客户授权已失效或在线构建权限已取消' }); changed = true;
    }
    return changed;
  }
  async function handle(req, res) {
    const externalOrigin = requestOrigin(req);
    const u = new URL(req.url, externalOrigin), r = u.pathname, m = req.method;
    if (r === '/healthz' && m === 'GET') return json(res, 200, { ok: true, service: 'puffer-terminal', version: '0.1.3' });
    if (r === '/api/login' && m === 'POST') {
      sameOrigin(req); rate(req); const b = await body(req);
      if (b.username !== 'admin' || typeof b.password !== 'string' || !(await checkPassword(b.password, store.admin))) throw failure('用户名或密码错误', 401);
      for (const [id, value] of sessions) if (value.exp < Date.now()) sessions.delete(id);
      if (sessions.size > 500) throw failure('会话数量已满', 429);
      const id = crypto.randomBytes(32).toString('base64url'), csrf = crypto.randomBytes(24).toString('base64url');
      sessions.set(id, { csrf, exp: Date.now() + 28800000 }); limits.delete(req.socket.remoteAddress);
      res.setHeader('Set-Cookie', cookie(id)); return json(res, 200, { csrf, mustChange: store.admin.mustChange });
    }
    if (r === '/api/session' && m === 'GET') { const s = admin(req); return json(res, 200, { username: 'admin', csrf: s.csrf, mustChange: store.admin.mustChange }); }
    if (r === '/api/logout' && m === 'POST') { const s = admin(req, true); sessions.delete(s.id); res.setHeader('Set-Cookie', cookie('', 0)); return json(res, 200, { ok: true }); }
    if (r === '/api/password' && m === 'POST') {
      const s = admin(req, true), b = await body(req);
      if (typeof b.current !== 'string' || !await checkPassword(b.current, store.admin)) throw failure('当前密码错误', 403);
      if (typeof b.password !== 'string' || b.password.length === 0 || b.password === b.current) throw failure('新密码不能为空，且与原密码不同');
      await store.changePassword(b.password); sessions.clear(); sessions.set(s.id, { csrf: s.csrf, exp: Date.now() + 28800000 });
      store.audit('修改管理员密码', 'admin'); await store.commit(); return json(res, 200, { ok: true });
    }
    if (r.startsWith('/api/')) {
      readyAdmin(req, m !== 'GET');
      if (r === '/api/overview' && m === 'GET') {
        const s = store.state;
        return json(res, 200, { customers: s.customers, licenses: s.licenses.map(publicLicense), bindings: s.bindings, releases: s.releases.map(publicRelease), jobs: s.jobs.map(j => { const { artifact, ...rest } = j; return rest; }), nodes: s.nodes.map(n => { const { tokenHash, ...rest } = n; return rest; }), audit: s.audit.slice(0, 100), settings: s.settings, origin: externalOrigin, publicKey: store.publicKey, keyId: sha(store.publicKey).slice(0, 16), version: '0.1.3' });
      }
      if (r === '/api/customers' && m === 'POST') {
        const b = await body(req), name = String(b.name || '').trim(); if (!name || name.length > 80) throw failure('客户名称为 1–80 字');
        const c = { id: crypto.randomUUID(), name, contact: String(b.contact || '').slice(0, 120), createdAt: now() }; store.state.customers.unshift(c); store.audit('创建客户', c.id); await store.commit(); return json(res, 201, c);
      }
      if (r === '/api/licenses' && m === 'POST') {
        const b = await body(req); find(store.state.customers, b.customerId, '客户');
        if (!Array.isArray(b.products) || !b.products.length || new Set(b.products).size !== b.products.length || b.products.some(p => !PRODUCTS.includes(p))) throw failure('授权产品无效');
        const expiry = Date.parse(b.expiresAt); if (!Number.isFinite(expiry) || expiry <= Date.now()) throw failure('到期时间必须在未来');
        const quotas = {}; for (const p of PRODUCTS) { quotas[p] = Number(b.quotas?.[p] ?? (p === 'operations' ? 1 : 2)); if (!Number.isInteger(quotas[p]) || quotas[p] < 1 || quotas[p] > 100) throw failure('授权名额必须为 1–100'); }
        const key = 'HTN_' + crypto.randomBytes(32).toString('base64url');
        const l = { id: crypto.randomUUID(), customerId: b.customerId, label: String(b.label || '三产品授权').slice(0, 80), products: b.products, quotas, permissions: { sourceDownload: b.permissions?.sourceDownload !== false, localBuild: b.permissions?.localBuild !== false, cloudBuild: b.permissions?.cloudBuild !== false }, status: 'active', expiresAt: new Date(expiry).toISOString(), createdAt: now(), keyHash: sha(key) };
        store.state.licenses.unshift(l); store.audit('签发授权', l.id); await store.commit(); return json(res, 201, { license: publicLicense(l), key });
      }
      const lr = r.match(/^\/api\/licenses\/([a-f0-9-]{36})(\/rotate)?$/);
      if (lr) {
        const l = find(store.state.licenses, lr[1], '授权');
        if (m === 'PATCH' && !lr[2]) {
          const b = await body(req);
          if (b.status !== undefined) { if (!['active', 'disabled'].includes(b.status)) throw failure('授权状态无效'); l.status = b.status; }
          if (b.expiresAt !== undefined) { const exp = Date.parse(b.expiresAt); if (!Number.isFinite(exp) || exp <= Date.now()) throw failure('续期时间必须在未来'); l.expiresAt = new Date(exp).toISOString(); }
          cancelUnauthorizedJobs(); store.audit('修改授权状态或续期', l.id); await store.commit(); return json(res, 200, publicLicense(l));
        }
        if (m === 'POST' && lr[2]) { const key = 'HTN_' + crypto.randomBytes(32).toString('base64url'); l.keyHash = sha(key); store.audit('轮换授权 Key', l.id); await store.commit(); return json(res, 200, { key }); }
      }
      const br = r.match(/^\/api\/bindings\/([a-f0-9-]{36})$/);
      if (br && m === 'PATCH') { const b = await body(req), binding = find(store.state.bindings, br[1], '绑定'); if (!['active', 'disabled'].includes(b.status)) throw failure('绑定状态无效'); if (b.status === 'active') { const l = find(store.state.licenses, binding.licenseId, '授权'); if (store.state.bindings.filter(x => x.id !== binding.id && x.licenseId === l.id && x.product === binding.product && x.status === 'active').length >= l.quotas[binding.product]) throw failure('名额已满', 409); } binding.status = b.status; store.audit('修改绑定状态', binding.id); await store.commit(); return json(res, 200, binding); }
      if (r === '/api/releases' && m === 'POST') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw failure('请选择上传文件', 415);
        let meta; try { meta = JSON.parse(decodeURIComponent(req.headers['x-release-metadata'] || '')); } catch { throw failure('版本元信息无效'); }
        return json(res, 201, await createRelease(store, meta, await body(req, true)));
      }
      const rr = r.match(/^\/api\/releases\/([a-f0-9-]{36})(\/download)?$/);
      if (rr) {
        const release = find(store.state.releases, rr[1], '版本');
        if (rr[2] && m === 'GET') return download(res, release.file, release.filename, release.sha256);
        if (!rr[2] && m === 'PATCH') {
          const b = await body(req); if (!['published', 'withdrawn'].includes(b.status)) throw failure('发布状态无效');
          if (b.status === 'published') { await fs.access(path.join(root, 'files', release.file)); if (sha(await fs.readFile(path.join(root, 'files', release.file))) !== release.sha256) throw failure('文件损坏，不能发布', 409); release.publishedAt = now(); }
          release.status = b.status; store.audit(b.status === 'published' ? '发布版本' : '下架版本', release.id); await store.commit(); return json(res, 200, publicRelease(release));
        }
      }
      if (r === '/api/jobs' && m === 'POST') { const job = createJob(store, await body(req)); await store.commit(); return json(res, 201, job); }
      const jr = r.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/(?:cancel|artifact))?$/);
      if (jr) { const job = find(store.state.jobs, jr[1], '任务'); if (jr[2] === '/cancel' && m === 'POST') { if (!['queued', 'running'].includes(job.status)) throw failure('此任务不能取消', 409); job.status = 'cancelled'; job.finishedAt = now(); job.logs.push('管理员取消任务。'); store.audit('取消构建', job.id); await store.commit(); return json(res, 200, { ok: true }); } if (jr[2] === '/artifact' && m === 'GET') { if (job.status !== 'complete') throw failure('任务没有成品', 409); return download(res, job.artifact.file, job.artifact.filename, job.artifact.sha256); } if (!jr[2] && m === 'GET') return json(res, 200, job); }
      if (r === '/api/nodes' && m === 'POST') {
        const b = await body(req); if (!String(b.name || '').trim() || !Array.isArray(b.targets) || !b.targets.length || b.targets.some(t => !['android', 'ios', 'windows', 'web'].includes(t))) throw failure('节点名称或构建目标无效');
        const token = 'HTW_' + crypto.randomBytes(32).toString('base64url'), node = { id: crypto.randomUUID(), name: String(b.name).slice(0, 80), targets: [...new Set(b.targets)], status: 'active', tokenHash: sha(token), createdAt: now(), lastSeenAt: null };
        store.state.nodes.unshift(node); store.audit('登记构建节点', node.id); await store.commit(); const { tokenHash, ...clean } = node; return json(res, 201, { node: clean, token });
      }
      const nr = r.match(/^\/api\/nodes\/([a-f0-9-]{36})$/);
      if (nr && m === 'PATCH') { const node = find(store.state.nodes, nr[1], '节点'), b = await body(req); if (!['active', 'disabled'].includes(b.status)) throw failure('节点状态无效'); node.status = b.status; store.audit('修改节点状态', node.id); await store.commit(); return json(res, 200, { ok: true }); }
      if (r === '/api/settings' && m === 'PATCH') { const b = await body(req); if (!Number.isInteger(b.offlineDays) || b.offlineDays < 1 || b.offlineDays > 30 || !Number.isInteger(b.checkHours) || b.checkHours < 1 || b.checkHours > b.offlineDays * 24) throw failure('离线期限为 1–30 天，检查间隔不能超过该期限'); store.state.settings = { offlineDays: b.offlineDays, checkHours: b.checkHours }; store.audit('修改授权策略', 'settings'); await store.commit(); return json(res, 200, store.state.settings); }
      throw failure('管理接口不存在', 404);
    }
    if (r === '/v1/license/public-key' && m === 'GET') return json(res, 200, { issuer: externalOrigin, algorithm: 'Ed25519', keyId: sha(store.publicKey).slice(0, 16), publicKey: store.publicKey });
    if (['/v1/license/activate', '/v1/license/check'].includes(r) && m === 'POST') { const result = activate(store, req, await body(req), externalOrigin); await store.commit(); return json(res, 200, result); }
    if (r === '/v1/updates' && m === 'GET') { const product = u.searchParams.get('product'); authorizedBinding(store, req, product); return json(res, 200, updateManifest(store, product, u.searchParams.get('version'), u.searchParams.get('platform'), u.searchParams.get('arch') || 'any', u.searchParams.get('channel') || 'stable', externalOrigin)); }
    if (r === '/v1/installations/report' && m === 'POST') { const { binding } = authorizedBinding(store, req), b = await body(req); if (!VERSION.test(b.version || '') || !['current', 'updating', 'failed'].includes(b.updateStatus)) throw failure('安装状态无效'); Object.assign(binding, { version: b.version, updateStatus: b.updateStatus, updateError: String(b.error || '').slice(0, 300), lastSeenAt: now() }); await store.commit(); return json(res, 200, { ok: true }); }
    if (r === '/v1/catalog' && m === 'GET') { const { license } = authorizedBinding(store, req, 'packer'); return json(res, 200, { releases: store.state.releases.filter(x => x.status === 'published' && x.kind !== 'software' && (x.kind !== 'client-source' || license.permissions.sourceDownload)).map(publicRelease), permissions: license.permissions }); }
    const cr = r.match(/^\/v1\/releases\/([a-f0-9-]{36})\/download$/);
    if (cr && m === 'GET') { const release = find(store.state.releases, cr[1], '版本'); releaseAccess(req, release); return download(res, release.file, release.filename, release.sha256); }
    if (r === '/v1/jobs') { const { license } = authorizedBinding(store, req, 'packer'); if (!license.permissions.cloudBuild) throw failure('未授权在线构建', 403); if (m === 'GET') return json(res, 200, { jobs: store.state.jobs.filter(j => j.owner === license.id).map(j => { const { artifact, ...rest } = j; return rest; }) }); if (m === 'POST') { const job = createJob(store, await body(req), license.id); await store.commit(); return json(res, 201, job); } }
    const customerJob = r.match(/^\/v1\/jobs\/([a-f0-9-]{36})(\/artifact)?$/);
    if (customerJob && m === 'GET') { const { license } = authorizedBinding(store, req, 'packer'); if (!license.permissions.cloudBuild) throw failure('未授权在线构建', 403); const job = find(store.state.jobs.filter(j => j.owner === license.id), customerJob[1], '任务'); if (customerJob[2]) { if (job.status !== 'complete') throw failure('任务没有成品', 409); return download(res, job.artifact.file, job.artifact.filename, job.artifact.sha256); } const { artifact, ...rest } = job; return json(res, 200, rest); }
    if (r.startsWith('/v1/worker/')) {
      const node = worker(req);
      if (r === '/v1/worker/claim' && m === 'POST') {
        await body(req); node.lastSeenAt = now(); cancelUnauthorizedJobs();
        const job = store.state.jobs.filter(j => j.status === 'queued' && node.targets.includes(j.target)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!job) { await store.commit(); return json(res, 200, { job: null }); }
        Object.assign(job, { status: 'running', nodeId: node.id, startedAt: now(), heartbeatAt: now() }); job.logs.push('节点已领取任务：' + node.name); await store.commit(); return json(res, 200, { job, source: publicRelease(find(store.state.releases, job.sourceId, '源码')), theme: publicRelease(find(store.state.releases, job.themeId, '主题')) });
      }
      const wr = r.match(/^\/v1\/worker\/jobs\/([a-f0-9-]{36})\/(source|theme|heartbeat|artifact|fail)$/);
      if (wr) {
        const job = find(store.state.jobs, wr[1], '任务'); if (!jobAuthorized(job)) throw failure('任务客户授权已失效', 403); if (job.nodeId !== node.id || job.status !== 'running') throw failure('任务不属于此节点或已经结束', 409);
        if (['source', 'theme'].includes(wr[2]) && m === 'GET') { const release = find(store.state.releases, job[wr[2] + 'Id'], '构建文件'); return download(res, release.file, release.filename, release.sha256); }
        if (m === 'POST' && wr[2] === 'heartbeat') { const b = await body(req); node.lastSeenAt = job.heartbeatAt = now(); if (b.log) job.logs.push(String(b.log).replace(/HT[NW]_[A-Za-z0-9_-]+/g, '[已隐藏凭据]').slice(0, 500)); job.logs = job.logs.slice(-200); await store.commit(); return json(res, 200, { ok: true }); }
        if (m === 'POST' && wr[2] === 'fail') { const b = await body(req); job.status = 'failed'; job.error = String(b.error || '节点构建失败').replace(/HT[NW]_[A-Za-z0-9_-]+/g, '[已隐藏凭据]').slice(0, 500); job.finishedAt = now(); await store.commit(); return json(res, 200, { ok: true }); }
        if (m === 'POST' && wr[2] === 'artifact') {
          if (req.headers['content-type'] !== 'application/octet-stream') throw failure('需要二进制产物', 415);
          const filename = String(u.searchParams.get('filename') || ''), allowed = { android: /\.(apk|aab)$/i, ios: /\.ipa$/i, windows: /\.exe$/i, web: /\.zip$/i };
          if (filename.length > 160 || /[\\/\x00-\x1f]/.test(filename) || !allowed[job.target].test(filename)) throw failure('产物类型与任务不匹配');
          const bytes = await body(req, true); if (bytes.length < 4 || (job.target === 'windows' ? bytes.subarray(0, 2).toString() !== 'MZ' : bytes.readUInt32LE(0) !== 0x04034b50)) throw failure('产物格式无效');
          const hash = sha(bytes); if (hash !== req.headers['x-artifact-sha256']) throw failure('产物哈希不符', 409);
          const file = crypto.randomUUID() + '.bin'; await fs.writeFile(path.join(root, 'files', file), bytes, { flag: 'wx', mode: 0o600 });
          Object.assign(job, { artifact: { file, filename, bytes: bytes.length, sha256: hash }, status: 'complete', finishedAt: now() }); job.logs.push('收到节点产物，传输完整性已核验；原生签名由构建节点负责。'); store.audit('构建节点回传产物', job.id); await store.commit(); return json(res, 201, { ok: true, sha256: hash });
        }
      }
      throw failure('节点接口不存在', 404);
    }
    if (m === 'GET' && ['/', '/app.js', '/style.css', '/logo.svg'].includes(r)) {
      const name = r === '/' ? 'index.html' : r.slice(1), bytes = await fs.readFile(path.join(sourceRoot, 'public', name));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)], 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); return res.end(bytes);
    }
    throw failure('接口不存在', 404);
  }
  const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
    const run = () => handle(req, res);
    const task = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? store.serial(run) : run();
    task.catch(e => { if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : '服务内部错误，请检查运行日志' }); else res.end(); if (!e.status) console.error(e.message); });
  });
  server.requestTimeout = 120000; server.headersTimeout = 20000; server.maxHeadersCount = 60;
  const timer = setInterval(() => store.serial(async () => {
    let changed = cancelUnauthorizedJobs();
    for (const job of store.state.jobs) if (job.status === 'running' && Date.parse(job.heartbeatAt) < Date.now() - 300000) { job.status = 'failed'; job.error = '构建节点超过五分钟未报告状态'; job.finishedAt = now(); changed = true; }
    if (changed) await store.commit();
  }).catch(e => console.error(e.message)), 30000); timer.unref();
  return { server, store, get origin() { return origin; }, async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); }); if (port === 0 && !options.origin) origin = 'http://127.0.0.1:' + server.address().port; return origin; }, async close() { clearInterval(timer); server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); } };
}
