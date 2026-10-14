import { validatePackages } from './authorization-packages.mjs';
import { validateCommunications } from './communications.mjs';
import { validateAuthority } from './authority.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
const zip = promisify(gzip), unzip = promisify(gunzip), derive = promisify(crypto.scrypt);
const magic = Buffer.from('HETUNM01'), limit = 64 * 1024 * 1024;
const names = ['data.json', 'admin.json', 'keys', 'files'];
const lists = ['customers','licenses','bindings','releases','jobs','nodes','audit'];
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const error = message => Object.assign(new Error(message), {status:400});
const exists = p => fs.stat(p).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
function pass(value) { if(typeof value!=='string'||!value) throw error('请输入迁移密码'); }
export async function recoverMigration(root) {
  const journal=path.join(root,'.migration-journal.json');
  if(!await exists(journal))return;
  const old=path.join(root,'.migration-old');
  for(const name of names) if(await exists(path.join(old,name))) {
    await fs.rm(path.join(root,name),{recursive:true,force:true});
    await fs.rename(path.join(old,name),path.join(root,name));
  }
  await fs.unlink(journal);
  await fs.rm(old,{recursive:true,force:true});
  await fs.rm(path.join(root,'.migration-new'),{recursive:true,force:true});
}
export async function exportMigration(store,password,origin) {
  pass(password);
  const artifacts = new Map();
  for(const r of [...store.state.releases,...store.state.jobs.map(j=>j.artifact).filter(Boolean)])artifacts.set(r.file,r);
  let total=0;const files={};
  for(const [name,r] of artifacts) {
    if(!/^[a-f0-9-]{36}\.bin$/.test(name))throw error('业务文件路径无效');
    const b=await fs.readFile(path.join(store.root,'files',name));total+=b.length;
    if(total>limit)throw error('网页迁移支持累计 64 MB 业务文件；更大数据请使用 Linux 备份恢复');
    if(b.length!==r.bytes||hash(b)!==r.sha256)throw error('业务文件完整性异常，迁移已停止');
    files[name]=b.toString('base64');
  }
  const snapshot={format:'hetun-migration',version:1,createdAt:new Date().toISOString(),origin,state:store.state,admin:store.admin,privateKey:store.privateKey,publicKey:store.publicKey,files};
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),key=await derive(password,salt,32);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv),plain=await zip(Buffer.from(JSON.stringify(snapshot)));
  const bytes=Buffer.concat([cipher.update(plain),cipher.final()]);
  return Buffer.concat([magic,salt,iv,cipher.getAuthTag(),bytes]);
}
export async function inspectMigration(bytes,password) {
  pass(password);
  if(bytes.length<53||bytes.length>128*1024*1024||!bytes.subarray(0,8).equals(magic))throw error('请选择有效的 .hetun 迁移包');
  let value;
  try {
    const key=await derive(password,bytes.subarray(8,24),32),cipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(24,36));
    cipher.setAuthTag(bytes.subarray(36,52));
    const compressed=Buffer.concat([cipher.update(bytes.subarray(52)),cipher.final()]);
    value=JSON.parse((await unzip(compressed,{maxOutputLength:128*1024*1024})).toString());
  }catch {throw error('迁移密码错误或迁移包已损坏');}
  return validateSnapshot(value);
}
export function validateSnapshot(value, suppliedFiles) {
  const s=value.state;
  if(value.format!=='hetun-migration'||value.version!==1||s?.schemaVersion!==1||!s.settings||!Number.isInteger(s.settings.offlineDays)||s.settings.offlineDays<1||s.settings.offlineDays>30||!Number.isInteger(s.settings.checkHours)||s.settings.checkHours<1||s.settings.checkHours>s.settings.offlineDays*24)throw error('迁移数据版本或策略无效');
  for(const list of lists)if(!Array.isArray(s[list])||s[list].some(x=>!x||typeof x.id!=='string')||new Set(s[list].map(x=>x.id)).size!==s[list].length)throw error('迁移业务列表无效：'+list);
  validateAuthority(s.authority);
  validateCommunications(s);
  validatePackages(s);
  const products=['packer','theme-center','operations'];
  const string=v=>typeof v==='string',date=v=>string(v)&&Number.isFinite(Date.parse(v));
  if(!date(value.createdAt)||!string(value.origin))throw error('迁移来源信息无效');
  if(s.customers.some(c=>!string(c.name)||!string(c.contact)||!date(c.createdAt))||s.audit.some(a=>!string(a.action)||!string(a.target)||!date(a.at)))throw error('迁移客户或审计记录无效');
  if(s.releases.some(r=>!['software','product-source','client-source','theme','installer'].includes(r.kind)||!string(r.product)||!string(r.version)||!string(r.platform)||!string(r.name)||!string(r.filename)||!['draft','published','withdrawn'].includes(r.status))||s.jobs.some(j=>!['queued','running','complete','failed','cancelled'].includes(j.status))||s.nodes.some(n=>!string(n.name)||!Array.isArray(n.targets)||!/^[a-f0-9]{64}$/.test(n.tokenHash)))throw error('迁移版本、任务或节点记录无效');
  const customerIds=new Set(s.customers.map(x=>x.id)),licenseIds=new Set(s.licenses.map(x=>x.id));
  if(s.licenses.some(l=>!customerIds.has(l.customerId)||!Array.isArray(l.products)||l.products.some(p=>!['packer','theme-center','operations'].includes(p))||!/^[a-f0-9]{64}$/.test(l.keyHash)||!Number.isFinite(Date.parse(l.expiresAt))||!l.quotas||products.some(p=>!Number.isInteger(l.quotas[p])||l.quotas[p]<1||l.quotas[p]>100)||!l.permissions||['sourceDownload','localBuild','cloudBuild'].some(p=>typeof l.permissions[p]!=='boolean')||!['active','disabled'].includes(l.status))||s.bindings.some(b=>!licenseIds.has(b.licenseId)||!['packer','theme-center','operations'].includes(b.product)))throw error('迁移授权关系无效');

  if (s.settings.authorizationMode!==undefined&&!['online','silent-local'].includes(s.settings.authorizationMode) || s.settings.policyRevision!==undefined&&(!Number.isSafeInteger(s.settings.policyRevision)||s.settings.policyRevision<1) || s.settings.reconnectHours!==undefined&&(!Number.isInteger(s.settings.reconnectHours)||s.settings.reconnectHours<1||s.settings.reconnectHours>168)) throw error('迁移授权策略无效');
  for (const l of s.licenses) if (l.authorizationMode!==undefined&&![null,'online','silent-local'].includes(l.authorizationMode) || l.domains!==undefined&&(!Array.isArray(l.domains)||l.domains.length>20||l.domains.some(d=>!string(d)||!/^[a-z0-9.-]+$/.test(d))) || l.policyRevision!==undefined&&(!Number.isSafeInteger(l.policyRevision)||l.policyRevision<1)) throw error('迁移客户授权策略无效');
  for (const list of ['productRecords','releaseHistory']) if(s[list]!==undefined&&(!Array.isArray(s[list])||s[list].some(x=>!x||!string(x.id))||new Set(s[list].map(x=>x.id)).size!==s[list].length))throw error('迁移扩展记录无效：'+list);
  const bindingIds=new Set(s.bindings.map(x=>x.id));
  if(s.productRecords?.some(x=>!licenseIds.has(x.licenseId)||!bindingIds.has(x.activationId)||!products.includes(x.product)||!date(x.occurredAt)||!date(x.receivedAt)||!string(x.eventId)||!x.details||typeof x.details!=='object'||Array.isArray(x.details)))throw error('迁移产品记录关系无效');
  if(s.releaseHistory?.some(x=>!string(x.product)||!string(x.action)||!string(x.target)||!date(x.at)))throw error('迁移版本历史无效');
  if(s.repositories!==undefined&&(!s.repositories||typeof s.repositories!=='object'||Array.isArray(s.repositories)||Object.entries(s.repositories).some(([p,c])=>!['packer','theme-center','operations','client','templates'].includes(p)||!c||c.product!==p||!string(c.repository)||(c.repository&&!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(c.repository))||!string(c.branch)||!/^[A-Za-z0-9_.\/-]{1,100}$/.test(c.branch)||c.branch.includes('..'))))throw error('迁移 Git 绑定无效');
  if(value.admin?.username!=='admin'||!/^[a-f0-9]{32}$/.test(value.admin.salt)||!/^[a-f0-9]{64}$/.test(value.admin.hash)||value.admin.mustChange!==false)throw error('迁移管理员记录无效');
  try {
    const privateKey=crypto.createPrivateKey(value.privateKey),publicKey=crypto.createPublicKey(value.publicKey);
    if(privateKey.asymmetricKeyType!=='ed25519'||publicKey.asymmetricKeyType!=='ed25519'||crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'})!==value.publicKey)throw Error();
  }catch{throw error('迁移签名密钥不匹配');}
  if(suppliedFiles) return {value, files:suppliedFiles, summary:{createdAt:value.createdAt,sourceOrigin:value.origin,keyId:hash(value.publicKey).slice(0,16),customers:s.customers.length,licenses:s.licenses.length,bindings:s.bindings.length,releases:s.releases.length,files:suppliedFiles.size,bytes:[...suppliedFiles.values()].reduce((n,f)=>n+f.bytes,0)}};
  if(!value.files||typeof value.files!=='object'||Array.isArray(value.files))throw error('迁移文件清单无效');
  const required=new Map();for(const r of [...s.releases,...s.jobs.map(j=>j.artifact).filter(Boolean)])required.set(r.file,r);
  const files=new Map();let total=0;
  if(Object.keys(value.files).length!==required.size)throw error('迁移文件清单不完整');
  for(const [name,encoded] of Object.entries(value.files)) {
    const r=required.get(name);
    if(!/^[a-f0-9-]{36}\.bin$/.test(name)||!r||typeof encoded!=='string')throw error('迁移文件路径无效');
    const b=Buffer.from(encoded,'base64');total+=b.length;
    if(total>limit||b.toString('base64')!==encoded||b.length!==r.bytes||hash(b)!==r.sha256)throw error('迁移文件校验失败');
    files.set(name,b);
  }
  return {value,files,summary:{createdAt:value.createdAt,sourceOrigin:value.origin,keyId:hash(value.publicKey).slice(0,16),customers:s.customers.length,licenses:s.licenses.length,bindings:s.bindings.length,releases:s.releases.length,files:files.size,bytes:total}};
}
export function emptyTarget(store){return ['customers','licenses','bindings','releases','jobs','nodes'].every(k=>store.state[k].length===0);}
export async function importMigration(store,inspected) {
  if(!emptyTarget(store))throw Object.assign(error('请在空白的新服务器导入，当前已有业务数据'),{status:409});
  const stage=path.join(store.root,'.migration-new'),old=path.join(store.root,'.migration-old'),journal=path.join(store.root,'.migration-journal.json');
  if(await exists(journal))throw error('上次迁移尚未恢复，请重启服务');
  await fs.rm(stage,{recursive:true,force:true});await fs.rm(old,{recursive:true,force:true});
  const {value,files}=inspected,state=structuredClone(value.state);
  for(const j of state.jobs)if(['queued','running'].includes(j.status))Object.assign(j,{status:'cancelled',error:'服务器迁移取消了未完成任务，请重新提交',finishedAt:new Date().toISOString()});
  await fs.mkdir(path.join(stage,'keys'),{recursive:true,mode:0o700});await fs.mkdir(path.join(stage,'files'),{mode:0o700});await fs.mkdir(old,{mode:0o700});
  for(const [name,b] of files){if(Buffer.isBuffer(b))await fs.writeFile(path.join(stage,'files',name),b,{mode:0o600});else {await fs.copyFile(b.path,path.join(stage,'files',name));await fs.chmod(path.join(stage,'files',name),0o600);}}
  if(state.authority&&['preparing','restored'].includes(state.authority.phase))Object.assign(state.authority,{phase:'restored',destination:null});
  for(const [name,b] of [['data.json',JSON.stringify(state)],['admin.json',JSON.stringify(value.admin)],['keys/private.pem',value.privateKey],['keys/public.pem',value.publicKey]])await fs.writeFile(path.join(stage,name),b,{mode:0o600});
  state.audit.unshift({id:crypto.randomUUID(),action:'导入服务器迁移包',target:inspected.summary.keyId,at:new Date().toISOString()});
  state.audit.length=Math.min(state.audit.length,2000);
  await fs.writeFile(path.join(stage,'data.json'),JSON.stringify(state),{mode:0o600});
  // Journal survives process interruption; startup restores the entire previous snapshot.
  await fs.writeFile(journal,JSON.stringify({version:1}),{mode:0o600,flag:'wx'});
  try {
    for(const name of names){await fs.rename(path.join(store.root,name),path.join(old,name));await fs.rename(path.join(stage,name),path.join(store.root,name));}
    await fs.unlink(journal);
  }catch(e){await recoverMigration(store.root);throw e;}
  Object.assign(store,{state,admin:value.admin,privateKey:value.privateKey,publicKey:value.publicKey});
  await fs.unlink(path.join(store.root,'bootstrap-admin.txt')).catch(()=>{});
  await fs.rm(old,{recursive:true,force:true}).catch(()=>{});await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});
  return inspected.summary;
}
