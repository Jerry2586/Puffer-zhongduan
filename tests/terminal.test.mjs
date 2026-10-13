import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal } from '../server/app.mjs';
import { makeZip, readZip } from '../server/zip.mjs';
import { compareVersions, hostname } from '../server/license.mjs';
const folder=process.env.HETUN_TEST_ROOT||os.tmpdir();
const sourceZip=makeZip(new Map([['pubspec.yaml','name: puffer'],['lib/main.dart','void main() {}']]));
const themeZip=makeZip(new Map([['manifest.json',JSON.stringify({format:'hetun-skeleton',version:3,renderer:'hetun-flutter-v1',platform:'mobile',id:'puffer-theme',theme:{}})]]));
function verified(envelope,key){assert.equal(envelope.algorithm,'Ed25519');const bytes=Buffer.from(envelope.payload,'base64url');assert.equal(crypto.verify(null,bytes,key,Buffer.from(envelope.signature,'base64url')),true);return JSON.parse(bytes);}
async function setup(t,options={}){await fs.mkdir(folder,{recursive:true});const root=await fs.mkdtemp(path.join(folder,'puffer-test-'));let app=await createTerminal({root,port:0,...options});await app.listen();let origin='http://127.0.0.1:'+app.server.address().port,cookie='',csrf='';t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});const bootstrap=await fs.readFile(path.join(root,'bootstrap-admin.txt'),'utf8');const password=bootstrap.match(/密码：([^\n]+)/)[1];
async function call(url,method='GET',body,headers={},admin=true){const h={...headers};if(admin){if(cookie)h.Cookie=cookie;if(method!=='GET'){h.Origin=options.directHttp ? origin : (options.origin || origin);h['X-CSRF-Token']=csrf;}}Object.assign(h,headers);if(body!==undefined && !Buffer.isBuffer(body)){h['Content-Type']='application/json';body=JSON.stringify(body);}const res=h.Host ? await new Promise((resolve,reject)=>{const req=http.request(origin+url,{method,headers:h},r=>{const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>resolve({status:r.statusCode,headers:{get:n=>r.headers[n.toLowerCase()]||null},arrayBuffer:async()=>Buffer.concat(chunks)}));r.on('error',reject);});req.on('error',reject);req.end(body);}) : await fetch(origin+url,{method,headers:h,body});const bytes=Buffer.from(await res.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{value=null;}return {status:res.status,value,bytes,headers:res.headers};}
const login=await call('/api/login','POST',{username:'admin',password});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.value.csrf;
assert.equal((await call('/api/customers','POST',{name:'before-change'})).status,428);
assert.equal((await call('/api/password','POST',{current:password,password:'test-secure-password-2026'})).status,200);
await assert.rejects(fs.access(path.join(root,'bootstrap-admin.txt')));
return {root,get app(){return app;},get origin(){return origin;},call,async restart(){await app.close();app=await createTerminal({root,port:0});origin=await app.listen();cookie='';csrf='';},async customer(name='测试客户'){const r=await call('/api/customers','POST',{name});assert.equal(r.status,201);return r.value;},async issue(customerId,props={}){const r=await call('/api/licenses','POST',{customerId,products:['theme-center','packer','operations'],expiresAt:new Date(Date.now()+10*86400000).toISOString(),...props});assert.equal(r.status,201);return r.value;},async upload(kind,version,bytes,props={}){const meta={kind,product:kind==='software'?'packer':'client',platform:kind==='software'?'windows':'all',version,name:kind+' '+version,notes:'真实版本说明',filename:'test.zip',engine:kind==='client-source'?'flutter':'none',...props};const r=await call('/api/releases','POST',bytes,{'Content-Type':'application/octet-stream','X-Release-Metadata':encodeURIComponent(JSON.stringify(meta))});return r;},async publish(id){assert.equal((await call('/api/releases/'+id,'PATCH',{status:'published'})).status,200);},async activate(key,product='packer',deviceId='test-device-001',props={}){return call('/v1/license/activate','POST',{product,deviceId,domain:'ops.example.com',version:'1.0.0',nonce:crypto.randomBytes(18).toString('base64url'),...props},{Authorization:'Bearer '+key},false);}};}
test('版本排序、域名规范与危险 ZIP 拒绝',()=>{assert.ok(compareVersions('1.10.0','1.9.0')>0);assert.ok(compareVersions('1.0.0','1.0.0-beta.9')>0);assert.ok(compareVersions('1.0.0-beta.10','1.0.0-beta.2')>0);assert.equal(hostname('HTTPS://OPS.EXAMPLE.COM/'),'ops.example.com');assert.throws(()=>hostname('https://ops.example.com:8443/'));assert.throws(()=>readZip(makeZip(new Map([['../escape','bad']]))));assert.throws(()=>readZip(makeZip(new Map([['a','one'],['A','two']]))));const damaged=Buffer.from(sourceZip);damaged[40]^=1;assert.throws(()=>readZip(damaged));});
test('真实登录、初始改密、CSRF、外部状态和静态页面',async t=>{const x=await setup(t);assert.equal((await x.call('/api/overview')).status,200);assert.equal((await x.call('/api/customers','POST',{name:'bad'},{Origin:'https://evil.example'})).status,403);assert.equal((await x.call('/api/customers','POST',{name:'bad'},{'X-CSRF-Token':'wrong'})).status,403);assert.equal((await x.call('/api/customers','POST',null)).status,400);const page=await x.call('/');assert.equal(page.status,200);assert.match(page.bytes.toString(),/河豚终端/);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);const forbidden=path.resolve(fileURLToPath(new URL('../server',import.meta.url)));await assert.rejects(createTerminal({root:forbidden,port:0}),/运行数据/);});
test('一个 Key 激活三个产品、签名防篡改、到期封顶与并发名额',async t=>{const x=await setup(t),c=await x.customer(),{key,license}=await x.issue(c.id,{expiresAt:new Date(Date.now()+2*86400000).toISOString(),quotas:{packer:1}});for(const p of ['theme-center','packer','operations']){const r=await x.activate(key,p);assert.equal(r.status,200);const lease=verified(r.value.lease,x.app.store.publicKey);assert.equal(lease.product,p);assert.ok(lease.exp<=Date.parse(license.expiresAt)/1000);assert.ok(lease.checkAfter<=lease.exp);const bytes=Buffer.from(r.value.lease.payload,'base64url');bytes[0]^=1;assert.equal(crypto.verify(null,bytes,x.app.store.publicKey,Buffer.from(r.value.lease.signature,'base64url')),false);}
assert.equal((await x.activate(key,'packer','test-device-002')).status,409);const second=await x.issue(c.id,{quotas:{packer:1}});const results=await Promise.all([x.activate(second.key,'packer','parallel-device-a'),x.activate(second.key,'packer','parallel-device-b')]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);const disk=await fs.readFile(path.join(x.root,'data.json'),'utf8');assert.ok(!disk.includes(key));assert.ok(!disk.includes(second.key));await x.call('/api/licenses/'+license.id,'PATCH',{status:'disabled'});assert.equal((await x.activate(key)).status,403);});
test('发布与更新版本排序、撤回、产品隔离及文件损坏下载拒绝',async t=>{const x=await setup(t),c=await x.customer(),l=await x.issue(c.id),act=await x.activate(l.key);const h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':act.value.activationId};const v9=await x.upload('software','1.9.0',sourceZip),v10=await x.upload('software','1.10.0',sourceZip,{force:true});assert.equal(v9.status,201);assert.equal(v10.status,201);await x.publish(v9.value.id);let r=await x.call('/v1/updates?product=packer&version=1.0.0&platform=windows','GET',undefined,h,false);assert.equal(verified(r.value,x.app.store.publicKey).release.version,'1.9.0');await x.publish(v10.value.id);r=await x.call('/v1/updates?product=packer&version=1.9.0&platform=windows','GET',undefined,h,false);const result=verified(r.value,x.app.store.publicKey);assert.equal(result.release.version,'1.10.0');assert.equal(result.force,true);assert.equal((await x.call('/v1/updates?product=operations&version=1.0.0&platform=windows','GET',undefined,h,false)).status,403);await x.call('/api/releases/'+v10.value.id,'PATCH',{status:'withdrawn'});assert.equal((await x.call('/v1/releases/'+v10.value.id+'/download','GET',undefined,h,false)).status,404);const record=x.app.store.state.releases.find(r=>r.id===v9.value.id);await fs.writeFile(path.join(x.root,'files',record.file),'tampered');assert.equal((await x.call('/v1/releases/'+record.id+'/download','GET',undefined,h,false)).status,409);});
async function buildFixture(x){const s=await x.upload('client-source','1.0.0',sourceZip),th=await x.upload('theme','1.0.0',themeZip);assert.equal(s.status,201);assert.equal(th.status,201);await x.publish(s.value.id);await x.publish(th.value.id);return {sourceId:s.value.id,themeId:th.value.id,target:'android',name:'河豚影视',version:'1.0.0',packageId:'com.puffer.video',backend:'https://ops.example.com',buildNumber:1};}
test('源码主题校验、客户权限、构建队列与节点产物真实传输',async t=>{const x=await setup(t);assert.equal((await x.upload('client-source','0.0.1',makeZip(new Map([['.env','private'],['pubspec.yaml','x'],['lib/main.dart','x']])))).status,400);const build=await buildFixture(x),c=await x.customer(),l=await x.issue(c.id),act=await x.activate(l.key),h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':act.value.activationId};let r=await x.call('/v1/jobs','POST',build,h,false);assert.equal(r.status,201);const id=r.value.id;assert.equal(r.value.status,'queued');assert.equal((await x.call('/v1/jobs/'+id+'/artifact','GET',undefined,h,false)).status,409);const n=await x.call('/api/nodes','POST',{name:'Linux Android',targets:['android']}),wh={Authorization:'Bearer '+n.value.token};const claim=await x.call('/v1/worker/claim','POST',{},wh,false);assert.equal(claim.value.job.id,id);const src=await x.call('/v1/worker/jobs/'+id+'/source','GET',undefined,wh,false);assert.equal(src.bytes.compare(sourceZip),0);const hash=crypto.createHash('sha256').update(sourceZip).digest('hex');assert.equal((await x.call('/v1/worker/jobs/'+id+'/artifact?filename=app.apk','POST',sourceZip,{...wh,'Content-Type':'application/octet-stream','X-Artifact-SHA256':'wrong'},false)).status,409);const sent=await x.call('/v1/worker/jobs/'+id+'/artifact?filename=app.apk','POST',sourceZip,{...wh,'Content-Type':'application/octet-stream','X-Artifact-SHA256':hash},false);assert.equal(sent.status,201);assert.equal((await x.call('/v1/jobs/'+id+'/artifact','GET',undefined,h,false)).bytes.compare(sourceZip),0);assert.equal((await x.call('/v1/worker/jobs/'+id+'/heartbeat','POST',{},wh,false)).status,409);
const limited=await x.issue(c.id,{permissions:{sourceDownload:false,cloudBuild:false}}),la=await x.activate(limited.key,'packer','limited-device-001'),lh={Authorization:'Bearer '+limited.key,'X-Hetun-Activation':la.value.activationId};const catalog=await x.call('/v1/catalog','GET',undefined,lh,false);assert.ok(!catalog.value.releases.some(r=>r.kind==='client-source'));assert.equal((await x.call('/v1/releases/'+build.sourceId+'/download','GET',undefined,lh,false)).status,403);assert.equal((await x.call('/v1/jobs','POST',build,lh,false)).status,403);});
test('客户任务隔离、停用授权取消构建、节点凭据隔离与重启恢复',async t=>{const x=await setup(t),build=await buildFixture(x),c=await x.customer(),l=await x.issue(c.id),l2=await x.issue(c.id);const a=await x.activate(l.key),a2=await x.activate(l2.key,'packer','another-device-001'),h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':a.value.activationId},h2={Authorization:'Bearer '+l2.key,'X-Hetun-Activation':a2.value.activationId};const j=await x.call('/v1/jobs','POST',build,h,false);assert.equal((await x.call('/v1/jobs/'+j.value.id,'GET',undefined,h2,false)).status,404);const n=await x.call('/api/nodes','POST',{name:'Worker A',targets:['android']}),n2=await x.call('/api/nodes','POST',{name:'Worker B',targets:['android']}),wh={Authorization:'Bearer '+n.value.token};await x.call('/v1/worker/claim','POST',{},wh,false);assert.equal((await x.call('/v1/worker/jobs/'+j.value.id+'/heartbeat','POST',{}, {Authorization:'Bearer '+n2.value.token},false)).status,409);await x.call('/api/licenses/'+l.license.id,'PATCH',{status:'disabled'});assert.equal(x.app.store.state.jobs.find(q=>q.id===j.value.id).status,'cancelled');assert.equal((await x.call('/v1/worker/jobs/'+j.value.id+'/heartbeat','POST',{},wh,false)).status,403);const next=await x.call('/api/jobs','POST',build);await x.call('/v1/worker/claim','POST',{},wh,false);assert.equal(x.app.store.state.jobs.find(q=>q.id===next.value.id).status,'running');await x.restart();assert.equal(x.app.store.state.jobs.find(q=>q.id===next.value.id).status,'failed');assert.equal(x.app.store.state.customers.length,1);assert.equal(x.app.store.state.licenses.length,2);});

test('无域名 Docker 模式实际登录、IP 来源、跨站拒绝和签发地址',async t=>{
  const x=await setup(t,{host:'0.0.0.0',directHttp:true});
  const address='http://192.0.2.10:8793', headers={Host:'192.0.2.10:8793',Origin:address};
  const overview=await x.call('/api/overview','GET',undefined,headers);
  assert.equal(overview.status,200); assert.equal(overview.value.origin,address);
  assert.equal((await x.call('/api/customers','POST',{name:'IP客户'},headers)).status,201);
  assert.equal((await x.call('/api/customers','POST',{name:'跨站'}, {...headers,Origin:'http://192.0.2.10:8792'})).status,403);
  assert.equal((await x.call('/api/customers','POST',{name:'跨站'}, {...headers,Origin:'https://evil.example'})).status,403);
  assert.equal((await x.call('/api/customers','POST',{name:'错误凭证'}, {...headers,'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await x.call('/api/overview','GET',undefined,{Host:'evil.example'})).status,400);
  const c=await x.customer(),l=await x.issue(c.id);
  const a=await x.call('/v1/license/activate','POST',{product:'packer',deviceId:'ip-device-001',version:'1.0.0',nonce:crypto.randomBytes(18).toString('base64url')},{...headers,Authorization:'Bearer '+l.key},false);
  assert.equal(a.status,200); assert.equal(verified(a.value.lease,x.app.store.publicKey).issuer,address);
  const key=await x.call('/v1/license/public-key','GET',undefined,headers,false); assert.equal(key.value.issuer,address);
});

test('管理员自定密码长度：单字符、中文和长密码均可修改及登录',async t=>{
  const x=await setup(t); let current='test-secure-password-2026';
  for(const password of ['1','123456','中','x'.repeat(300)]) {
    assert.equal((await x.call('/api/password','POST',{current,password})).status,200);
    assert.equal((await x.call('/api/login','POST',{username:'admin',password})).status,200);
    current=password;
  }
  assert.equal((await x.call('/api/password','POST',{current,password:''})).status,400);
});
test('域名端口直连可通过配置域名或服务器 IP 登录，同时保留签发地址和跨站校验',async t=>{
  const canonical='http://sq.example.test:1025';
  const x=await setup(t,{directHttp:true,origin:canonical});
  for(const Host of ['sq.example.test:1025','192.0.2.10:1025','[2001:db8::1]:1025']) {
    const headers={Host,Origin:'http://'+Host};
    assert.equal((await x.call('/api/login','POST',{username:'admin',password:'test-secure-password-2026'},headers)).status,200);
    const overview=await x.call('/api/overview','GET',undefined,headers);
    assert.equal(overview.status,200); assert.equal(overview.value.origin,canonical);
    assert.equal((await x.call('/api/customers','POST',{name:'直连客户'},headers)).status,201);
    assert.equal((await x.call('/api/login','POST',{username:'admin',password:'test-secure-password-2026'},{...headers,Origin:'https://evil.example'})).status,403);
    assert.equal((await x.call('/api/customers','POST',{name:'跨站'},{...headers,Origin:canonical===headers.Origin?'http://192.0.2.11:1025':canonical})).status,403);
    assert.equal((await x.call('/api/customers','POST',{name:'错误凭证'},{...headers,'X-CSRF-Token':'wrong'})).status,403);
  }
  assert.equal((await x.call('/api/login','POST',{username:'admin',password:'test-secure-password-2026'},{Host:'evil.example',Origin:'http://evil.example'})).status,400);
});
test('HTTPS 代理登录继续使用配置域名，拒绝伪造转发头',async t=>{
  const canonical='https://sq.example.test'; const x=await setup(t,{origin:canonical});
  assert.equal((await x.call('/api/login','POST',{username:'admin',password:'test-secure-password-2026'},{Host:'terminal:8792',Origin:canonical})).status,200);
  assert.equal((await x.call('/api/login','POST',{username:'admin',password:'test-secure-password-2026'},{Host:'terminal:8792',Origin:'https://evil.example','X-Forwarded-Host':'evil.example','X-Forwarded-Proto':'https'})).status,403);
});

test('产品对接读取真实绑定与发布记录，不假报客户端已接入',async t=>{
  const x=await setup(t);
  let r=await x.call('/api/integrations');assert.equal(r.status,200);assert.equal(r.value.signatureValid,true);assert.equal(r.value.emptyTarget,true);assert.equal(r.value.deployment,null);assert.ok(r.value.products.every(p=>p.bindings===0&&p.lastSeenAt===null));
  const c=await x.customer(),l=await x.issue(c.id);assert.equal((await x.activate(l.key)).status,200);
  r=await x.call('/api/integrations');assert.equal(r.value.products.find(p=>p.product==='packer').bindings,1);assert.equal(r.value.emptyTarget,false);
});
test('加密迁移：先预检，确认后保留授权签名和真实文件，旧会话退出，重启不丢失',async t=>{
  const x=await setup(t),y=await setup(t);
  const c=await x.customer('迁移客户'),l=await x.issue(c.id);const activated=await x.activate(l.key);assert.equal(activated.status,200);
  const uploaded=await x.upload('theme','1.0.0',themeZip);assert.equal(uploaded.status,201);await x.publish(uploaded.value.id);
  assert.equal((await x.call('/api/migration/export','POST',{current:'wrong',passphrase:'迁移密码'})).status,403);
  const bundle=await x.call('/api/migration/export','POST',{current:'test-secure-password-2026',passphrase:'迁移密码'});assert.equal(bundle.status,200);assert.equal(bundle.bytes.subarray(0,8).toString(),'HETUNM02');assert.equal(bundle.bytes.includes(Buffer.from('PRIVATE KEY')),false);
  const headers={'Content-Type':'application/octet-stream','X-Migration-Passphrase':Buffer.from('迁移密码').toString('base64')};
  const oldKey=y.app.store.publicKey;
  assert.equal((await y.call('/api/migration/import','POST',bundle.bytes,{...headers,'X-Migration-Passphrase':Buffer.from('wrong').toString('base64')})).status,400);
  const damaged=Buffer.from(bundle.bytes);damaged[damaged.length-1]^=1;assert.equal((await y.call('/api/migration/import','POST',damaged,headers)).status,400);assert.equal(y.app.store.publicKey,oldKey);
  const preview=await y.call('/api/migration/import','POST',bundle.bytes,headers);assert.equal(preview.status,200);assert.equal(preview.value.preview.files,1);assert.equal(y.app.store.state.customers.length,0);
  const imported=await y.call('/api/migration/import?confirm='+preview.value.preview.keyId,'POST',bundle.bytes,headers);assert.equal(imported.status,200);assert.equal(imported.value.relogin,true);assert.equal(y.app.store.publicKey,x.app.store.publicKey);assert.equal(y.app.store.state.licenses[0].keyHash,x.app.store.state.licenses[0].keyHash);assert.equal((await y.call('/api/overview')).status,401);
  const release=y.app.store.state.releases[0];assert.deepEqual(await fs.readFile(path.join(y.root,'files',release.file)),themeZip);
  assert.equal((await y.call('/api/login','POST',{username:'admin',password:'test-secure-password-2026'})).status,200);
  assert.equal((await x.call('/api/migration/import','POST',bundle.bytes,headers)).status,409);
  await y.restart();assert.equal(y.app.store.publicKey,x.app.store.publicKey);assert.equal(y.app.store.state.customers[0].name,'迁移客户');assert.equal((await y.activate(l.key,'packer','test-device-001')).status,200);
});

test('终端自身更新需要管理员与 CSRF，开发环境只能检查',async t=>{const x=await setup(t,{updateFetch:async()=>({ok:true,json:async()=>({sha:'b'.repeat(40),commit:{message:'测试更新'}})})});assert.equal((await x.call('/api/self-update','GET',undefined,{},false)).status,401);assert.equal((await x.call('/api/self-update/check','POST',{}, {'X-CSRF-Token':'invalid'})).status,403);const checked=await x.call('/api/self-update/check','POST',{});assert.equal(checked.status,200);assert.equal(checked.value.latest.sha,'b'.repeat(40));assert.equal((await x.call('/api/self-update/install','POST',{revision:'b'.repeat(40)})).status,409);});

test('Linux 在线更新接口产生真实请求文件并拒绝重复提交',async t=>{await fs.mkdir(folder,{recursive:true});const directory=await fs.mkdtemp(path.join(folder,'puffer-agent-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.writeFile(path.join(directory,'agent.json'),JSON.stringify({at:new Date().toISOString()}));const x=await setup(t,{maintenanceDirectory:directory,revision:'a'.repeat(40),updateFetch:async()=>({ok:true,json:async()=>({sha:'b'.repeat(40),commit:{message:'测试更新'}})})});const checked=await x.call('/api/self-update/check','POST',{});assert.equal(checked.value.enabled,true);const queued=await x.call('/api/self-update/install','POST',{revision:'b'.repeat(40)});assert.equal(queued.status,202);assert.equal(queued.value.state,'queued');assert.match(await fs.readFile(path.join(directory,'request'),'utf8'),/ b{40}\n$/);assert.equal((await x.call('/api/self-update','GET')).value.task.id,queued.value.id);assert.equal((await x.call('/api/self-update/install','POST',{revision:'b'.repeat(40)})).status,409);});

test('页面按内容版本加载资源，CDN缓存旧地址不会影响新版界面',async t=>{
 const s=await setup(t);const page=await s.call('/');
 assert.equal(page.headers.get('cache-control'),'no-store');
 const html=page.bytes.toString('utf8');
 for(const name of ['app.js','style.css','logo.svg']) {
  const content=await fs.readFile(fileURLToPath(new URL('../public/'+name,import.meta.url)));
  const hash=crypto.createHash('sha256').update(content).digest('hex');
  const url='/assets/'+hash+'/'+name;
  assert.ok(html.includes(url));
  const resource=await s.call(url);assert.equal(resource.status,200);assert.deepEqual(resource.bytes,content);
  assert.equal(resource.headers.get('cache-control'),'public, max-age=31536000, immutable');
  assert.equal((await s.call('/assets/'+'0'.repeat(64)+'/'+name)).status,404);
  assert.equal((await s.call('/'+name)).headers.get('cache-control'),'no-store');
 }
 assert.equal((await s.call('/assets/'+'0'.repeat(64)+'/../server/app.mjs')).status,404);
});
