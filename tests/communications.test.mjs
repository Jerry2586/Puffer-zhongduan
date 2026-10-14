import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTerminal } from '../server/app.mjs';
import { makeZip } from '../server/zip.mjs';
import { exportMigration, inspectMigration } from '../server/migration.mjs';
import { createDeliveryClient } from '../integrations/delivery-client.mjs';
const software=makeZip(new Map([['readme.txt','controlled update fixture; not an actual installer']]));
async function setup(t) {
 const parent=process.env.HETUN_TEST_ROOT||os.tmpdir();await fs.mkdir(parent,{recursive:true});const root=await fs.mkdtemp(path.join(parent,'delivery-test-'));
 const app=await createTerminal({root,port:0}),origin=await app.listen();t.after(async()=>{await app.close();await fs.rm(root,{recursive:true,force:true});});
 let cookie='',csrf='';
 async function call(route,method='GET',body,headers={},client=false) {
  const h={...headers};if(!client){h.Cookie=cookie;if(method!=='GET'){h.Origin=origin;h['X-CSRF-Token']=csrf;}}
  if(body!==undefined&&!Buffer.isBuffer(body)){h['Content-Type']='application/json';body=JSON.stringify(body);}
  const res=await fetch(origin+route,{method,headers:h,body});const bytes=Buffer.from(await res.arrayBuffer());let value;try{value=JSON.parse(bytes);}catch{}return {status:res.status,value,bytes,headers:res.headers};
 }
 const bootstrap=await fs.readFile(path.join(root,'bootstrap-admin.txt'),'utf8'),password=bootstrap.match(/密码：([^\n]+)/)[1];
 const login=await call('/api/login','POST',{username:'admin',password});cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.value.csrf;
 assert.equal((await call('/api/password','POST',{current:password,password:'delivery-tests-only'})).status,200);
 async function client(name='A',product='packer'){
  const customer=(await call('/api/customers','POST',{name})).value;
  const l=(await call('/api/licenses','POST',{customerId:customer.id,products:['packer','theme-center','operations'],expiresAt:new Date(Date.now()+86400000*10).toISOString()})).value;
  const activation=(await call('/v1/license/activate','POST',{product,deviceId:'test-device-'+name,domain:'ops.example.com',version:'1.0.0',nonce:crypto.randomBytes(18).toString('base64url')},{Authorization:'Bearer '+l.key},true)).value;
  const headers={Authorization:'Bearer '+l.key,'X-Hetun-Activation':activation.activationId};
  return {customer,license:l,activation,headers,call:(r,m,b)=>call(r,m,b,headers,true),sdk:createDeliveryClient({origin,publicKey:app.store.publicKey,key:l.key,activationId:activation.activationId,product,version:'1.0.0',platform:product==='operations'?'linux':'windows'})};
 }
 async function release(product='packer',version='1.1.0',extra={}) {
  const metadata={kind:'software',product,platform:product==='operations'?'linux':'windows',version,name:'software '+version,notes:'update notes',filename:'test.zip',...extra};
  const upload=await call('/api/releases','POST',software,{'Content-Type':'application/octet-stream','X-Release-Metadata':encodeURIComponent(JSON.stringify(metadata))});assert.equal(upload.status,201);
  assert.equal((await call('/api/releases/'+upload.value.id,'PATCH',{status:'published'})).status,200);return upload.value;
 }
 async function notification(kind,fields={}){
  const route=kind==='update'?'/api/update-pushes':'/api/announcements';const result=await call(route,'POST',{title:'真实通知',content:'通知正文',products:['packer'],customerIds:[],type:'popup',...fields});assert.equal(result.status,201);
  assert.equal((await call(route+'/'+result.value.id,'PATCH',{status:'published'})).status,200);return result.value;
 }
 function verify(envelope){const bytes=Buffer.from(envelope.payload,'base64url');assert.equal(crypto.verify(null,bytes,app.store.publicKey,Buffer.from(envelope.signature,'base64url')),true);return JSON.parse(bytes);}
 return {app,root,origin,call,client,release,notification,verify};
}
test('公告按产品和客户隔离、未授权拒绝、真实签名与幂等反馈',async t=>{
 const x=await setup(t),a=await x.client(),b=await x.client('B'),theme=await x.client('Theme','theme-center');
 const n=await x.notification('announcement',{customerIds:[a.customer.id],requireConfirmation:true});
 assert.equal((await x.call('/v1/notifications','GET',undefined,{},true)).status,401);
 const items=await a.sdk.notifications();assert.equal(items.length,1);assert.equal(items[0].customerIds,undefined);assert.equal((await b.sdk.notifications()).length,0);assert.equal((await theme.sdk.notifications()).length,0);
 assert.equal(x.app.store.state.deliveryReceipts.length,1);await a.sdk.notifications();assert.equal(x.app.store.state.deliveryReceipts.length,1);
 assert.equal((await b.call('/v1/notifications/ack','POST',{notificationId:n.id,revision:n.revision,status:'read'})).status,404);
 await a.sdk.ack(n,'read');await a.sdk.ack(n,'confirmed');await a.sdk.ack(n,'received');assert.equal(x.app.store.state.deliveryReceipts[0].status,'confirmed');
 const r=await a.call('/v1/notifications/ack','POST',{notificationId:n.id,revision:99,status:'read'});assert.equal(r.status,409);
 assert.equal((await a.call('/v1/notifications/ack','POST',{notificationId:n.id,revision:1,status:'installed'})).status,400);
});
test('定时生效、截止、撤回、草稿编辑与关联更新校验',async t=>{
 const x=await setup(t),a=await x.client();
 const future=await x.notification('announcement',{startsAt:new Date(Date.now()+3600000).toISOString()});assert.equal((await a.sdk.notifications()).length,0);
 const banner=await x.notification('announcement',{type:'banner'}),maintenance=await x.notification('announcement',{type:'maintenance'});assert.equal((await a.sdk.notifications()).length,2);
 assert.equal((await x.call('/api/announcements/'+banner.id,'PATCH',{title:'非法编辑'})).status,409);
 assert.equal((await x.call('/api/announcements/'+banner.id,'PATCH',{status:'withdrawn'})).status,200);assert.equal((await a.sdk.notifications()).length,1);
 assert.equal((await a.call('/v1/notifications/ack','POST',{notificationId:banner.id,revision:1,status:'read'})).status,404);
 assert.equal((await x.call('/api/announcements/'+banner.id,'PATCH',{status:'published'})).status,409);
 x.app.store.state.announcements.find(n=>n.id===maintenance.id).endsAt=new Date(Date.now()-1000).toISOString();assert.equal((await a.sdk.notifications()).length,0);
 assert.equal((await x.call('/api/announcements','POST',{title:'x',content:'x',type:'popup',products:['packer'],releaseId:future.id})).status,400);
 const d=await x.call('/api/announcements','POST',{title:'draft',content:'x',type:'message',products:['packer']});assert.equal(d.status,201);
 const edit=await x.call('/api/announcements/'+d.value.id,'PATCH',{title:'edited',content:'updated',type:'message',products:['packer']});assert.equal(edit.value.revision,2);
});
test('指定客户更新推送不绕过范围，兼容平台通道和强制标记，撤回停止检查',async t=>{
 const x=await setup(t),a=await x.client(),b=await x.client('B'),r=await x.release();
 const push=await x.notification('update',{releaseId:r.id,customerIds:[a.customer.id],force:true});
 const u=await a.sdk.updates();assert.equal(u.updateAvailable,true);assert.equal(u.force,true);assert.equal(u.pushId,push.id);
 assert.equal((await b.sdk.updates()).updateAvailable,false);
 assert.equal(x.verify((await a.call('/v1/updates?product=packer&version=1.0.0&platform=linux')).value).updateAvailable,false);
 assert.equal(x.verify((await a.call('/v1/updates?product=packer&version=1.0.0&platform=windows&channel=beta')).value).updateAvailable,false);
 assert.equal((await a.call('/v1/updates?product=operations&version=1.0.0&platform=linux')).status,403);
 assert.equal((await x.call('/api/update-pushes/'+push.id,'PATCH',{status:'withdrawn'})).status,200);assert.equal((await a.sdk.updates()).updateAvailable,false);
 assert.equal((await x.call('/api/update-pushes','POST',{title:'bad',products:['theme-center'],releaseId:r.id})).status,400);
});
test('真实下载校验、篡改拒绝、安装反馈不冒充检查成功',async t=>{
 const x=await setup(t),a=await x.client(),r=await x.release(),push=await x.notification('update',{releaseId:r.id});
 const downloaded=await a.sdk.downloadUpdate(path.join(x.root,'download'));assert.deepEqual(await fs.readFile(downloaded.path),software);
 await a.sdk.verifyBeforeInstall(downloaded.path,downloaded.release);await fs.appendFile(downloaded.path,'tamper');await assert.rejects(a.sdk.verifyBeforeInstall(downloaded.path,downloaded.release),/被修改/);
 const binding=x.app.store.state.bindings.find(b=>b.id===a.activation.activationId);assert.equal(binding.version,'1.0.0');
 await a.sdk.ack(push,'downloaded');await a.sdk.ack(push,'installing');await a.sdk.ack(push,'failed',{message:'安装器退出'});
 assert.equal(binding.updateStatus,'failed');assert.equal(binding.version,'1.0.0');
 assert.equal((await a.call('/v1/notifications/ack','POST',{notificationId:push.id,revision:1,status:'installed',version:'9.9.9'})).status,400);
 await a.sdk.ack(push,'installed',{version:'1.1.0'});await a.sdk.ack(push,'failed',{message:'迟到的失败反馈'});assert.equal(x.app.store.state.bindings.find(b=>b.id===a.activation.activationId).version,'1.1.0');assert.equal(x.app.store.state.bindings.find(b=>b.id===a.activation.activationId).updateStatus,'current');assert.equal(x.app.store.state.deliveryReceipts[0].status,'installed');
});
test('通知和接收记录随迁移包保留，老版本数据自动补齐',async t=>{
 const x=await setup(t),a=await x.client(),n=await x.notification('announcement');await a.sdk.notifications();await a.sdk.ack(n,'read');
 const pack=await exportMigration(x.app.store,'migration-test-password',x.origin),inspection=await inspectMigration(pack,'migration-test-password');assert.equal(inspection.value.state.announcements.length,1);assert.equal(inspection.value.state.deliveryReceipts[0].status,'read');
 delete x.app.store.state.announcements;delete x.app.store.state.updatePushes;delete x.app.store.state.deliveryReceipts;await x.app.store.commit();
 const file=JSON.parse(await fs.readFile(path.join(x.root,'data.json'),'utf8'));assert.equal(file.announcements,undefined);
 // Snapshot validation also initializes legacy arrays.
 const old=inspection.value;delete old.state.announcements;delete old.state.updatePushes;delete old.state.deliveryReceipts;
 const {validateSnapshot}=await import('../server/migration.mjs');assert.deepEqual(validateSnapshot(old).value.state.announcements,[]);
});
test('客户端拒绝替换公钥、跨产品和重放旧签名清单',async t=>{
 const x=await setup(t),a=await x.client();await x.notification('announcement');
 const make=fetcher=>createDeliveryClient({origin:x.origin,publicKey:x.app.store.publicKey,key:a.license.key,activationId:a.activation.activationId,product:'packer',version:'1.0.0',platform:'windows',fetcher});
 const envelope=(await a.call('/v1/notifications')).value;
 await assert.rejects(make(async()=>Response.json({...envelope,signature:Buffer.alloc(64).toString('base64url')})).notifications(),/签名验证/);
 const {sign}=await import('../server/license.mjs');
 await assert.rejects(make(async()=>Response.json(sign(x.app.store,{schemaVersion:1,issuer:x.origin,product:'operations',checkedAt:new Date().toISOString(),items:[]}))).notifications(),/身份或时间/);
 await assert.rejects(make(async()=>Response.json(sign(x.app.store,{schemaVersion:1,issuer:x.origin,product:'packer',checkedAt:new Date(Date.now()-3600000).toISOString(),items:[]}))).notifications(),/身份或时间/);
});

