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

test('在线和静默策略签名、域名限制及恢复在线保持绑定身份',async t=>{
 const x=await setup(t),c=await x.customer(),l=await x.issue(c.id,{domains:['ops.example.com']});
 assert.equal((await x.activate(l.key,'packer','test-device-001',{domain:'pirate.example.com'})).status,403);
 const a=await x.activate(l.key),online=verified(a.value.lease,x.app.store.publicKey);
 assert.equal(online.authorizationMode,'online');assert.equal(online.domain,'ops.example.com');
 assert.equal((await x.call('/api/authorization-policy','PATCH',{authorizationMode:'silent-local',reconnectHours:24})).status,200);
 const b=await x.activate(l.key),local=verified(b.value.lease,x.app.store.publicKey);
 assert.equal(b.value.activationId,a.value.activationId);assert.equal(local.authorizationMode,'silent-local');assert.equal(local.exp,Math.floor(Date.parse(l.license.expiresAt)/1000));assert.ok(local.exp>online.exp);
 assert.equal((await x.call('/api/licenses/'+l.license.id,'PATCH',{authorizationMode:'online'})).status,200);
 const restored=await x.activate(l.key);assert.equal(restored.value.activationId,a.value.activationId);assert.equal(verified(restored.value.lease,x.app.store.publicKey).authorizationMode,'online');
 assert.equal((await x.call('/api/licenses/'+l.license.id,'PATCH',{domains:['new.example.com']})).status,200);
 assert.equal((await x.call('/v1/templates','GET',undefined,{Authorization:'Bearer '+l.key,'X-Hetun-Activation':a.value.activationId},false)).status,403);
});
test('云端元数据记录身份隔离、重试去重、冲突和权限',async t=>{
 const x=await setup(t),c=await x.customer(),l=await x.issue(c.id),a=await x.activate(l.key),h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':a.value.activationId};
 const event={eventId:'build-event-000001',type:'local-build',version:'1.0.0',details:{name:'河豚影视',platform:'android'}};
 const saved=await x.call('/v1/records','POST',event,h,false);assert.equal(saved.status,201);
 const retry=await x.call('/v1/records','POST',event,h,false);assert.equal(retry.status,200);assert.equal(retry.value.record.id,saved.value.record.id);
 assert.equal((await x.call('/v1/records','POST',{...event,version:'2.0.0'},h,false)).status,409);
 assert.equal((await x.call('/v1/records','POST',{...event,eventId:'build-event-000002',product:'operations'},h,false)).status,403);
 assert.equal((await x.call('/v1/records','POST',{...event,eventId:'build-event-000003',details:{message:'HTN_secretToken'}},h,false)).status,400);
 const l2=await x.issue(c.id,{permissions:{localBuild:false}}),a2=await x.activate(l2.key,'packer','other-device-001'),h2={Authorization:'Bearer '+l2.key,'X-Hetun-Activation':a2.value.activationId};
 assert.equal((await x.call('/v1/records','POST',event,h2,false)).status,403);
 assert.equal((await x.call('/v1/records','GET',undefined,h2,false)).value.records.length,0);
 assert.equal((await x.call('/api/product-records?product=packer')).value.total,1);
 await x.restart();assert.equal(x.app.store.state.productRecords.length,1);
});
test('Git检查、附件完整性、资源归属、草稿和产品目录隔离',async t=>{
 const zip=makeZip(new Map([['package.json','{"name":"real-product"}'],['server/index.mjs','console.log("ready")']]));
 const digest=crypto.createHash('sha256').update(zip).digest('hex');let damaged=false;
 const repositoryFetch=async url=>{
  if(url.includes('/commits/'))return Response.json({sha:'b'.repeat(40),commit:{message:'1.1.0',committer:{date:new Date().toISOString()}}});
  if(url.includes('/releases/assets/'))return new Response(damaged?Buffer.from('bad'):zip);
  return Response.json([{id:10,tag_name:'v1.1.0',name:'正式版',body:'说明',published_at:new Date().toISOString(),assets:[{id:101,name:'source.zip',size:zip.length,state:'uploaded',digest:'sha256:'+digest}]}]);
 };
 const x=await setup(t,{repositoryFetch}),c=await x.customer(),l=await x.issue(c.id),a=await x.activate(l.key),h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':a.value.activationId};
 assert.equal((await x.call('/api/repositories/packer','PATCH',{repository:'https://evil.example/a/b'})).status,400);
 assert.equal((await x.call('/api/repositories/packer/check','POST',{})).status,200);
 const metadata={kind:'product-source',product:'packer',platform:'all',version:'1.1.0',name:'打包器源码',notes:'正式源码说明',engine:'none',installNotes:'安装说明',upgradeNotes:'更新说明'};
 assert.equal((await x.call('/api/repositories/packer/import','POST',{assetId:999,metadata})).status,400);
 assert.equal((await x.call('/api/repositories/packer/import','POST',{assetId:101,metadata:{...metadata,product:'operations'}})).status,400);
 damaged=true;assert.equal((await x.call('/api/repositories/packer/import','POST',{assetId:101,metadata})).status,409);damaged=false;
 const imported=await x.call('/api/repositories/packer/import','POST',{assetId:101,metadata});assert.equal(imported.status,201);assert.equal(imported.value.status,'draft');assert.equal(imported.value.gitSource.assetId,101);
 let catalog=await x.call('/v1/product-catalog','GET',undefined,h,false);assert.equal(verified(catalog.value,x.app.store.publicKey).releases.length,0);
 await x.publish(imported.value.id);catalog=await x.call('/v1/product-catalog','GET',undefined,h,false);assert.equal(verified(catalog.value,x.app.store.publicKey).releases[0].id,imported.value.id);
 const other=await x.activate(l.key,'theme-center','theme-device-001'),oh={Authorization:'Bearer '+l.key,'X-Hetun-Activation':other.value.activationId};assert.equal((await x.call('/v1/releases/'+imported.value.id+'/download','GET',undefined,oh,false)).status,403);
 assert.equal((await x.call('/v1/releases/'+imported.value.id+'/download','GET',undefined,h,false)).bytes.compare(zip),0);
 const th=await x.upload('theme','1.0.0',themeZip);await x.publish(th.value.id);assert.equal(verified((await x.call('/v1/templates','GET',undefined,oh,false)).value,x.app.store.publicKey).releases.length,1);
 assert.ok(x.app.store.state.releaseHistory.some(v=>v.action.includes('发布')));
 assert.equal((await x.upload('product-source','1.2.0',makeZip(new Map([['.env','secret']])),{product:'packer'})).status,400);
});

