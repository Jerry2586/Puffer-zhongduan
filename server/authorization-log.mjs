import crypto from 'node:crypto';
import {isIP, BlockList} from 'node:net';
import {sha, now, failure} from './store.mjs';
export function initializeAuthorization(state) {
 state.authorizationLogs ??= []; state.revocations ??= [];
 state.settings.authorizationLogDays ??= 365;
}
export function authorizationLog(store, data) {
 initializeAuthorization(store.state);
 const row={id:crypto.randomUUID(),receivedAt:now(),...data};
 // Only explicit safe fields are accepted by callers; no bearer keys or client free-text.
 store.state.authorizationLogs.unshift(row);
 const cutoff=Date.now()-store.state.settings.authorizationLogDays*86400000;
 store.state.authorizationLogs=store.state.authorizationLogs.filter(x=>Date.parse(x.receivedAt)>=cutoff).slice(0,100000);
 return row;
}
function normalizedIP(value) { const v=String(value||'').replace(/^::ffff:/,''); return isIP(v)?v:''; }
export function requestIP(req, trusted=process.env.HETUN_TRUSTED_PROXIES||'') {
 const peer=normalizedIP(req.socket.remoteAddress), list=new BlockList();
 for(const entry of String(trusted).split(',').map(x=>x.trim()).filter(Boolean)) {
  const [ip,bits]=entry.split('/');const type=isIP(ip)===6?'ipv6':'ipv4';
  try {if(bits!==undefined)list.addSubnet(ip,Number(bits),type);else list.addAddress(ip,type);}catch{throw failure('可信代理配置无效',500);}
 }
 const trustedIP=ip=>ip&&list.check(ip,isIP(ip)===6?'ipv6':'ipv4');
 if(!trustedIP(peer))return peer;
 // Walk right-to-left and stop at the first untrusted hop; never trust user-inserted leftmost headers.
 const hops=String(req.headers['x-forwarded-for']||'').split(',').map(x=>normalizedIP(x.trim()));
 if(hops.some(x=>!x))return peer;
 let ip=peer;for(let n=hops.length-1;n>=0&&trustedIP(ip);n--)ip=hops[n];return ip;
}
function privateIP(ip){return !ip||ip==='::1'||/^f[cd]|^fe80:/i.test(ip)||/^(?:127|10|0)\./.test(ip)||/^192\.168\./.test(ip)||/^169\.254\./.test(ip)||/^172\.(?:1[6-9]|2\d|3[01])\./.test(ip);}
export function createGeoLookup({fetcher=fetch,token=process.env.HETUN_IPINFO_TOKEN||'',lookup}={}) {
 const cache=new Map();return async ip=>{
  if(privateIP(ip))return {country:'',region:'',geoSource:'private-network'};
  const old=cache.get(ip);if(old&&old.until>Date.now())return old.value;
  let value={country:'',region:'',geoSource:token||lookup?'unavailable':'not-configured'};
  try {
   const data=lookup?await lookup(ip):token?await (await fetcher('https://api.ipinfo.io/lite/'+encodeURIComponent(ip)+'?token='+encodeURIComponent(token),{signal:AbortSignal.timeout(2000),redirect:'error'})).json():null;
   if(data&&/^[A-Z]{2}$/.test(data.country_code||''))value={country:data.country_code,region:String(data.region||'').slice(0,80),geoSource:'IPinfo Lite · inferred'};
  }catch{}
  if(cache.size>10000)cache.clear();cache.set(ip,{value,until:Date.now()+(value.country?86400000:300000)});return value;
 };
}
export function knownLicense(store,req) {const key=String(req.headers.authorization||'').replace(/^Bearer /,'');return store.state.licenses.find(x=>x.keyHash===sha(key))||store.state.revocations.find(x=>x.keyHash===sha(key));}
export function filteredLogs(store,params) {
 const offset=Number(params.get('offset')||0);if(!Number.isSafeInteger(offset)||offset<0)throw failure('分页参数无效');
 const fields=['licenseId','product','deviceId','type','result','country'];const from=params.get('from'),to=params.get('to');
 if(from&&!Number.isFinite(Date.parse(from))||to&&!Number.isFinite(Date.parse(to)))throw failure('日期过滤无效');
 const items=store.state.authorizationLogs.filter(x=>fields.every(k=>!params.get(k)||x[k]===params.get(k))&&(!from||Date.parse(x.receivedAt)>=Date.parse(from))&&(!to||Date.parse(x.receivedAt)<=Date.parse(to)));
 return {total:items.length,offset,items:items.slice(offset,offset+100).map(x=>{const l=[...store.state.licenses,...(store.state.revocations||[])].find(l=>l.id===x.licenseId),b=store.state.bindings.find(b=>b.id===x.activationId);return {...x,licenseLabel:l?.label||'',version:x.version||''};}),retentionDays:store.state.settings.authorizationLogDays};
}
export function reportEvents(store,license,binding,input,network) {
 if(!Array.isArray(input.events)||input.events.length>100)throw failure('一次补传最多100条');
 const accepted=[];
 for(const e of input.events) {
  if(!/^[A-Za-z0-9_-]{16,100}$/.test(e.eventId||'')||!['offline-migration-import','offline-migration-export','reconnect','policy-received','theme-export','local-build','source-download','template-install','theme-install'].includes(e.type)||!Number.isFinite(Date.parse(e.occurredAt))||Date.parse(e.occurredAt)>Date.now()+300000)throw failure('离线记录格式无效');
  const permission={'local-build':'localBuild','source-download':'sourceDownload'}[e.type];if(permission&&!license.permissions?.[permission])throw failure('未授权此记录对应功能',403);if(e.type==='policy-received'&&!/^\d+\.\d+$/.test(e.policyRevision||''))throw failure('策略回执版本无效');
  const content={policyRevision:e.type==='policy-received'?e.policyRevision:undefined,licenseId:license.id,activationId:binding.id,product:binding.product,version:binding.version,deviceId:binding.binding,eventId:e.eventId,type:e.type,occurredAt:new Date(e.occurredAt).toISOString(),parentDeviceId:String(e.parentDeviceId||'').slice(0,120)};
  const digest=sha(JSON.stringify(content));const old=store.state.authorizationLogs.find(x=>x.licenseId===license.id&&x.eventId===e.eventId);
  if(old&&old.digest!==digest)throw failure('重复事件内容冲突',409);
  if(!old)authorizationLog(store,{...content,digest,result:'reported',...network,ipMeaning:'reconnection IP; not historical offline IP'});accepted.push(e.eventId);
  if(e.type==='policy-received'&&e.policyRevision===binding.policyRevision)binding.policyAcknowledgedAt=now();
 }
 return {accepted};
}
