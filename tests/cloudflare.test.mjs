import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {prepareTunnel,rollbackTunnel,verifyTunnel,completeTunnel} from '../server/cloudflare.mjs';
async function fixture(t,fail=false,paginated=false){const root=await fs.mkdtemp(path.join(process.env.HETUN_TEST_ROOT||os.tmpdir(),'hetun-cf-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));let records=[{id:'old',type:'A',name:'sq.example.com',content:'192.0.2.1',ttl:300,proxied:false}],deleted=false;const calls=[];
 const fetchImpl=async(url,options={})=>{const u=new URL(url),method=options.method||'GET',body=options.body?JSON.parse(options.body):null;calls.push({path:u.pathname,method});assert.equal(options.headers.Authorization,'Bearer fake-private-api-token');let result;
 if(u.pathname.endsWith('/zones'))result=[{id:'zone',name:'example.com',account:{id:'account'}}];
 else if(u.pathname.endsWith('/dns_records')&&method==='GET'){if(paginated){const page=Number(u.searchParams.get('page')||1);return Response.json({success:true,result:page===1?[{id:'txt',type:'TXT',name:'sq.example.com',content:'keep'}]:records,result_info:{total_pages:2,page}});}result=records;}
 else if(u.pathname.endsWith('/cfd_tunnel')&&method==='POST')result={id:'tunnel'};
 else if(u.pathname.endsWith('/configurations')){assert.equal(body.config.ingress[0].service,'http://terminal:8792');result={};}
 else if(u.pathname.endsWith('/token'))result='connector-token';
 else if(u.pathname.endsWith('/dns_records/old')&&method==='DELETE'){records=records.filter(r=>r.id!=='old');result={id:'old'};}
 else if(u.pathname.endsWith('/dns_records')&&method==='POST'){if(fail&&body.type==='CNAME')return Response.json({success:false,errors:[{code:1004,message:'DO NOT LEAK fake-private-api-token'}]},{status:400});result={id:body.type==='CNAME'?'new':'restored',...body};records.push(result);}
 else if(u.pathname.endsWith('/dns_records/new')&&method==='GET')result=records.find(r=>r.id==='new');
 else if(u.pathname.endsWith('/dns_records/new')&&method==='DELETE'){records=records.filter(r=>r.id!=='new');result={};}
 else if(u.pathname.endsWith('/cfd_tunnel/tunnel')&&method==='DELETE'){deleted=true;result={};}
 else throw Error('Unexpected request '+method+' '+url);
 return Response.json({success:true,result});};return {root,fetchImpl,calls,get records(){return records;},get deleted(){return deleted;}};
}
test('Cloudflare 自动准备及回滚只修改指定域名，不存 API 令牌',async t=>{const x=await fixture(t);await prepareTunnel(x.root,'sq.example.com','fake-private-api-token',x.fetchImpl);assert.equal(x.records[0].type,'CNAME');const pending=await fs.readFile(path.join(x.root,'deployment/pending.json'),'utf8');assert.equal(pending.includes('fake-private-api-token'),false);assert.equal(await fs.readFile(path.join(x.root,'deployment/tunnel-token'),'utf8'),'connector-token');await rollbackTunnel(x.root,'fake-private-api-token',x.fetchImpl);assert.equal(x.records.length,1);assert.equal(x.records[0].content,'192.0.2.1');assert.equal(x.deleted,true);await assert.rejects(fs.access(path.join(x.root,'deployment/pending.json')));});
test('DNS 创建失败自动恢复旧地址，错误消息不泄露令牌',async t=>{const x=await fixture(t,true);await assert.rejects(prepareTunnel(x.root,'sq.example.com','fake-private-api-token',x.fetchImpl),e=>!e.message.includes('fake-private-api-token'));assert.equal(x.records[0].content,'192.0.2.1');assert.equal(x.deleted,true);});
test('公网核验必须匹配签名公钥与 HTTPS issuer，其他站点不会被认定绑定成功',async t=>{const x=await fixture(t);await prepareTunnel(x.root,'sq.example.com','fake-private-api-token',x.fetchImpl);await fs.mkdir(path.join(x.root,'keys'));const publicKey=crypto.generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'});await fs.writeFile(path.join(x.root,'keys/public.pem'),publicKey);const keyId=crypto.createHash('sha256').update(publicKey).digest('hex').slice(0,16);
 await assert.rejects(verifyTunnel(x.root,'sq.example.com',{attempts:1,fetchImpl:async()=>Response.json({publicKey:'other',keyId,issuer:'https://sq.example.com'})}),/HTTPS/);await assert.rejects(fs.access(path.join(x.root,'deployment/status.json')));
 const status=await verifyTunnel(x.root,'sq.example.com',{attempts:1,fetchImpl:async(url,options)=>{assert.equal(url,'https://sq.example.com/v1/license/public-key');assert.equal(options.redirect,'error');return Response.json({publicKey,keyId,issuer:'https://sq.example.com'});}});assert.equal(status.verified,true);await completeTunnel(x.root);assert.equal(JSON.parse(await fs.readFile(path.join(x.root,'deployment/tunnel.json'),'utf8')).domain,'sq.example.com');await assert.rejects(fs.access(path.join(x.root,'deployment/pending.json')));
});

test('DNS 分页中的地址也纳入绑定与回滚',async t=>{const x=await fixture(t,false,true);await prepareTunnel(x.root,'sq.example.com','fake-private-api-token',x.fetchImpl);const j=JSON.parse(await fs.readFile(path.join(x.root,'deployment/pending.json'),'utf8'));assert.equal(j.previous.length,1);assert.equal(j.previous[0].id,'old');await rollbackTunnel(x.root,'fake-private-api-token',x.fetchImpl);assert.equal(x.records[0].content,'192.0.2.1');});
