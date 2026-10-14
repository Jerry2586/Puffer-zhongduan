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


test('统一 Key 跨三个产品激活，编辑产品权限保持 Key 和绑定身份',async t=>{
 const x=await setup(t),c=await x.customer('统一客户'),l=await x.issue(c.id),id=l.license.id;
 const theme=await x.activate(l.key,'theme-center'),packer=await x.activate(l.key,'packer'),ops=await x.activate(l.key,'operations');
 assert.equal(theme.status,200);assert.equal(packer.status,200);assert.equal(ops.status,200);
 const revision=l.license.policyRevision;
 const edited=await x.call('/api/licenses/'+id,'PATCH',{label:'客户统一授权',products:['packer','operations'],quotas:{'theme-center':2,packer:2,operations:1}});
 assert.equal(edited.status,200);assert.ok(edited.value.policyRevision>revision);assert.equal(edited.value.label,'客户统一授权');
 assert.equal((await x.activate(l.key,'theme-center')).status,403);
 assert.equal((await x.call('/v1/templates','GET',undefined,{Authorization:'Bearer '+l.key,'X-Hetun-Activation':theme.value.activationId},false)).status,403);
 assert.equal((await x.activate(l.key,'packer')).value.activationId,packer.value.activationId);
 assert.equal((await x.activate(l.key,'operations')).value.activationId,ops.value.activationId);
 assert.equal((await x.call('/api/licenses/'+id,'PATCH',{products:['theme-center','packer','operations']})).status,200);
 assert.equal((await x.activate(l.key,'theme-center')).value.activationId,theme.value.activationId);
 const overview=(await x.call('/api/overview')).value;assert.equal(overview.licenses.length,1);assert.equal(overview.bindings.length,3);
});
test('统一授权无效组合不产生部分修改，名额不低于现有有效绑定',async t=>{
 const x=await setup(t),c=await x.customer(),l=await x.issue(c.id),id=l.license.id;
 const before=(await x.call('/api/overview')).value.licenses[0];
 assert.equal((await x.call('/api/licenses/'+id,'PATCH',{authorizationMode:'silent-local',label:'不得保存',products:[]})).status,400);
 assert.deepEqual((await x.call('/api/overview')).value.licenses[0],before);
 assert.equal((await x.call('/api/licenses/'+id,'PATCH',{products:['packer','packer']})).status,400);
 assert.equal((await x.call('/api/licenses/'+id,'PATCH',{products:['client']})).status,400);
 assert.equal((await x.activate(l.key,'packer','device-one-001')).status,200);assert.equal((await x.activate(l.key,'packer','device-two-002')).status,200);
 assert.equal((await x.call('/api/licenses/'+id,'PATCH',{label:'不得部分保存',quotas:{'theme-center':2,packer:1,operations:1}})).status,409);
 assert.equal((await x.call('/api/overview')).value.licenses[0].label,before.label);
 const single=await x.issue(c.id,{products:['packer']});assert.equal(single.license.label,'打包器授权');
});

test('删除统一授权使三个产品联网失效并保留客户历史，其他 Key 不受影响',async t=>{
 const x=await setup(t),c=await x.customer(),l=await x.issue(c.id),other=await x.issue(c.id);
 const acts=[];for(const p of ['theme-center','packer','operations']){const a=await x.activate(l.key,p);assert.equal(a.status,200);acts.push(a.value.activationId);}
 x.app.store.state.productRecords.push({id:'history-delete-test',licenseId:l.license.id,product:'packer'});
 x.app.store.state.jobs.push({id:'job-delete-test',owner:l.license.id,status:'queued'});await x.app.store.commit();
 assert.equal((await x.call('/api/licenses/'+l.license.id,'DELETE')).status,200);
 const view=(await x.call('/api/overview')).value;assert.equal(view.licenses.length,1);assert.equal(view.licenses[0].id,other.license.id);assert.equal(view.bindings.length,3);assert.ok(view.bindings.every(b=>b.status==='disabled'));assert.equal(view.customers.length,1);
 for(const p of ['theme-center','packer','operations'])assert.equal((await x.activate(l.key,p)).status,403);
 assert.equal((await x.call('/v1/templates','GET',undefined,{Authorization:'Bearer '+l.key,'X-Hetun-Activation':acts[0]},false)).status,403);
 assert.equal(x.app.store.state.jobs.find(j=>j.id==='job-delete-test').status,'cancelled');assert.equal(x.app.store.state.productRecords.length,1);
 assert.equal((await x.activate(other.key)).status,200);assert.equal((await x.call('/api/licenses/'+l.license.id,'DELETE')).status,404);
});