test('加密迁移保留新策略、域名、Git绑定及产品云端记录',async t=>{
 const x=await setup(t),y=await setup(t),c=await x.customer(),l=await x.issue(c.id,{domains:['ops.example.com'],authorizationMode:'silent-local'}),a=await x.activate(l.key),h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':a.value.activationId};
 await x.call('/v1/records','POST',{eventId:'migration-event-001',type:'local-build',version:'1.0.0'},h,false);
 await x.call('/api/repositories/packer','PATCH',{repository:'Jerry2586/Puffer-dabaoqi',branch:'main'});
 const exported=await x.call('/api/migration/export','POST',{current:'test-secure-password-2026',passphrase:'migration-test'});
 const headers={'Content-Type':'application/octet-stream','X-Migration-Passphrase':Buffer.from('migration-test').toString('base64')};
 const preview=await y.call('/api/migration/import','POST',exported.bytes,headers);assert.equal(preview.status,200);
 const imported=await y.call('/api/migration/import?confirm='+preview.value.preview.keyId,'POST',exported.bytes,headers);assert.equal(imported.status,200);
 assert.equal(y.app.store.state.productRecords.length,1);assert.equal(y.app.store.state.licenses[0].authorizationMode,'silent-local');assert.deepEqual(y.app.store.state.licenses[0].domains,['ops.example.com']);assert.equal(y.app.store.state.repositories.packer.repository,'Jerry2586/Puffer-dabaoqi');assert.equal(y.app.store.publicKey,x.app.store.publicKey);
});
