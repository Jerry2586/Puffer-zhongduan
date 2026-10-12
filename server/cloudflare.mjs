import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hostname } from './license.mjs';
export function cloudflareClient(token,fetchImpl=fetch){
  if(typeof token!=='string'||!token.trim())throw Error('请输入 Cloudflare API 令牌');
  return async(route,method='GET',body)=>{
    const r=await fetchImpl('https://api.cloudflare.com/client/v4'+route,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    let data;try{data=await r.json();}catch{throw Error('Cloudflare 返回了无效响应');}
    if(!r.ok||data.success!==true){const codes=(data.errors||[]).map(e=>e.code).filter(Number.isInteger).join(',');throw Object.assign(Error('Cloudflare 操作失败（HTTP '+r.status+(codes?' / 代码 '+codes:'')+'）；请检查 Tunnel 编辑、Zone 读取和 DNS 编辑权限'),{httpStatus:r.status});}
    if(Array.isArray(data.result)&&data.result_info)Object.defineProperty(data.result,'pageInfo',{value:data.result_info});
    return data.result;
  };
}
async function allRecords(api,route){const records=[];for(let page=1;page<=100;page++){const batch=await api(route+'&page='+page);records.push(...batch);const info=batch.pageInfo;if(!info||page>=info.total_pages||batch.length===0)return records;}throw Error('DNS 记录分页过多，请人工检查');}
export async function prepareTunnel(root,domain,token,fetchImpl=fetch){
  domain=hostname(domain);const api=cloudflareClient(token,fetchImpl),folder=path.join(root,'deployment');
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const journalPath=path.join(folder,'pending.json');
  if(await fs.stat(journalPath).then(()=>true,()=>false))throw Error('存在未完成的域名操作，请先执行 sudo hetun tunnel-rollback');
  let zone;const parts=domain.split('.');
  for(let i=0;i<parts.length-1&&!zone;i++){const zones=await api('/zones?name='+encodeURIComponent(parts.slice(i).join('.'))+'&status=active');zone=zones.find(z=>domain===z.name||domain.endsWith('.'+z.name));}
  if(!zone?.id||!zone.account?.id)throw Error('没有找到此域名的 Cloudflare 活跃区域，请确认域名托管和令牌权限');
  const records=await allRecords(api,'/zones/'+zone.id+'/dns_records?name='+encodeURIComponent(domain)+'&per_page=100');
  const previous=records.filter(r=>['A','AAAA','CNAME'].includes(r.type));
  if(previous.length>20)throw Error('此域名记录过多，请先人工检查');
  const j={domain,zoneId:zone.id,accountId:zone.account.id,previous,removed:[],createdId:null,tunnelId:null,tunnelName:'hetun-'+crypto.randomUUID()};
  const save=()=>saveJournal(journalPath,j);await save();
  try{
    const tunnel=await api('/accounts/'+j.accountId+'/cfd_tunnel','POST',{name:j.tunnelName,config_src:'cloudflare',tunnel_secret:crypto.randomBytes(32).toString('base64')});
    j.tunnelId=tunnel.id;await save();
    await api('/accounts/'+j.accountId+'/cfd_tunnel/'+j.tunnelId+'/configurations','PUT',{config:{ingress:[{hostname:domain,service:'http://terminal:8792'},{service:'http_status:404'}]}});
    const tunnelToken=await api('/accounts/'+j.accountId+'/cfd_tunnel/'+j.tunnelId+'/token');
    if(typeof tunnelToken!=='string'||!tunnelToken)throw Error('Cloudflare 没有返回 Tunnel 令牌');
    for(const r of previous){j.removed.push(r);await save();await api('/zones/'+j.zoneId+'/dns_records/'+r.id,'DELETE');}
    const record=await api('/zones/'+j.zoneId+'/dns_records','POST',{type:'CNAME',name:domain,content:j.tunnelId+'.cfargotunnel.com',proxied:true,ttl:1});j.createdId=record.id;await save();
    await fs.writeFile(path.join(folder,'tunnel-token'),tunnelToken,{mode:0o600});
    await fs.chmod(path.join(folder,'tunnel-token'),0o600);
    return {domain,tunnelId:j.tunnelId};
  }catch(e){try{await rollbackTunnel(root,token,fetchImpl);}catch{throw Error(e.message+'；自动回滚未完成，请执行 sudo hetun tunnel-rollback 重试');}throw e;}
}
async function saveJournal(file,value){const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);}
export async function rollbackTunnel(root,token,fetchImpl=fetch){
  const api=cloudflareClient(token,fetchImpl),journal=path.join(root,'deployment/pending.json');
  const j=JSON.parse(await fs.readFile(journal,'utf8')),save=()=>saveJournal(journal,j);
  if(!j.tunnelId&&j.tunnelName){const tunnels=await api('/accounts/'+j.accountId+'/cfd_tunnel?name='+encodeURIComponent(j.tunnelName)+'&is_deleted=false');const tunnel=tunnels.find(t=>t.name===j.tunnelName);if(tunnel){j.tunnelId=tunnel.id;await save();}}
  let records=await allRecords(api,'/zones/'+j.zoneId+'/dns_records?name='+encodeURIComponent(j.domain)+'&per_page=100');
  if(!j.createdId&&j.tunnelId){const created=records.find(r=>r.type==='CNAME'&&r.content===j.tunnelId+'.cfargotunnel.com');if(created){j.createdId=created.id;await save();}}
  if(j.createdId){const r=records.find(r=>r.id===j.createdId);if(r){if(r.type!=='CNAME'||r.content!==j.tunnelId+'.cfargotunnel.com')throw Error('DNS 已被其他操作更改，停止自动回滚');await api('/zones/'+j.zoneId+'/dns_records/'+j.createdId,'DELETE');records=records.filter(r=>r.id!==j.createdId);}j.createdId=null;await save();}
  while(j.removed.length){const r=j.removed[0],existing=records.find(x=>x.id===r.id||x.type===r.type&&x.name===r.name&&x.content===r.content);if(existing){if(existing.content!==r.content||existing.type!==r.type)throw Error('原 DNS 记录已更改，请人工核对后恢复');}else{if(records.some(x=>x.type==='CNAME')||r.type==='CNAME'&&records.some(x=>['A','AAAA'].includes(x.type)))throw Error('DNS 存在新的冲突记录，请人工核对后恢复');const restored=await api('/zones/'+j.zoneId+'/dns_records','POST',{type:r.type,name:r.name,content:r.content,ttl:r.ttl,proxied:r.proxied,comment:r.comment||''});records.push(restored);}j.removed.shift();await save();}
  if(j.tunnelId){try{await api('/accounts/'+j.accountId+'/cfd_tunnel/'+j.tunnelId,'DELETE');}catch(e){if(e.httpStatus!==404)throw e;}j.tunnelId=null;await save();}
  await fs.unlink(journal);
}
export async function verifyTunnel(root,domain,{fetchImpl=fetch,attempts=24,delay=2500}={}){
  domain=hostname(domain);const publicKey=await fs.readFile(path.join(root,'keys/public.pem'),'utf8'),keyId=crypto.createHash('sha256').update(publicKey).digest('hex').slice(0,16);
  for(let i=0;i<attempts;i++){
    try{const r=await fetchImpl('https://'+domain+'/v1/license/public-key',{signal:AbortSignal.timeout(5000),redirect:'error',headers:{'Cache-Control':'no-cache'}});const data=await r.json();if(r.ok&&data.keyId===keyId&&data.publicKey===publicKey&&data.issuer==='https://'+domain){const status={domain,keyId,verified:true,checkedAt:new Date().toISOString()};await fs.writeFile(path.join(root,'deployment/status.json'),JSON.stringify(status),{mode:0o600});return status;}}catch{}
    if(i+1<attempts)await new Promise(resolve=>setTimeout(resolve,delay));
  }
  throw Error('HTTPS 未通过当前终端签名身份检查；请检查 Cloudflare 证书、Tunnel 出站网络及域名策略');
}
export async function completeTunnel(root){
  const folder=path.join(root,'deployment'),j=JSON.parse(await fs.readFile(path.join(folder,'pending.json'),'utf8'));
  await fs.writeFile(path.join(folder,'tunnel.json'),JSON.stringify({domain:j.domain,tunnelId:j.tunnelId,accountId:j.accountId,zoneId:j.zoneId}),{mode:0o600});await fs.unlink(path.join(folder,'pending.json'));
}

