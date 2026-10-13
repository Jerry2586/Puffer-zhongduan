import crypto from 'node:crypto';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
const fail = (message,status=400) => Object.assign(new Error(message),{status});
const timestamp=()=>new Date().toISOString();
export const keyId=store=>crypto.createHash('sha256').update(store.publicKey).digest('hex').slice(0,16);
export function initializeAuthority(state) {
  state.authority ||= {revision:1,primary:'',fallbacks:[],phase:'normal',migrationId:'',startedAt:null,graceUntil:null,message:'',destination:null};
}
export const migrating=store=>['preparing','restored'].includes(store.state.authority?.phase);
export function validateAuthority(a) {
  if(!a)return;
  if(!Number.isSafeInteger(a.revision)||a.revision<1||!['normal','preparing','restored','completed','cancelled'].includes(a.phase)||typeof a.primary!=='string'||!Array.isArray(a.fallbacks)||a.fallbacks.length>3||typeof a.message!=='string'||a.message.length>500||typeof a.migrationId!=='string')throw fail('迁移控制数据无效');
  for(const v of [a.primary,...a.fallbacks])if(v)endpoint(v);
  if(a.graceUntil!==null&&!Number.isFinite(Date.parse(a.graceUntil)))throw fail('迁移宽限时间无效');
  if(a.startedAt!==null&&!Number.isFinite(Date.parse(a.startedAt)))throw fail('迁移开始时间无效');
  if(['preparing','restored'].includes(a.phase)&&(!a.migrationId||!a.startedAt||!a.graceUntil||Date.parse(a.graceUntil)<=Date.parse(a.startedAt)||Date.parse(a.graceUntil)-Date.parse(a.startedAt)>30*86400000))throw fail('迁移宽限窗口无效');
  if(a.destination!==null&&(!a.destination||typeof a.destination.origin!=='string'||typeof a.destination.keyId!=='string'||!Number.isFinite(Date.parse(a.destination.checkedAt))))throw fail('迁移目的地记录无效');
}
export function endpoint(value) {
  let u;try{u=new URL(value);}catch{throw fail('请输入完整 HTTPS 站点地址，例如 https://auth.example.com');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.port||isIP(u.hostname.replace(/^\[|\]$/g,''))||!u.hostname.includes('.')||u.hostname==='localhost'||u.hostname.endsWith('.localhost')||u.hostname.endsWith('.local'))throw fail('授权地址须为无端口、无路径的公网 HTTPS 域名');
  return u.origin;
}
export function envelope(store,payload){const bytes=Buffer.from(JSON.stringify(payload));return {algorithm:'Ed25519',keyId:keyId(store),payload:bytes.toString('base64url'),signature:crypto.sign(null,bytes,store.privateKey).toString('base64url')};}
export function identity(store,nonce,origin) {
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(nonce||''))throw fail('需要有效的身份挑战随机数');
  return envelope(store,{type:'hetun-terminal-identity',nonce,origin,keyId:keyId(store),iat:Math.floor(Date.now()/1000)});
}
export function configuration(store,origin) {
  initializeAuthority(store.state);const a=store.state.authority;
  return envelope(store,{type:'hetun-terminal-config',schemaVersion:1,keyId:keyId(store),revision:a.revision,primary:a.primary||origin,fallbacks:a.fallbacks,phase:a.phase,migrationId:a.migrationId,message:a.message,graceUntil:a.graceUntil,issuedAt:timestamp(),retryAfterSeconds:3600});
}
export function startMigration(store,b) {
  initializeAuthority(store.state);const a=store.state.authority;
  if(migrating(store))throw fail('已有进行中的迁移',409);
  if(!Number.isInteger(b.graceDays)||b.graceDays<1||b.graceDays>30)throw fail('迁移宽限为 1–30 天');
  if(store.state.jobs.some(j=>j.status==='running'))throw fail('仍有运行中的构建，请等待结束后开始迁移',409);
  for(const j of store.state.jobs)if(j.status==='queued')Object.assign(j,{status:'cancelled',finishedAt:timestamp(),error:'终端开始迁移，等待中的构建已取消，请迁移完成后重新提交'});
  Object.assign(a,{revision:a.revision+1,phase:'preparing',migrationId:crypto.randomUUID(),startedAt:timestamp(),graceUntil:new Date(Date.now()+b.graceDays*86400000).toISOString(),message:String(b.message||'授权中心维护迁移中，本地有效授权可继续使用。').slice(0,500),destination:null});
  return a;
}
function privateAddress(v) {
  if(isIP(v)===4){const p=v.split('.').map(Number);return p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===198&&[18,19].includes(p[1]);}
  // Only globally routed IPv6 unicast; excludes loopback, mapped IPv4 and local networks.
  return !/^[23][a-f0-9]{3}:/i.test(v)||/^2001:(?:db8|0):/i.test(v);
}
async function probe(url) {
  const records=await lookup(new URL(url).hostname,{all:true});if(!records.length||records.some(r=>privateAddress(r.address)))throw fail('目标域名解析到非公网地址');
  const selected=records[0];
  return new Promise((resolve,reject)=>{const req=https.get(url,{lookup:(_h,_o,cb)=>cb(null,selected.address,selected.family),timeout:10000,headers:{Accept:'application/json'}},res=>{
    if(res.statusCode!==200){res.resume();reject(fail('目标终端未返回有效响应，不接受重定向'));return;}
    let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>16384)res.destroy(fail('身份响应过大'));else chunks.push(b);});res.on('error',reject);res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks)));}catch{reject(fail('目标返回的不是终端身份信息'));}});
  });req.on('timeout',()=>req.destroy(fail('目标终端连接超时')));req.on('error',reject);});
}
export async function verifyDestination(store,value,fetcher=probe) {
  const origin=endpoint(value),nonce=crypto.randomBytes(24).toString('base64url');let e;
  try{e=await fetcher(origin+'/v1/terminal-identity?nonce='+nonce);}catch(err){throw err.status?err:fail('无法连接目标 HTTPS 终端，请核对域名和证书');}
  let p;try{const bytes=Buffer.from(e.payload,'base64url');if(e.algorithm!=='Ed25519'||e.keyId!==keyId(store)||!crypto.verify(null,bytes,store.publicKey,Buffer.from(e.signature,'base64url')))throw Error();p=JSON.parse(bytes);if(p.type!=='hetun-terminal-identity'||p.nonce!==nonce||p.origin!==origin||p.keyId!==keyId(store)||!Number.isSafeInteger(p.iat)||Math.abs(Date.now()/1000-p.iat)>120)throw Error();}catch{throw fail('目标终端签名身份不一致；请先导入迁移包，不能绑定陌生终端');}
  return {origin,keyId:keyId(store),checkedAt:timestamp(),revision:store.state.authority.revision};
}
export function finishMigration(store,origin) {
  const a=store.state.authority;
  if(a.phase!=='restored')throw fail('请在已导入迁移包的新服务器完成迁移',409);
  if(!a.destination||a.destination.origin!==origin||a.primary!==origin||a.destination.keyId!==keyId(store)||Date.now()-Date.parse(a.destination.checkedAt)>15*60000)throw fail('请先验证当前正式域名，再完成迁移',409);
  Object.assign(a,{phase:'completed',message:'迁移已完成',revision:a.revision+1,completedAt:timestamp()});return a;
}
export function acknowledge(store,binding,b,origin) {
  const a=store.state.authority;
  if(b.revision!==a.revision||b.migrationId!==a.migrationId)throw fail('配置已变化，请重新获取签名配置',409);
  if(!['received','connected'].includes(b.status))throw fail('确认状态无效');
  if(b.status==='connected'&&(!a.primary||a.primary!==origin))throw fail('连接确认必须发送到新正式地址',409);
  binding.terminalNotice={revision:a.revision,migrationId:a.migrationId,status:b.status,origin,at:timestamp()};return {ok:true};
}
export function progress(store,origin){const a=store.state.authority;return {authority:a,origin,keyId:keyId(store),productsIntegrated:false,bindings:store.state.bindings.map(b=>({id:b.id,licenseId:b.licenseId,product:b.product,binding:b.binding,status:b.status,notice:b.terminalNotice?.migrationId===a.migrationId&&b.terminalNotice?.revision===a.revision?b.terminalNotice:null})),pendingJobs:store.state.jobs.filter(j=>['queued','running'].includes(j.status)).length};}