test('旧更新反馈不能覆盖更新后的产品版本与状态',async t=>{
 const x=await setup(t),a=await x.client(),r1=await x.release(),n1=await x.notification('update',{releaseId:r1.id});
 await a.sdk.ack(n1,'installed',{version:'1.1.0'});
 const r2=await x.release('packer','1.2.0'),n2=await x.notification('update',{releaseId:r2.id});
 await a.sdk.ack(n2,'installed',{version:'1.2.0'});
 await a.sdk.ack(n1,'installed',{version:'1.1.0'});await a.sdk.ack(n1,'failed',{message:'迟到回执'});
 const b=x.app.store.state.bindings.find(b=>b.id===a.activation.activationId);assert.equal(b.version,'1.2.0');assert.equal(b.updateStatus,'current');
 const detail=await x.call('/api/update-pushes/'+n2.id);assert.equal(detail.value.items.length,1);assert.equal(detail.value.items[0].id,n2.id);
});

test('健康检查只暴露服务状态，管理总览提供实际通知集合',async t=>{
 const x=await setup(t);const health=await x.call('/healthz');assert.equal(health.status,200);assert.deepEqual(health.value,{ok:true,service:'puffer-terminal',version:'0.2.4'});
 const n=await x.notification('announcement');const overview=await x.call('/api/overview');assert.equal(overview.status,200);assert.equal(overview.value.announcements[0].id,n.id);assert.deepEqual(overview.value.updatePushes,[]);assert.deepEqual(overview.value.deliveryReceipts,[]);
});