// Read-only public route check. No DNS changes, no persisted success marker.
export async function diagnoseDomain(root,domain,{fetchImpl=fetch}={}){
  domain=hostname(domain);
  const publicKey=await fs.readFile(path.join(root,'keys/public.pem'),'utf8');
  const keyId=crypto.createHash('sha256').update(publicKey).digest('hex').slice(0,16);
  let r;
  try { r=await fetchImpl('https://'+domain+'/v1/license/public-key',{signal:AbortSignal.timeout(10000),redirect:'error',headers:{'Cache-Control':'no-cache'}}); }
  catch { throw Error('HTTPS 无法连接：请检查域名解析、公网证书和 Tunnel 出站网络；可用 sudo hetun domain 重新绑定。'); }
  if(r.status===525)throw Error('Cloudflare 525：Cloudflare 与源站 TLS 握手失败。请用 sudo hetun domain 自动配置源站 HTTPS，或修复已有代理的源站证书；仅修改 DNS 不会完成 HTTPS 绑定。');
  if(!r.ok)throw Error('公网检查返回 HTTP '+r.status+'；请检查域名路由、Tunnel 日志与访问策略。');
  let data;try{data=await r.json();}catch{throw Error('域名返回的不是终端接口；请检查是否指向了其他站点。');}
  if(data.keyId!==keyId||data.publicKey!==publicKey)throw Error('域名指向另一终端或站点，当前终端身份不匹配。');
  if(data.issuer!=='https://'+domain)throw Error('终端公网地址配置不一致；请通过 sudo hetun domain 重新绑定。');
  return {domain,url:'https://'+domain,keyId,verified:true};
}
