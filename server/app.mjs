import { savePackage, packageGrant, initializePackages } from './authorization-packages.mjs';
import { acquireInstance } from './instance.mjs';
import { createAuthorizationWatch, authorizationMutation } from './authorization-watch.mjs';
import { updateSoftware } from './software-update.mjs';
import { authorizationLog, requestIP, createGeoLookup, knownLicense, filteredLogs, reportEvents } from './authorization-log.mjs';
import { saveCommunication, sendSoftwarePush, changeCommunication, communicationFeed, acknowledgeCommunication, updateDistribution } from './communications.mjs';
import { initializeAuthority, migrating, identity, configuration, startMigration, verifyDestination, finishMigration, acknowledge, progress, endpoint } from './authority.mjs';
import { exportMigrationFile, receiveMigration, inspectMigrationFile } from './migration-stream.mjs';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { initializeCenter, policy, policyFields, history, recordEvent, setRepository, checkRepository, downloadAsset, RESOURCES } from './product-center.mjs';
import http from 'node:http';
import { selfUpdater } from './self-update.mjs';
import { importMigration, emptyTarget } from './migration.mjs';
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
  const updater = selfUpdater({directory:options.maintenanceDirectory || process.env.HETUN_TERMINAL_MAINTENANCE, revision:options.revision || process.env.HETUN_TERMINAL_REVISION || '', fetcher:options.updateFetch});
  const releaseInstance = await acquireInstance(root);
  try {
  const store = await openStore(root), sessions = new Map(), limits = new Map();
  const geoLookup=createGeoLookup({lookup:options.geoLookup,fetcher:options.geoFetch,token:options.geoToken});
  async function network(req){const ip=requestIP(req,options.trustedProxies);return {ip,...await geoLookup(ip)};}
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
    if (req.headers.origin !== expected) throw failure('请求来源不匹配，请使用 ' + expected + ' 访问；经过 HTTPS 代理时请在管理菜单 2 配置域名', 403);
  }
  function admin(req, write = false) {
    const s = session(req);
    if (write) { sameOrigin(req); if (req.headers['x-csrf-token'] !== s.csrf) throw failure('操作凭证无效，请刷新页面', 403); }
    return s;
  }
  function readyAdmin(req, write = false) { const s = admin(req, write); if (store.admin.mustChange) throw failure('请先修改初始密码', 428); return s; }
  function rate(req,maximum=8,bucket="login") {
    const key = bucket+":"+req.socket.remoteAddress, time = Date.now(), old = limits.get(key);
    if (!old || old.until < time) { if (limits.size > 5000) limits.clear(); limits.set(key, { count: 1, until: time + 300000 }); return; }
    old.count++; if (old.count > maximum) throw failure('登录尝试过多，请五分钟后再试', 429);
  }
  function find(array, id, label) { const item = array.find(x => x.id === id); if (!item) throw failure(label + '不存在', 404); return item; }
  async function download(res, file, filename, hash) {
    let bytes; try { bytes = await fs.readFile(path.join(root, 'files', file)); } catch (e) { if (e.code === 'ENOENT') throw failure('文件缺失，请联系管理员', 410); throw e; }
    if (sha(bytes) !== hash) throw failure('文件完整性校验失败', 409);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename), 'X-Artifact-SHA256': hash, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
  }
  function releaseAccess(req, r) {
    const { license, binding } = authorizedBinding(store, req, ['software','product-source'].includes(r.kind) || (r.kind==='installer' && PRODUCTS.includes(r.product)) ? r.product : undefined);
    if(['theme','client-source'].includes(r.kind) && !(r.kind==='theme' ? ['packer','theme-center'] : ['packer']).includes(binding.product)) throw failure('此产品无权访问该资源',403);
    if(r.kind==='installer'&&r.product==='client'&&binding.product!=='packer') throw failure('请激活打包器',403);
    if (r.status !== 'published') throw failure('版本尚未发布或已下架', 404);
    if (['client-source','product-source'].includes(r.kind) && !license.permissions.sourceDownload) throw failure('未授权源码下载', 403);
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
  const watchers=createAuthorizationWatch();
  async function handle(req, res) {
    const externalOrigin = requestOrigin(req);
    const u = new URL(req.url, externalOrigin), r = u.pathname, m = req.method;
    if(r==='/v1/terminal-identity'&&m==='GET')return json(res,200,identity(store,u.searchParams.get('nonce'),externalOrigin));
    if(r==='/v1/terminal-config'&&m==='GET'){authorizedBinding(store,req);return json(res,200,configuration(store,externalOrigin));}
    if(r==='/v1/terminal-config/ack'&&m==='POST'){const {binding}=authorizedBinding(store,req);const result=acknowledge(store,binding,await body(req),externalOrigin);await store.commit();return json(res,200,result);}
    if(migrating(store)&&m==='POST'&&['/v1/jobs','/v1/worker/claim'].includes(r))throw failure('终端迁移中，暂不接受新构建任务',503);
    if (r === '/healthz' && m === 'GET') return json(res, 200, { ok: true, service: 'puffer-terminal', version: '0.2.4' });
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
      if(migrating(store)&&m!=='GET'&&!r.startsWith('/api/migration/'))throw failure('终端迁移中，业务修改暂时冻结；可继续查看或取消迁移',409);
      if(r==='/api/update-pushes/send'&&m==='POST'){const result=sendSoftwarePush(store,await body(req));await store.commit();return json(res,201,result);}
      const notificationRoute=r.match(/^\/api\/(announcements|update-pushes)(?:\/([a-f0-9-]{36}))?$/);
      if(notificationRoute) {
        const kind=notificationRoute[1]==='update-pushes'?'update':'announcement', id=notificationRoute[2];
        if(m==='POST' && !id){const value=saveCommunication(store,kind,await body(req));await store.commit();return json(res,201,value);}
        if(m==='PATCH' && id){const b=await body(req),value=b.status?changeCommunication(store,kind,id,b.status):saveCommunication(store,kind,b,id);await store.commit();return json(res,200,value);}
        if(m==='GET'){const list=kind==='update'?store.state.updatePushes:store.state.announcements;const items=id?[find(list,id,'通知')]:list;return json(res,200,{items,receipts:store.state.deliveryReceipts.filter(x=>items.some(i=>i.id===x.notificationId))});}
      }
      if(r==='/api/migration/status'&&m==='GET')return json(res,200,progress(store,externalOrigin));
      if(r==='/api/migration/start'&&m==='POST'){const a=startMigration(store,await body(req));store.audit('开始服务器迁移',a.migrationId);await store.commit();return json(res,200,progress(store,externalOrigin));}
      if(r==='/api/migration/cancel'&&m==='POST'){if(!migrating(store))throw failure('当前没有进行中的迁移',409);const a=store.state.authority;Object.assign(a,{phase:'cancelled',revision:a.revision+1,message:'迁移已取消',destination:null});store.audit('取消迁移',a.migrationId);await store.commit();return json(res,200,progress(store,externalOrigin));}
      if(r==='/api/migration/address'&&m==='POST'){
        const b=await body(req),primary=endpoint(b.primary),fallbacks=b.fallbacks||[];
        if(!Array.isArray(fallbacks)||fallbacks.length>3)throw failure('备用地址最多三个');
        const normalized=[...new Set(fallbacks.map(endpoint))].filter(x=>x!==primary);
        const proof=await verifyDestination(store,primary,options.endpointProbe);
        for(const fallback of normalized)await verifyDestination(store,fallback,options.endpointProbe);
        const a=store.state.authority;Object.assign(a,{primary,fallbacks:normalized,revision:a.revision+1,destination:proof});store.audit('验证并下发授权地址',primary);await store.commit();return json(res,200,progress(store,externalOrigin));
      }
      if(r==='/api/migration/finish'&&m==='POST'){finishMigration(store,externalOrigin);store.audit('完成服务器迁移',store.state.authority.migrationId);await store.commit();return json(res,200,progress(store,externalOrigin));}
      if (r === '/api/self-update' && m === 'GET') return json(res,200,await updater.status());
      if (r === '/api/self-update/check' && m === 'POST') return json(res,200,await updater.check());
      if (r === '/api/self-update/install' && m === 'POST') { const b=await body(req); const job=await updater.queue(b.revision); store.audit('请求终端 Git 更新',job.revision); await store.commit(); return json(res,202,job); }
      if(r==='/api/authorization-packages'&&m==='GET')return json(res,200,store.state.authorizationPackages);
      if(r==='/api/authorization-packages'&&m==='POST'){const item=savePackage(store,await body(req));store.audit('新增授权套餐',item.id);await store.commit();return json(res,201,item);}
      const packageRoute=r.match(/^\/api\/authorization-packages\/([a-f0-9-]{36})$/);
      if(packageRoute){const item=store.state.authorizationPackages.find(x=>x.id===packageRoute[1]);if(!item)throw failure('套餐不存在',404);if(m==='PATCH'){const saved=savePackage(store,await body(req),item.id);store.audit('编辑授权套餐',item.id);await store.commit();return json(res,200,saved);}if(m==='DELETE'){store.state.authorizationPackages=store.state.authorizationPackages.filter(x=>x.id!==item.id);store.audit('删除授权套餐',item.id);await store.commit();return json(res,200,{ok:true});}}
      if(r==='/api/authorization-logs'&&m==='GET')return json(res,200,filteredLogs(store,u.searchParams));
      if(r==='/api/authorization-distribution'&&m==='GET')return json(res,200,{mode:store.state.settings.authorizationMode,revision:store.state.settings.policyRevision,devices:store.state.bindings.map(b=>({id:b.id,licenseId:b.licenseId,product:b.product,deviceId:b.binding,status:b.status,lastSeenAt:b.lastSeenAt,received:b.policyRevision===policy(store,store.state.licenses.find(l=>l.id===b.licenseId)||{}).revision,acknowledged:!!b.policyAcknowledgedAt&&b.policyRevision===policy(store,store.state.licenses.find(l=>l.id===b.licenseId)||{}).revision}))});
      if (r === '/api/authorization-policy' && m === 'PATCH') {
        const b=await body(req);if(!['online','silent-local'].includes(b.authorizationMode) || !Number.isInteger(b.reconnectHours) || b.reconnectHours<1 || b.reconnectHours>168)throw failure('授权模式或重连间隔无效');
        Object.assign(store.state.settings,{authorizationMode:b.authorizationMode,reconnectHours:b.reconnectHours,policyRevision:(store.state.settings.policyRevision||1)+1});
        store.audit('修改全局授权模式',b.authorizationMode);await store.commit();return json(res,200,store.state.settings);
      }
      if (r === '/api/product-records' && m === 'GET') {
        const licenseId=u.searchParams.get('licenseId'),product=u.searchParams.get('product'),offset=Number(u.searchParams.get('offset')||0);
        if(!Number.isSafeInteger(offset)||offset<0)throw failure('分页参数无效');
        const records=store.state.productRecords.filter(x=>(!licenseId||x.licenseId===licenseId)&&(!product||x.product===product));return json(res,200,{total:records.length,offset,records:records.slice(offset,offset+100)});
      }
      const repoRoute=r.match(/^\/api\/repositories\/([a-z-]+)(?:\/(check|import|update))?$/);
      if(repoRoute){const p=repoRoute[1];if(!RESOURCES.includes(p))throw failure('产品无效');
        if(m==='PATCH'&&!repoRoute[2]){const config=setRepository(store,p,await body(req));await store.commit();return json(res,200,config);}
        if(m==='POST'&&repoRoute[2]==='update'){await body(req);return json(res,200,await updateSoftware(store,p,options.repositoryFetch));}
        if(m==='POST'&&repoRoute[2]==='check'){await body(req);return json(res,200,await checkRepository(store,p,options.repositoryFetch));}
        if(m==='POST'&&repoRoute[2]==='import'){
          const b=await body(req),meta=b.metadata||{};
          if((p==='templates'&&(meta.product!=='client'||meta.kind!=='theme'))||(p==='client'&&(meta.product!=='client'||meta.kind==='theme'))||(PRODUCTS.includes(p)&&(meta.product!==p||!['software','installer','product-source'].includes(meta.kind))))throw failure('Git 附件归属与产品不符');
          const incoming=await downloadAsset(store,p,Number(b.assetId),options.repositoryFetch);
          return json(res,201,await createRelease(store,{...meta,filename:incoming.asset.name,sourceOrigin:'GitHub Release',gitSource:{repository:incoming.repository,assetId:incoming.asset.id,tag:incoming.release.tag}},incoming.bytes));
        }
      }
      if (r === '/api/overview' && m === 'GET') {
        const s = store.state;
        return json(res, 200, { announcements:s.announcements, updatePushes:s.updatePushes, deliveryReceipts:s.deliveryReceipts, authorizationPackages:s.authorizationPackages, customers: s.customers, licenses: s.licenses.map(publicLicense), bindings: s.bindings, releases: s.releases.map(publicRelease), jobs: s.jobs.map(j => { const { artifact, ...rest } = j; return {...rest,...(artifact?{artifact:artifact.filename,bytes:artifact.bytes,sha256:artifact.sha256}:{})}; }), nodes: s.nodes.map(n => { const { tokenHash, ...rest } = n; return rest; }), audit: s.audit.slice(0, 100), settings: s.settings, repositories:s.repositories, productRecords:s.productRecords.slice(0,500), releaseHistory:s.releaseHistory.slice(0,500), recordCount:s.productRecords.length, origin: externalOrigin, publicKey: store.publicKey, keyId: sha(store.publicKey).slice(0, 16), version: '0.2.4' });
      }
      if(r==='/api/integrations' && m==='GET') {
        let deployment=null;
        try{const status=JSON.parse(await fs.readFile(path.join(store.root,'deployment/status.json'),'utf8'));if(status.keyId===sha(store.publicKey).slice(0,16)&&externalOrigin==='https://'+status.domain&&status.verified===true)deployment={verified:true,domain:status.domain,checkedAt:status.checkedAt};}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
        const probe=Buffer.from('hetun-terminal-self-check');
        const signature=crypto.sign(null,probe,store.privateKey);
        return json(res,200,{deployment,origin:externalOrigin,keyId:sha(store.publicKey).slice(0,16),signatureValid:crypto.verify(null,probe,store.publicKey,signature),products:PRODUCTS.map(product=>({product,bindings:store.state.bindings.filter(b=>b.product===product).length,lastSeenAt:store.state.bindings.filter(b=>b.product===product).map(b=>b.lastSeenAt).filter(Boolean).sort().at(-1)||null,publishedVersions:store.state.releases.filter(v=>v.product===product&&v.kind==='software'&&v.status==='published').length})),endpoints:{records:'/v1/records',templates:'/v1/templates',productCatalog:'/v1/product-catalog',publicKey:'/v1/license/public-key',activate:'/v1/license/activate',check:'/v1/license/check',updates:'/v1/updates',notifications:'/v1/notifications',notificationAck:'/v1/notifications/ack'},emptyTarget:emptyTarget(store)});
      }
      if(r==='/api/migration/export' && m==='POST') {
        const b=await body(req);
        if(typeof b.current!=='string'||!await checkPassword(b.current,store.admin))throw failure('当前管理员密码不正确',403);
        const archive=await exportMigrationFile(store,b.passphrase,externalOrigin);
        try{store.audit('导出加密迁移包',sha(store.publicKey).slice(0,16));await store.commit();res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="puffer-migration.hetun"','Cache-Control':'no-store','Content-Length':archive.bytes});await pipeline(createReadStream(archive.path),res);}finally{await archive.cleanup();}return;
      }
      if(r==='/api/migration/import' && m==='POST') {
        if(!emptyTarget(store))throw failure('请在空白的新服务器导入，当前已有业务数据',409);
        if(req.headers['content-type']!=='application/octet-stream')throw failure('需要迁移文件',415);
        const password=Buffer.from(String(req.headers['x-migration-passphrase']||''),'base64').toString('utf8');
        const uploaded=await receiveMigration(store.root,req);let inspected;
        try{
          inspected=await inspectMigrationFile(store.root,uploaded.path,password);
          if(u.searchParams.get('confirm')!==sha(inspected.value.publicKey).slice(0,16))return json(res,200,{preview:inspected.summary});
          const summary=await importMigration(store,inspected);initializeCenter(store.state);initializeAuthority(store.state);initializePackages(store.state);await store.commit();sessions.clear();res.setHeader('Set-Cookie',cookie('',0));
          return json(res,200,{imported:summary,relogin:true});
        }finally{await inspected?.cleanup();await uploaded.cleanup();}
      }
      if (r === '/api/customers' && m === 'POST') {
        const b = await body(req), name = String(b.name || '').trim(); if (!name || name.length > 80) throw failure('客户名称为 1–80 字');
        const c = { id: crypto.randomUUID(), name, contact: String(b.contact || '').slice(0, 120), createdAt: now() }; store.state.customers.unshift(c); store.audit('创建客户', c.id); await store.commit(); return json(res, 201, c);
      }
      if (r === '/api/licenses' && m === 'POST') {
        let b = await body(req);
        if(b.packageId)b=packageGrant(store,b);else {delete b.packageSnapshot;delete b.domainRequired;delete b.entitlement;}
        let createdCustomer = null;
        if (b.customerId) { find(store.state.customers, b.customerId, '客户'); if (b.customer !== undefined) throw failure('请选择已有客户或新建客户，不可同时提交'); }
        else { const name = typeof b.customer?.name === 'string' ? b.customer.name.trim() : ''; const contact = b.customer?.contact ?? ''; if (!name || name.length > 80 || typeof contact !== 'string' || contact.length > 120) throw failure('客户名称为 1–80 字，联系方式最多120字'); createdCustomer = {id:crypto.randomUUID(),name,contact,createdAt:now()}; b.customerId = createdCustomer.id; }
        if (!Array.isArray(b.products) || !b.products.length || new Set(b.products).size !== b.products.length || b.products.some(p => !PRODUCTS.includes(p))) throw failure('授权产品无效');
        const expiry = Date.parse(b.expiresAt); if (!Number.isFinite(expiry) || expiry <= Date.now()) throw failure('到期时间必须在未来');
        const quotas = {}; for (const p of PRODUCTS) { quotas[p] = Number(b.quotas?.[p] ?? (p === 'operations' ? 1 : 2)); if (!Number.isInteger(quotas[p]) || quotas[p] < 1 || quotas[p] > 100) throw failure('授权名额必须为 1–100'); }
        const fields=policyFields(b);
        const key = 'HTN_' + crypto.randomBytes(32).toString('base64url');
        const l = { ...fields, domainRequired:b.domainRequired===true, entitlement:b.entitlement==='permanent'?'permanent':'term', ...(b.packageSnapshot?{packageSnapshot:b.packageSnapshot}:{}), policyRevision:1, id: crypto.randomUUID(), customerId: b.customerId, label: String(b.label?.trim() || (b.products.length===3?'三产品统一授权':b.products.map(p=>({'theme-center':'主题中心',packer:'打包器',operations:'影视中心'}[p])).join('、')+'授权')).slice(0, 80), products: b.products, quotas, permissions: { sourceDownload: b.permissions?.sourceDownload !== false, localBuild: b.permissions?.localBuild !== false, cloudBuild: b.permissions?.cloudBuild !== false }, status: 'active', expiresAt: new Date(expiry).toISOString(), createdAt: now(), keyHash: sha(key) };
        if(createdCustomer){store.state.customers.unshift(createdCustomer);store.audit('创建客户',createdCustomer.id);} store.state.licenses.unshift(l); store.audit('签发授权', l.id); await store.commit(); return json(res, 201, { license: publicLicense(l), key });
      }
      const lr = r.match(/^\/api\/licenses\/([a-f0-9-]{36})(\/rotate)?$/);
      if (lr) {
        const l = find(store.state.licenses, lr[1], '授权');
        if(m==='DELETE'&&!lr[2]){
          store.state.licenses=store.state.licenses.filter(x=>x.id!==l.id);
          store.state.revocations.unshift({...l,status:'revoked',revokedAt:now(),reason:'deleted'});
          for(const b of store.state.bindings.filter(x=>x.licenseId===l.id))b.status='disabled';
          cancelUnauthorizedJobs();
          store.audit('删除授权',l.id);await store.commit();return json(res,200,{ok:true});
        }
        if (m === 'PATCH' && !lr[2]) {
          const b = await body(req);
          // Validate the complete edit before changing any stored authorization fields.
          const fields=policyFields(b), changes={...fields};
          if(b.domains!==undefined && l.domainRequired && !fields.domains?.length)throw failure('此授权需要至少一个域名');
          let customerChanges=null; if(b.customer!==undefined){const name=typeof b.customer?.name==='string'?b.customer.name.trim():'';const contact=b.customer?.contact??'';if(!name||name.length>80||typeof contact!=='string'||contact.length>120)throw failure('客户名称为 1–80 字，联系方式最多120字');customerChanges={name,contact};}
          if(b.products!==undefined){if(!Array.isArray(b.products)||!b.products.length||new Set(b.products).size!==b.products.length||b.products.some(p=>!PRODUCTS.includes(p)))throw failure('至少选择一个有效授权产品');changes.products=[...b.products];}
          if(b.label!==undefined){if(typeof b.label!=='string'||!b.label.trim()||b.label.trim().length>80)throw failure('授权名称必须为 1–80 字');changes.label=b.label.trim();}
          if(b.quotas!==undefined){const quotas={};for(const p of PRODUCTS){quotas[p]=Number(b.quotas?.[p]);if(!Number.isInteger(quotas[p])||quotas[p]<1||quotas[p]>100)throw failure('授权名额必须为 1–100');if((changes.products||l.products).includes(p)&&store.state.bindings.filter(x=>x.licenseId===l.id&&x.product===p&&x.status==='active').length>quotas[p])throw failure('名额不能低于该产品当前有效绑定数量',409);}changes.quotas=quotas;}
          if(b.permissions!==undefined){if(!b.permissions||['sourceDownload','localBuild','cloudBuild'].some(k=>typeof b.permissions[k]!=='boolean'))throw failure('权限格式无效');changes.permissions={sourceDownload:b.permissions.sourceDownload,localBuild:b.permissions.localBuild,cloudBuild:b.permissions.cloudBuild};}
          if(b.status!==undefined){if(!['active','disabled'].includes(b.status))throw failure('授权状态无效');changes.status=b.status;}
          if(b.expiresAt!==undefined){const exp=Date.parse(b.expiresAt);if(!Number.isFinite(exp)||exp<=Date.now())throw failure('续期时间必须在未来');changes.expiresAt=new Date(exp).toISOString();}
          if(customerChanges){Object.assign(find(store.state.customers,l.customerId,'客户'),customerChanges);store.audit('修改客户',l.customerId);} Object.assign(l,changes);if(Object.keys(changes).length)l.policyRevision=(l.policyRevision||1)+1;
          cancelUnauthorizedJobs();store.audit('修改统一授权',l.id);await store.commit();return json(res,200,publicLicense(l));
        }
        if (m === 'POST' && lr[2]) { const key = 'HTN_' + crypto.randomBytes(32).toString('base64url'); store.state.revocations.unshift({...l,status:'revoked',revokedAt:now(),reason:'key-rotated'}); l.keyHash = sha(key); l.policyRevision=(l.policyRevision||1)+1; store.audit('轮换授权 Key', l.id); await store.commit(); return json(res, 200, { key }); }
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
          release.status = b.status; history(store,release.kind==='theme'?'templates':release.product,b.status==='published'?'发布版本':'下架版本',release.id,release.name+' '+release.version); store.audit(b.status === 'published' ? '发布版本' : '下架版本', release.id); await store.commit(); return json(res, 200, publicRelease(release));
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
      if (r === '/api/settings' && m === 'PATCH') { const b = await body(req); if (!Number.isInteger(b.offlineDays) || b.offlineDays < 1 || b.offlineDays > 30 || !Number.isInteger(b.checkHours) || b.checkHours < 1 || b.checkHours > b.offlineDays * 24) throw failure('离线期限为 1–30 天，检查间隔不能超过该期限'); store.state.settings = { ...store.state.settings, offlineDays: b.offlineDays, checkHours: b.checkHours,policyRevision:(store.state.settings.policyRevision||1)+1 }; store.audit('修改授权策略', 'settings'); await store.commit(); return json(res, 200, store.state.settings); }
      throw failure('管理接口不存在', 404);
    }
    if (r === '/v1/license/public-key' && m === 'GET') return json(res, 200, { issuer: externalOrigin, algorithm: 'Ed25519', keyId: sha(store.publicKey).slice(0, 16), publicKey: store.publicKey });
    if (['/v1/license/activate', '/v1/license/check'].includes(r) && m === 'POST') {
      rate(req,120,"authorization");const b=await body(req),known=knownLicense(store,req),net=await network(req);
      try {
        const previous=store.state.bindings.find(x=>x.licenseId===known?.id&&x.product===b.product&&x.binding===(b.product==='operations'?b.domain:b.deviceId));
        const last=previous?.lastSeenAt,oldRevision=previous?.policyRevision;
        const result=activate(store,req,b,externalOrigin),binding=store.state.bindings.find(x=>x.id===result.activationId);
        Object.assign(binding,net,{machineId:String(b.machineId||b.deviceId||'').slice(0,120)});
        if(oldRevision!==binding.policyRevision)binding.policyAcknowledgedAt=null;
        if(!previous||oldRevision!==binding.policyRevision||!last||Date.now()-Date.parse(last)>86400000)authorizationLog(store,{licenseId:known.id,activationId:binding.id,product:binding.product,deviceId:binding.binding,version:binding.version,type:previous?'check':'activation',result:'accepted',policyRevision:binding.policyRevision,mode:binding.authorizationMode,...net});
        await store.commit();return json(res,200,result);
      }catch(e){
        const status=e.status||400,validIdentity=PRODUCTS.includes(b.product)&&/^[A-Za-z0-9_-]{16,100}$/.test(b.nonce||'')&&typeof b.deviceId==='string'&&b.deviceId.length<=120;
        if(known)authorizationLog(store,{licenseId:known.id,product:PRODUCTS.includes(b.product)?b.product:'',deviceId:String(b.deviceId||'').slice(0,120),type:'authorization-denied',result:'denied',reason:String(e.message).slice(0,160),...net});
        const denial=known&&validIdentity&&status>=400&&status<500?sign(store,{type:'hetun-authorization-denial',issuer:externalOrigin,licenseId:known.id,product:b.product,binding:b.product==='operations'?b.domain:b.deviceId,nonce:b.nonce,iat:Math.floor(Date.now()/1000),policyRevision:policy(store,known).revision,reason:e.message}):undefined;
        await store.commit();return json(res,status,{error:e.message,denial});
      }
    }
    if(r==='/v1/license/events'&&m==='POST'){const {license,binding}=authorizedBinding(store,req),result=reportEvents(store,license,binding,await body(req),await network(req));await store.commit();return json(res,200,result);}
    if (r === '/v1/records' && m === 'POST') {const {license,binding}=authorizedBinding(store,req);const result=recordEvent(store,license,binding,await body(req));await store.commit();return json(res,result.duplicate?200:201,result);}
    if (r === '/v1/records' && m === 'GET') {const {license}=authorizedBinding(store,req);return json(res,200,{records:store.state.productRecords.filter(x=>x.licenseId===license.id).slice(0,100)});}
    if (r === '/v1/templates' && m === 'GET') {const {binding}=authorizedBinding(store,req);if(!['theme-center','packer'].includes(binding.product))throw failure('请激活主题中心或打包器',403);return json(res,200,sign(store,{schemaVersion:1,issuer:externalOrigin,checkedAt:now(),releases:store.state.releases.filter(x=>x.status==='published'&&x.kind==='theme').map(publicRelease)}));}
    if (r === '/v1/product-catalog' && m === 'GET') {const {license,binding}=authorizedBinding(store,req);return json(res,200,sign(store,{schemaVersion:1,issuer:externalOrigin,product:binding.product,checkedAt:now(),releases:store.state.releases.filter(x=>x.status==='published'&&x.product===binding.product&&(x.kind!=='product-source'||license.permissions.sourceDownload)).map(publicRelease)}));}
    if (r === '/v1/updates' && m === 'GET') { const product = u.searchParams.get('product'), {license,binding}=authorizedBinding(store, req, product); return json(res, 200, updateManifest(store, product, u.searchParams.get('version'), u.searchParams.get('platform'), u.searchParams.get('arch') || 'any', u.searchParams.get('channel') || 'stable', externalOrigin, updateDistribution(store,license,binding))); }
    if(r==='/v1/license/watch' && m==='GET') {const {binding}=authorizedBinding(store,req);watchers.add(res,binding);return;}
    if(r==='/v1/notifications' && m==='GET') {const {license,binding}=authorizedBinding(store,req);return json(res,200,sign(store,{schemaVersion:1,issuer:externalOrigin,product:binding.product,activationId:binding.id,checkedAt:now(),items:communicationFeed(store,license,binding)}));}
    if(r==='/v1/notifications/ack' && m==='POST') {const {license,binding}=authorizedBinding(store,req),receipt=acknowledgeCommunication(store,license,binding,await body(req));await store.commit();return json(res,200,{ok:true,status:receipt.status});}
    if (r === '/v1/installations/report' && m === 'POST') { const { license, binding } = authorizedBinding(store, req), b = await body(req); if (!VERSION.test(b.version || '') || !['current', 'updating', 'failed'].includes(b.updateStatus)) throw failure('安装状态无效'); if(b.eventId) recordEvent(store,license,binding,{eventId:b.eventId,type:b.updateStatus==='failed'?'update-failed':b.updateStatus==='current'?'update-success':'update-check',version:b.version,occurredAt:b.occurredAt,details:{message:String(b.error||'').slice(0,300)}}); Object.assign(binding, { version: b.version, updateStatus: b.updateStatus, updateError: String(b.error || '').slice(0, 300), lastSeenAt: now() }); await store.commit(); return json(res, 200, { ok: true }); }
    if (r === '/v1/catalog' && m === 'GET') { const { license } = authorizedBinding(store, req, 'packer'); return json(res, 200, { releases: store.state.releases.filter(x => x.status === 'published' && x.product==='client' && x.kind !== 'software' && (x.kind !== 'client-source' || license.permissions.sourceDownload)).map(publicRelease), permissions: license.permissions }); }
    const cr = r.match(/^\/v1\/releases\/([a-f0-9-]{36})\/download$/);
    if (cr && m === 'GET') { const release = find(store.state.releases, cr[1], '版本'); releaseAccess(req, release); return download(res, release.file, release.filename, release.sha256); }
    if (r === '/v1/jobs') { const { license } = authorizedBinding(store, req, 'packer'); if (!license.permissions.cloudBuild) throw failure('未授权在线构建', 403); if (m === 'GET') return json(res, 200, { jobs: store.state.jobs.filter(j => j.owner === license.id).map(j => { const { artifact, ...rest } = j; return rest; }) }); if (m === 'POST') { const job = createJob(store, await body(req), license.id); await store.commit(); return json(res, 201, job); } }
    const customerJob = r.match(/^\/v1\/jobs\/([a-f0-9-]{36})(\/artifact)?$/);
    if (customerJob && m === 'GET') { const { license } = authorizedBinding(store, req, 'packer'); if (!license.permissions.cloudBuild) throw failure('未授权在线构建', 403); const job = find(store.state.jobs.filter(j => j.owner === license.id), customerJob[1], '任务'); if (customerJob[2]) { if (job.status !== 'complete') throw failure('任务没有成品', 409); return download(res, job.artifact.file, job.artifact.filename, job.artifact.sha256); } const { artifact, ...rest } = job; return json(res, 200, {...rest,...(artifact?{artifact:artifact.filename,bytes:artifact.bytes,sha256:artifact.sha256}:{})}); }
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
    const versionedAsset = r.match(/^\/assets\/([a-f0-9]{64})\/(app\.js|style\.css|logo\.svg)$/);
    if (m === 'GET' && (versionedAsset || ['/', '/app.js', '/style.css', '/logo.svg'].includes(r))) {
      const name = versionedAsset ? versionedAsset[2] : r === '/' ? 'index.html' : r.slice(1);
      let bytes = await fs.readFile(path.join(sourceRoot, 'public', name));
      if (versionedAsset && versionedAsset[1] !== sha(bytes)) throw failure('页面资源版本已更新，请重新打开页面', 404);
      if (name === 'index.html') {
        let html = bytes.toString('utf8');
        for (const asset of ['app.js', 'style.css', 'logo.svg']) {
          const content = await fs.readFile(path.join(sourceRoot, 'public', asset));
          html = html.replaceAll('/' + asset, '/assets/' + sha(content) + '/' + asset);
        }
        bytes = Buffer.from(html);
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)], 'Cache-Control': versionedAsset ? 'public, max-age=31536000, immutable' : 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); return res.end(bytes);
    }
    throw failure('接口不存在', 404);
  }
  const server = http.createServer({ maxHeaderSize: 65536 }, (req, res) => {
    if(authorizationMutation(req.url,req.method))res.once('finish',()=>{if(res.statusCode<400)watchers.notify();});
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
  let closing;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(timer);
      watchers.close();
      const stopped = new Promise(resolve => server.close(resolve));
      server.closeIdleConnections();
      const deadline = setTimeout(() => server.closeAllConnections(), 5000);
      deadline.unref();
      try { await stopped; await store.drain(); }
      finally { clearTimeout(deadline); await releaseInstance(); }
    })();
    return closing;
  }
  return { server, store, get origin() { return origin; }, close, async listen() {
    if (closing) throw Error('终端已经关闭');
    if (server.listening) return origin;
    try {
      await new Promise((resolve, reject) => {
        const failed = error => { server.removeListener('listening', ready); reject(error); };
        const ready = () => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', ready); server.listen(port, host);
      });
    } catch (error) { await close(); throw error; }
    if (port === 0 && !options.origin) origin = 'http://127.0.0.1:' + server.address().port;
    return origin;
  } };
  } catch (error) { await releaseInstance(); throw error; }
}
