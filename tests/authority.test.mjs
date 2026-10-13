import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createTerminal } from '../server/app.mjs';
import { openStore } from '../server/store.mjs';
import { identity, verifyDestination, startMigration, configuration } from '../server/authority.mjs';
import { exportMigration, importMigration } from '../server/migration.mjs';
import { exportMigrationFile, inspectMigrationFile } from '../server/migration-stream.mjs';
const base=process.env.HETUN_TEST_ROOT||os.tmpdir();await fs.mkdir(base,{recursive:true});
async function store(t){const root=await fs.mkdtemp(path.join(base,'hetun-move-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=await openStore(root);await s.changePassword('1');return s;}
function payload(e,key){const b=Buffer.from(e.payload,'base64url');assert.equal(crypto.verify(null,b,key,Buffer.from(e.signature,'base64url')),true);return JSON.parse(b);}
async function terminal(t,origin='https://new.example.com'){
 const s=await store(t);let app;
 app=await createTerminal({root:s.root,port:0,origin,endpointProbe:async url=>identity(app.store,new URL(url).searchParams.get('nonce'),new URL(url).origin)});await app.listen();t.after(()=>app.close());const url='http://127.0.0.1:'+app.server.address().port;
 let cookie='',csrf='';async function call(route,method='GET',b,headers={},admin=true){const h={...headers};if(admin){h.Cookie=cookie;if(method!=='GET'){h.Origin=origin;h['X-CSRF-Token']=csrf;}}if(b!==undefined&&!Buffer.isBuffer(b)){h['Content-Type']='application/json';b=JSON.stringify(b);}const r=await fetch(url+route,{method,headers:h,body:b});const bytes=Buffer.from(await r.arrayBuffer());let v;try{v=JSON.parse(bytes);}catch{v=null;}return {status:r.status,value:v,bytes,headers:r.headers};}
 const login=await call('/api/login','POST',{username:'admin',password:'1'});cookie=login.headers.get('set-cookie').split(';')[0];csrf=login.value.csrf;
 return {app,call,async login(){const r=await call('/api/login','POST',{username:'admin',password:'1'});cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.value.csrf;}};
}
test('迁移开关冻结业务、拒绝新激活，已有授权宽限不突破到期和停用',async t=>{
 const x=await terminal(t),c=await x.call('/api/customers','POST',{name:'迁移客户'});
 const expiresAt=new Date(Date.now()+86400000*3).toISOString();const l=await x.call('/api/licenses','POST',{customerId:c.value.id,products:['packer'],expiresAt,quotas:{packer:2,'theme-center':1,operations:1},permissions:{sourceDownload:true,localBuild:true,cloudBuild:true}});assert.equal(l.status,201);
 const b={product:'packer',deviceId:'migration-device-001',version:'1.0.0',nonce:crypto.randomBytes(20).toString('base64url')};const h={Authorization:'Bearer '+l.value.key};
 const activated=await x.call('/v1/license/activate','POST',b,h,false);assert.equal(activated.status,200);h['X-Hetun-Activation']=activated.value.activationId;
 x.app.store.state.jobs.push({id:crypto.randomUUID(),status:'running'});assert.equal((await x.call('/api/migration/start','POST',{graceDays:7})).status,409);x.app.store.state.jobs[0].status='queued';
 assert.equal((await x.call('/api/migration/start','POST',{graceDays:31})).status,400);
 assert.equal((await x.call('/api/migration/start','POST',{graceDays:7})).status,200);assert.equal(x.app.store.state.jobs[0].status,'cancelled');
 assert.equal((await x.call('/api/customers','POST',{name:'被冻结'})).status,409);
 assert.equal((await x.call('/v1/jobs','POST',{},h,false)).status,503);
 assert.equal((await x.call('/v1/license/activate','POST',{...b,deviceId:'migration-device-002'},h,false)).status,503);
 const checked=await x.call('/v1/license/check','POST',b,h,false);assert.equal(checked.status,200);const lease=payload(checked.value.lease,x.app.store.publicKey);assert.equal(lease.exp,Math.floor(Date.parse(expiresAt)/1000));
 const config=await x.call('/v1/terminal-config','GET',undefined,h,false);const a=payload(config.value,x.app.store.publicKey);assert.equal(a.phase,'preparing');
 assert.equal((await x.call('/v1/terminal-config/ack','POST',{revision:a.revision,migrationId:a.migrationId,status:'received'},h,false)).status,200);
 assert.equal((await x.call('/v1/terminal-config/ack','POST',{revision:a.revision-1,migrationId:a.migrationId,status:'received'},h,false)).status,409);
 assert.equal((await x.call('/v1/terminal-config/ack','POST',{revision:a.revision,migrationId:a.migrationId,status:'connected'},h,false)).status,409);
 const another={...h,'X-Hetun-Activation':crypto.randomUUID()};assert.equal((await x.call('/v1/terminal-config/ack','POST',{revision:a.revision,migrationId:a.migrationId,status:'received'},another,false)).status,403);
 assert.equal((await x.call('/api/migration/status')).value.bindings[0].notice.status,'received');
 assert.equal((await x.call('/api/migration/address','POST',{primary:'https://new.example.com',fallbacks:[]})).status,200);
 assert.equal((await x.call('/api/migration/status')).value.bindings[0].notice,null);
 x.app.store.state.licenses[0].status='disabled';assert.equal((await x.call('/v1/license/check','POST',b,h,false)).status,403);assert.equal((await x.call('/v1/terminal-config','GET',undefined,h,false)).status,403);
 x.app.store.state.licenses[0].status='active';x.app.store.state.licenses[0].expiresAt=new Date(Date.now()-1).toISOString();assert.equal((await x.call('/v1/license/check','POST',b,h,false)).status,403);
 assert.equal((await x.call('/api/migration/cancel','POST',{})).status,200);assert.equal((await x.call('/api/customers','POST',{name:'恢复写入'})).status,201);
});
test('新地址随机挑战、HTTPS与签名身份校验，错误地址不会覆盖已有地址',async t=>{
 const s=await store(t),other=await store(t);let called=false;
 for(const address of ['http://auth.example.com','https://127.0.0.1','https://auth.example.com:1025','https://auth.example.com/path','https://a.local'])await assert.rejects(verifyDestination(s,address,async()=>{called=true;}));assert.equal(called,false);
 const proof=await verifyDestination(s,'https://auth.example.com',async u=>identity(s,new URL(u).searchParams.get('nonce'),'https://auth.example.com'));assert.equal(proof.origin,'https://auth.example.com');
 await assert.rejects(verifyDestination(s,proof.origin,async u=>identity(other,new URL(u).searchParams.get('nonce'),proof.origin)),/身份不一致/);
 const stale=identity(s,crypto.randomBytes(20).toString('base64url'),proof.origin);await assert.rejects(verifyDestination(s,proof.origin,async()=>stale),/身份不一致/);
 const x=await terminal(t);assert.equal((await x.call('/api/migration/address','POST',{primary:'https://new.example.com',fallbacks:['https://backup.example.com']})).status,200);const before=structuredClone(x.app.store.state.authority);
 assert.equal((await x.call('/api/migration/address','POST',{primary:'http://bad.example.com'})).status,400);assert.deepEqual(x.app.store.state.authority,before);
 assert.equal((await x.call('/api/migration/finish','POST',{})).status,409);
});
test('迁移状态随包恢复，新服务器核验正式地址后才完成，签名和密码保持不变',async t=>{
 const source=await store(t);startMigration(source,{graceDays:7});const archive=await exportMigrationFile(source,'迁移密码','https://old.example.com');t.after(archive.cleanup);
 const target=await terminal(t),inspected=await inspectMigrationFile(target.app.store.root,archive.path,'迁移密码');t.after(inspected.cleanup);await importMigration(target.app.store,inspected);
 assert.equal(target.app.store.state.authority.phase,'restored');assert.equal(target.app.store.publicKey,source.publicKey);
 assert.equal((await target.call('/api/migration/finish','POST',{})).status,409);
 assert.equal((await target.call('/api/migration/address','POST',{primary:'https://new.example.com',fallbacks:[]})).status,200);
 assert.equal((await target.call('/api/migration/finish','POST',{})).status,200);assert.equal(target.app.store.state.authority.phase,'completed');
 const reopened=await openStore(target.app.store.root);assert.equal(reopened.state.authority.phase,'completed');assert.equal(reopened.publicKey,source.publicKey);
 assert.equal(payload(configuration(reopened,'https://new.example.com'),source.publicKey).primary,'https://new.example.com');
});
test('96 MiB 安装包流式整包迁移，错误密码/篡改拒绝、旧格式兼容与临时文件清理',async t=>{
 const source=await store(t),target=await store(t),file=crypto.randomUUID()+'.bin';const handle=await fs.open(path.join(source.root,'files',file),'wx',0o600),hash=crypto.createHash('sha256'),chunk=crypto.randomBytes(1024*1024);
 try{for(let n=0;n<96;n++){await handle.write(chunk);hash.update(chunk);}}finally{await handle.close();}
 source.state.releases.push({id:crypto.randomUUID(),file,bytes:96*1024*1024,sha256:hash.digest('hex'),kind:'installer',product:'packer',version:'1.0.0',platform:'windows',name:'真实大安装包',filename:'app.exe',status:'draft'});
 const archive=await exportMigrationFile(source,'迁移','https://old.example.com');t.after(archive.cleanup);
 await assert.rejects(inspectMigrationFile(target.root,archive.path,'错误密码'),/密码错误/);
 const h=await fs.open(archive.path,'r+'),stat=await h.stat(),tag=Buffer.alloc(1);await h.read(tag,0,1,stat.size-1);tag[0]^=1;await h.write(tag,0,1,stat.size-1);await h.close();await assert.rejects(inspectMigrationFile(target.root,archive.path,'迁移'),/损坏/);
 const undo=await fs.open(archive.path,'r+');tag[0]^=1;await undo.write(tag,0,1,stat.size-1);await undo.close();
 const inspection=await inspectMigrationFile(target.root,archive.path,'迁移');assert.equal(inspection.summary.bytes,96*1024*1024);assert.equal(inspection.summary.files,1);
 await importMigration(target,inspection);await inspection.cleanup();assert.equal((await fs.stat(path.join(target.root,'files',file))).size,96*1024*1024);assert.equal(target.privateKey,source.privateKey);
 assert.deepEqual((await fs.readdir(target.root)).filter(n=>n.startsWith('.transfer-')),[]);
 const legacySource=await store(t),legacyTarget=await store(t),legacy=await exportMigration(legacySource,'旧包','https://old.example.com'),legacyPath=path.join(legacyTarget.root,'legacy.hetun');await fs.writeFile(legacyPath,legacy);
 const old=await inspectMigrationFile(legacyTarget.root,legacyPath,'旧包');await importMigration(legacyTarget,old);assert.equal(legacyTarget.publicKey,legacySource.publicKey);
 await fs.mkdir(path.join(legacyTarget.root,'.transfer-crashed'));await fs.writeFile(path.join(legacyTarget.root,'.transfer-crashed/plain'),'sensitive');await openStore(legacyTarget.root);await assert.rejects(fs.access(path.join(legacyTarget.root,'.transfer-crashed')));
});
