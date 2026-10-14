import crypto from 'node:crypto';
import { failure, now } from './store.mjs';
import { PRODUCTS, hostname, VERSION } from './license.mjs';
export const RESOURCES = ['packer', 'theme-center', 'operations', 'client', 'templates'];
const defaults = { packer:'Jerry2586/Puffer-dabaoqi', 'theme-center':'Jerry2586/Puffer-zhutiqi', operations:'Jerry2586/Puffer-yunyingduan', client:'', templates:'' };
export function initializeCenter(state) {
  state.productRecords ??= []; state.releaseHistory ??= []; state.repositories ??= {};
  state.settings.authorizationMode ??= 'online'; state.settings.policyRevision ??= 1; state.settings.reconnectHours ??= 1;
  for (const p of RESOURCES) state.repositories[p] ??= {product:p,repository:defaults[p],branch:'main'};
}
export function policy(store, license) {
  return {mode:license.authorizationMode || store.state.settings.authorizationMode || 'online', revision:String(store.state.settings.policyRevision || 1)+'.'+String(license.policyRevision || 1), domains:license.domains || [], reconnectHours:store.state.settings.reconnectHours || 1, onlineGraceSeconds:72*3600, checkIntervalSeconds:60};
}
export function policyFields(input) {
  const next = {};
  if (input.authorizationMode !== undefined) {
    if (![null,'online','silent-local'].includes(input.authorizationMode)) throw failure('授权模式无效');
    next.authorizationMode = input.authorizationMode;
  }
  if (input.domains !== undefined) {
    if (!Array.isArray(input.domains) || input.domains.length > 20) throw failure('授权域名最多20个');
    next.domains = [...new Set(input.domains.map(hostname))];
  }
  return next;
}
export function history(store, product, action, target, detail='') {
  const item = {id:crypto.randomUUID(),product,action,target,detail:String(detail).slice(0,500),at:now()};
  store.state.releaseHistory.unshift(item); store.state.releaseHistory.length=Math.min(store.state.releaseHistory.length,10000); return item;
}
const events = { 'theme-center':['theme-export','template-install','update-check','update-success','update-failed'], packer:['local-build','source-download','theme-install','update-check','update-success','update-failed'], operations:['update-check','update-success','update-failed'] };
export function recordEvent(store, license, binding, input) {
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(input.eventId || '') || !events[binding.product]?.includes(input.type) || !VERSION.test(input.version || '')) throw failure('记录编号、事件或版本无效');
  if (input.product && input.product !== binding.product) throw failure('记录产品与激活身份不符',403);
  if (input.type==='local-build' && !license.permissions.localBuild) throw failure('未授权本地打包',403);
  if (input.type==='source-download' && !license.permissions.sourceDownload) throw failure('未授权源码下载',403);
  const old=store.state.productRecords.find(x=>x.licenseId===license.id&&x.eventId===input.eventId);
  const at = input.occurredAt || old?.occurredAt || now(); if (!Number.isFinite(Date.parse(at)) || Date.parse(at)>Date.now()+300000) throw failure('事件时间无效');
  const details={};
  for (const key of ['name','themeId','sourceId','releaseId','platform','result','message','sha256']) if(input.details?.[key]!==undefined) {
    if(typeof input.details[key] !== 'string' || input.details[key].length>500 || /HT[NW]_[A-Za-z0-9_-]+|BEGIN.*PRIVATE KEY/i.test(input.details[key])) throw failure('记录只接受简短元数据，请移除凭据');
    details[key]=input.details[key];
  }
  if(details.sha256 && !/^[a-f0-9]{64}$/.test(details.sha256)) throw failure('文件摘要无效');
  const content={eventId:input.eventId,licenseId:license.id,activationId:binding.id,product:binding.product,type:input.type,version:input.version,occurredAt:new Date(at).toISOString(),details};
  if(old) { if(JSON.stringify({...old,id:undefined,receivedAt:undefined,customerId:undefined,binding:undefined})!==JSON.stringify(content)) throw failure('相同事件编号内容不一致',409); return {record:old,duplicate:true}; }
  if(store.state.productRecords.length>=50000) throw failure('记录容量已满，请管理员归档',409);
  const record={...content,id:crypto.randomUUID(),customerId:license.customerId,binding:binding.binding,receivedAt:now()};
  store.state.productRecords.unshift(record);return {record,duplicate:false};
}
export function setRepository(store, product, input) {
  if(!RESOURCES.includes(product)) throw failure('产品无效');
  let repository=String(input.repository || '').trim().replace(/^https:\/\/github\.com\//,'').replace(/\/$/,'').replace(/\.git$/,'');
  if(repository && !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)) throw failure('填写 GitHub owner/repo 或仓库地址');
  const branch=String(input.branch || 'main');if(!/^[A-Za-z0-9_.\/-]{1,100}$/.test(branch)||branch.includes('..'))throw failure('分支名无效');
  store.state.repositories[product]={product,repository,branch};history(store,product,'绑定 Git 仓库',repository,branch);return store.state.repositories[product];
}
export async function checkRepository(store, product, fetcher=fetch) {
  const config=store.state.repositories[product];if(!config?.repository)throw failure('请先绑定该产品的 Git 仓库');
  const base='https://api.github.com/repos/'+config.repository;
  async function get(url) {const r=await fetcher(url,{headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Puffer-Terminal'},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw failure('GitHub 查询失败（'+r.status+'），请检查仓库权限或限流',502);return r.json();}
  try {
    const [commit,releases]=await Promise.all([get(base+'/commits/'+encodeURIComponent(config.branch)),get(base+'/releases?per_page=10')]);
    if(!/^[a-f0-9]{40}$/.test(commit.sha)||!Array.isArray(releases))throw failure('GitHub 返回格式无效',502);
    const previous=config.latestCommit?.sha;
    config.latestCommit={sha:commit.sha,message:String(commit.commit?.message || '').slice(0,1000),at:commit.commit?.committer?.date || null};
    config.upstream=releases.filter(r=>!r.draft).slice(0,10).map(r=>({id:r.id,tag:String(r.tag_name).slice(0,100),name:String(r.name || r.tag_name).slice(0,200),notes:String(r.body || '').slice(0,5000),publishedAt:r.published_at,prerelease:!!r.prerelease,assets:(r.assets || []).filter(a=>a.state==='uploaded'&&Number.isSafeInteger(a.id)&&a.size>0&&a.size<=128*1048576).slice(0,30).map(a=>({id:a.id,name:String(a.name).slice(0,160),bytes:a.size,digest:/^sha256:[a-f0-9]{64}$/.test(a.digest||'')?a.digest.slice(7):null}))}));
    config.commitChanged=!!previous&&previous!==commit.sha;config.checkedAt=now();delete config.error;
    history(store,product,'检查 Git 更新',config.repository,commit.sha);await store.commit();return config;
  }catch(e){config.error=e.status?e.message:'无法连接 GitHub，请稍后重试';config.checkedAt=now();await store.commit();return config;}
}
export async function downloadAsset(store, product, assetId, fetcher=fetch) {
  const config=store.state.repositories[product];
  if(!config?.checkedAt || Date.parse(config.checkedAt)<Date.now()-1800000 || config.error)throw failure('请先重新检查 Git 更新',409);
  const release=config.upstream?.find(r=>r.assets.some(a=>a.id===assetId)),asset=release?.assets.find(a=>a.id===assetId);
  if(!asset)throw failure('请选择已检查的 Git Release 附件');
  let url='https://api.github.com/repos/'+config.repository+'/releases/assets/'+asset.id, response;
  for(let n=0;n<5;n++) {
    const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||!['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(u.hostname))throw failure('附件下载地址无效',502);
    response=await fetcher(url,{headers:{Accept:'application/octet-stream','User-Agent':'Puffer-Terminal'},signal:AbortSignal.timeout(60000),redirect:'manual'});
    if(![301,302,303,307,308].includes(response.status))break;
    if(!response.headers.get('location'))throw failure('附件重定向无效',502);url=new URL(response.headers.get('location'),url).href;response=null;
  }
  if(!response?.ok)throw failure('Git 附件下载失败',502);
  if(Number(response.headers.get('content-length'))>128*1048576)throw failure('附件过大',413);
  let total=0;const chunks=[];for await(const chunk of response.body){total+=chunk.length;if(total>128*1048576)throw failure('附件过大',413);chunks.push(Buffer.from(chunk));}
  const bytes=Buffer.concat(chunks);if(bytes.length!==asset.bytes)throw failure('Git 附件大小已变化，请重新检查',409);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');if(asset.digest && hash!==asset.digest)throw failure('Git 附件摘要不符',409);
  return {bytes,asset,release,repository:config.repository};
}