import authClient from '../integrations/authorization-client.cjs';
import {requestIP,createGeoLookup} from '../server/authorization-log.mjs';
async function desktop(t,x,l,product='packer',props={}){const root=await fs.mkdtemp(path.join(os.tmpdir(),'hetun-desktop-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const secret=crypto.randomBytes(32);const encrypt=s=>{const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv);return Buffer.concat([iv,c.getAuthTag?.name?Buffer.alloc(0):Buffer.alloc(0),c.update(s),c.final(),c.getAuthTag()]);};const decrypt=b=>{const c=crypto.createDecipheriv('aes-256-gcm',secret,b.subarray(0,12));c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString();};const client=await new authClient.Authorization({root,product,version:'1.0.0',trust:{url:x.origin,publicKey:x.app.store.publicKey,development:true},encrypt,decrypt,...props}).init();return {client,root,encrypt,decrypt};}
test('IP只信任声明的代理，国家查询失败不会编造位置',async()=>{const req={socket:{remoteAddress:'::ffff:127.0.0.1'},headers:{'x-forwarded-for':'6.6.6.6, 8.8.8.8'}};assert.equal(requestIP(req,''),'127.0.0.1');assert.equal(requestIP(req,'127.0.0.1/32'),'8.8.8.8');assert.equal(requestIP(req,'127.0.0.1/32,8.8.8.8'),'6.6.6.6');const geo=createGeoLookup({lookup:async()=>({country_code:'US'})});assert.equal((await geo('8.8.8.8')).country,'US');assert.equal((await geo('172.20.1.1')).geoSource,'private-network');assert.equal((await createGeoLookup({lookup:async()=>{throw Error();}})('8.8.4.4')).country,'');});
test('首次联网激活，重启离线使用，拒绝修改公钥与设备身份',async t=>{const x=await setup(t),c=await x.customer(),l=await x.issue(c.id),d=await desktop(t,x,l);assert.equal(d.client.status().valid,false);assert.equal((await d.client.activate(l.key,'ops.example.com')).valid,true);let online=false;d.client.fetcher=async(...args)=>{if(!online)throw Error('offline');return fetch(...args);};assert.equal((await d.client.check()).valid,true);const restart=await new authClient.Authorization({root:d.root,product:'packer',version:'1.0.0',trust:d.client.trust,encrypt:d.encrypt,decrypt:d.decrypt,fetcher:async()=>{throw Error();}}).init();assert.equal(restart.assert().licenseId,l.license.id);restart.data.deviceId='changed-device-0001';assert.throws(()=>restart.assert(),/身份/);});
test('静默迁移新机器允许超过名额，重连补传不伪造离线IP并确认策略',async t=>{const x=await setup(t),c=await x.customer(),l=await x.issue(c.id,{authorizationMode:'silent-local'}),a=await desktop(t,x,l);await a.client.activate(l.key,'ops.example.com');const archive=await a.client.exportMigration('密码');const b=await desktop(t,x,l);await assert.rejects(b.client.importMigration(archive,'错误'),/密码/);const imported=await b.client.importMigration(archive,'密码');assert.equal(imported.status.valid,true);assert.notEqual(a.client.data.deviceId,b.client.data.deviceId);assert.equal((await b.client.check()).valid,true);const binding=x.app.store.state.bindings.find(v=>v.binding===b.client.data.deviceId);assert.equal(binding.parentDeviceId,a.client.data.deviceId);assert.ok(binding.policyAcknowledgedAt);const logs=(await x.call('/api/authorization-logs?licenseId='+l.license.id)).value;assert.ok(logs.items.some(v=>v.type==='offline-migration-import'&&v.ipMeaning.includes('not historical')));assert.ok(logs.items.every(v=>!JSON.stringify(v).includes(l.key)));});
test('删除Key留下永久吊销身份，可信拒绝持久化，离线和旧租约不能恢复',async t=>{const x=await setup(t),c=await x.customer(),l=await x.issue(c.id,{authorizationMode:'silent-local'}),d=await desktop(t,x,l);await d.client.activate(l.key,'ops.example.com');const old=d.client.data.lease;await x.call('/api/licenses/'+l.license.id,'DELETE');assert.equal((await d.client.check()).valid,false);assert.equal(x.app.store.state.revocations[0].id,l.license.id);d.client.data.lease=old;d.client.fetcher=async()=>{throw Error('offline');};assert.equal((await d.client.check()).valid,false);await assert.rejects(d.client.exportMigration('密码'),/停止/);const restart=await new authClient.Authorization({root:d.root,product:'packer',version:'1.0.0',trust:d.client.trust,encrypt:d.encrypt,decrypt:d.decrypt}).init();assert.equal(restart.status().valid,false);assert.ok(x.app.store.state.authorizationLogs.some(v=>v.type==='authorization-denied'));});
test('在线到期和时间回退阻止使用，策略恢复在线后不再允许离线迁移',async t=>{const x=await setup(t),c=await x.customer(),l=await x.issue(c.id,{authorizationMode:'silent-local'}),d=await desktop(t,x,l);await d.client.activate(l.key,'ops.example.com');await x.call('/api/licenses/'+l.license.id,'PATCH',{authorizationMode:'online'});assert.equal((await d.client.check()).valid,true);await assert.rejects(d.client.exportMigration('密码'),/静默/);const now=Date.now();d.client.clock=()=>now-600000;assert.throws(()=>d.client.assert(),/时间回退/);d.client.clock=()=>now+8*86400000;assert.throws(()=>d.client.assert(),/到期/);});


test('客户与授权一次创建、失败不留空客户、已有客户复用和资料统一编辑',async t=>{
 const x=await setup(t);const base={products:['theme-center','packer','operations'],expiresAt:new Date(Date.now()+86400000).toISOString(),quotas:{'theme-center':2,packer:2,operations:1},authorizationMode:'silent-local'};
 const before=x.app.store.state.customers.length;
 const bad=await x.call('/api/licenses','POST',{...base,customer:{name:'不应保存'},products:[]});assert.equal(bad.status,400);assert.equal(x.app.store.state.customers.length,before);
 const created=await x.call('/api/licenses','POST',{...base,customer:{name:'合并客户',contact:'联系信息'}});assert.equal(created.status,201);assert.match(created.value.key,/^HTN_/);const id=created.value.license.id,cid=created.value.license.customerId;assert.equal(x.app.store.state.customers.length,before+1);assert.equal(x.app.store.state.customers.find(c=>c.id===cid).contact,'联系信息');assert.equal(created.value.license.authorizationMode,'silent-local');
 const again=await x.call('/api/licenses','POST',{...base,customerId:cid});assert.equal(again.status,201);assert.equal(x.app.store.state.customers.length,before+1);assert.notEqual(again.value.license.id,id);
 const ambiguous=await x.call('/api/licenses','POST',{...base,customerId:cid,customer:{name:'重复'}});assert.equal(ambiguous.status,400);
 const invalidEdit=await x.call('/api/licenses/'+id,'PATCH',{customer:{name:'不应更改'},quotas:{packer:0}});assert.equal(invalidEdit.status,400);assert.equal(x.app.store.state.customers.find(c=>c.id===cid).name,'合并客户');
 const edit=await x.call('/api/licenses/'+id,'PATCH',{customer:{name:'新客户名',contact:'新联系方式'},label:'统一新授权名'});assert.equal(edit.status,200);assert.equal(x.app.store.state.customers.find(c=>c.id===cid).name,'新客户名');assert.equal(x.app.store.state.licenses.find(l=>l.id===again.value.license.id).customerId,cid);assert.equal((await x.activate(created.value.key)).status,200);
 const stored=JSON.parse(await fs.readFile(path.join(x.root,'data.json'),'utf8'));assert.equal(stored.customers.find(c=>c.id===cid).name,'新客户名');assert.equal(stored.licenses.filter(l=>l.customerId===cid).length,2);
});


test('一键 Git 更新校验全部成品后自动发布、忽略源码和辅助文件、重复更新去重',async t=>{
 const exe=Buffer.from('MZreal-installer-fixture'),zip=makeZip(new Map([['app.txt','portable fixture']]));let damaged=false;
 const assets=[{id:501,name:'Puffer-setup-x64.exe',bytes:exe},{id:502,name:'Puffer-portable-windows-x64.zip',bytes:zip},{id:503,name:'source.zip',bytes:zip},{id:504,name:'manifest.json',bytes:Buffer.from('{}')}];
 const repositoryFetch=async url=>url.includes('/commits/')?Response.json({sha:'c'.repeat(40),commit:{message:'source change'}}):url.includes('/releases/assets/')?new Response(damaged&&url.endsWith('/502')?Buffer.from('bad'):assets.find(a=>url.endsWith('/'+a.id)).bytes):Response.json([{id:20,tag_name:'v2.0.0',name:'正式产品',body:'完整更新说明',published_at:new Date().toISOString(),assets:assets.map(a=>({id:a.id,name:a.name,state:'uploaded',size:a.bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(a.bytes).digest('hex')}))}]);
 const x=await setup(t,{repositoryFetch});damaged=true;
 assert.equal((await x.call('/api/repositories/packer/update','POST',{})).status,409);assert.equal(x.app.store.state.releases.length,0);
 damaged=false;const updated=await x.call('/api/repositories/packer/update','POST',{});assert.equal(updated.status,200);assert.equal(updated.value.updated,true);assert.equal(updated.value.releases.length,2);assert.ok(updated.value.releases.every(r=>r.status==='published'&&r.version==='2.0.0'));assert.equal(x.app.store.state.updatePushes.length,0);
 const again=await x.call('/api/repositories/packer/update','POST',{});assert.equal(again.status,200);assert.equal(again.value.updated,false);assert.equal(x.app.store.state.releases.length,2);await x.restart();assert.equal(x.app.store.state.releases.length,2);
});
test('仅有源码的正式 Release 不发布软件，Git 失败保留已发布成品',async t=>{
 let fail=false;const repositoryFetch=async url=>fail?new Response('',{status:503}):url.includes('/commits/')?Response.json({sha:'d'.repeat(40),commit:{message:'only source'}}):Response.json([{id:30,tag_name:'v3.0.0',published_at:new Date().toISOString(),assets:[{id:601,name:'source.zip',state:'uploaded',size:4}]}]);
 const x=await setup(t,{repositoryFetch});const result=await x.call('/api/repositories/operations/update','POST',{});assert.equal(result.status,200);assert.equal(result.value.updated,false);assert.equal(x.app.store.state.releases.length,0);
 const m={kind:'software',product:'operations',platform:'linux',version:'1.0.0',name:'旧版',notes:'保留旧版',filename:'operations.tar.gz'};
 const old=(await x.call('/api/releases','POST',Buffer.from([31,139,0,0]),{'Content-Type':'application/octet-stream','X-Release-Metadata':encodeURIComponent(JSON.stringify(m))}));assert.equal(old.status,201);await x.call('/api/releases/'+old.value.id,'PATCH',{status:'published'});fail=true;assert.equal((await x.call('/api/repositories/operations/update','POST',{})).status,502);assert.equal(x.app.store.state.releases[0].status,'published');
});
test('按 Key 批量推送一个版本，同一客户其他 Key 不接收，失败不产生部分推送',async t=>{
 const x=await setup(t),c=await x.customer('同客户两个Key'),l=await x.issue(c.id),other=await x.issue(c.id);const a=await x.activate(l.key),b=await x.activate(other.key);
 const m={kind:'software',product:'packer',platform:'windows',version:'1.0.0',name:'正式产品',notes:'更新说明',filename:'setup.exe'};
 const r=await x.call('/api/releases','POST',Buffer.from('MZfixture'),{'Content-Type':'application/octet-stream','X-Release-Metadata':encodeURIComponent(JSON.stringify(m))});assert.equal(r.status,201);await x.call('/api/releases/'+r.value.id,'PATCH',{status:'published'});
 const invalid=await x.call('/api/update-pushes/send','POST',{product:'packer',version:'1.0.0',licenseIds:['not-a-key']});assert.equal(invalid.status,400);assert.equal(x.app.store.state.updatePushes.length,0);
 const push=await x.call('/api/update-pushes/send','POST',{product:'packer',version:'1.0.0',licenseIds:[l.license.id],force:true});assert.equal(push.status,201);assert.equal(push.value.count,1);assert.equal(push.value.pushes[0].status,'published');
 const h={Authorization:'Bearer '+l.key,'X-Hetun-Activation':a.value.activationId},h2={Authorization:'Bearer '+other.key,'X-Hetun-Activation':b.value.activationId};
 const feed=await x.call('/v1/notifications','GET',undefined,h,false);assert.equal(feed.status,200);const received=verified(feed.value,x.app.store.publicKey);assert.ok(JSON.stringify(received).includes(push.value.pushes[0].id));assert.ok(!JSON.stringify(received).includes('licenseIds'));
 const otherFeed=await x.call('/v1/notifications','GET',undefined,h2,false);assert.equal(otherFeed.status,200);assert.ok(!JSON.stringify(verified(otherFeed.value,x.app.store.publicKey)).includes(push.value.pushes[0].id));
});

 test('套餐签发快照、修改冲突、删除保留授权与签名宽限',async t=>{
 const x=await setup(t);const fields={name:'统一年套餐',products:['theme-center','packer','operations'],durationUnit:'years',duration:1,authorizationMode:'online',domainRule:'required',quotas:{packer:2,'theme-center':2,operations:1},permissions:{sourceDownload:true,localBuild:true,cloudBuild:false}};
 const created=await x.call('/api/authorization-packages','POST',fields);assert.equal(created.status,201);const p=created.value;
 const missing=await x.call('/api/licenses','POST',{customer:{name:'测试'},packageId:p.id,packageRevision:p.revision});assert.equal(missing.status,400);
 const issued=await x.call('/api/licenses','POST',{customer:{name:'套餐用户'},label:'套餐用户',domains:['ops.example.com'],packageId:p.id,packageRevision:p.revision});assert.equal(issued.status,201);assert.equal(issued.value.license.packageSnapshot.name,fields.name);
 const activated=await x.activate(issued.value.key);assert.equal(activated.status,200);const lease=verified(activated.value.lease,x.app.store.publicKey);assert.equal(lease.onlineGraceSeconds,259200);assert.equal(lease.exp-lease.iat,259200);assert.equal(lease.checkAfter-lease.iat,60);
 assert.equal((await x.call('/api/authorization-packages/'+p.id,'PATCH',{...fields,name:'修改套餐',duration:2})).status,200);
 assert.equal((await x.call('/api/licenses','POST',{customer:{name:'过期选择'},domains:['ops.example.com'],packageId:p.id,packageRevision:p.revision})).status,409);
 assert.equal((await x.call('/api/authorization-packages/'+p.id,'DELETE')).status,200);assert.equal(x.app.store.state.licenses.find(l=>l.id===issued.value.license.id).packageSnapshot.name,fields.name);
 assert.equal((await x.activate(issued.value.key)).status,200);
 });
