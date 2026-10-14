import crypto from 'node:crypto';
import { failure, now } from './store.mjs';
import { PRODUCTS, VERSION, compareVersions } from './license.mjs';
export const NOTICE_TYPES = ['message','banner','popup','maintenance'];
export function initializeCommunications(state) {
  for (const key of ['announcements','updatePushes','deliveryReceipts']) {
    if (state[key] === undefined) state[key] = [];
    if (!Array.isArray(state[key])) throw failure('通知数据格式无效：' + key);
  }
}
function text(value, max, required=false) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw failure('通知内容或长度无效');
  return value.trim();
}
function dates(input) {
  const result = {};
  for (const key of ['startsAt','endsAt']) {
    const value = input[key] || null;
    if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) throw failure('通知生效时间无效');
    result[key] = value ? new Date(value).toISOString() : null;
  }
  if (result.endsAt && result.startsAt && Date.parse(result.endsAt) <= Date.parse(result.startsAt)) throw failure('结束时间必须晚于开始时间');
  return result;
}
function audience(store, input) {
  const products = input.products;
  const customerIds = input.customerIds ?? [];
  if (!Array.isArray(products) || !products.length || products.length > 3 || products.some(p=>!PRODUCTS.includes(p)) || new Set(products).size !== products.length) throw failure('请选择授权产品');
  if (!Array.isArray(customerIds) || customerIds.length > 1000 || new Set(customerIds).size !== customerIds.length || customerIds.some(id=>!store.state.customers.some(c=>c.id===id))) throw failure('客户范围无效');
  const licenseIds=input.licenseIds??[];
  if(!Array.isArray(licenseIds)||licenseIds.length>1000||new Set(licenseIds).size!==licenseIds.length||licenseIds.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id)||(!store.validateHistorical&&!store.state.licenses.some(l=>l.id===id))))throw failure('授权范围无效');
  return { products, customerIds, licenseIds };
}
export function saveCommunication(store, kind, input, id) {
  initializeCommunications(store.state);
  const list = kind === 'update' ? store.state.updatePushes : store.state.announcements;
  const previous = id ? list.find(x=>x.id===id) : null;
  if (id && !previous) throw failure('通知不存在',404);
  if (previous && previous.status !== 'draft') throw failure('已发布通知请先撤回，再复制为新通知',409);
  const fields = { title:text(input.title,120,true), content:text(input.content ?? '',10000,kind !== 'update'), ...audience(store,input), ...dates(input) };
  if (kind === 'update') {
    const release = store.state.releases.find(r=>r.id===input.releaseId && PRODUCTS.includes(r.product) && ['software','installer'].includes(r.kind));
    if (!release || fields.products.length !== 1 || fields.products[0] !== release.product) throw failure('推送只能绑定对应产品的软件安装版本');
    Object.assign(fields,{releaseId:release.id,force:input.force===true});
  } else {
    if (!NOTICE_TYPES.includes(input.type)) throw failure('公告展示类型无效');
    Object.assign(fields,{type:input.type,requireConfirmation:input.requireConfirmation===true});
    if (input.releaseId) {
      const r=store.state.releases.find(r=>r.id===input.releaseId && ['software','installer'].includes(r.kind) && fields.products.length===1 && fields.products[0]===r.product);
      if(!r) throw failure('更新公告必须绑定单个对应产品的软件安装版本');
      fields.releaseId=r.id;
    } else fields.releaseId=null;
  }
  const value=previous || {id:crypto.randomUUID(),kind,status:'draft',revision:1,createdAt:now()};
  Object.assign(value,fields,{updatedAt:now()});
  if(previous)value.revision++;
  else list.unshift(value);
  store.audit(kind==='update'?'保存更新推送':'保存公告',value.id);
  return value;
}
export function sendSoftwarePush(store,input) {
  if(!PRODUCTS.includes(input.product)||!VERSION.test(input.version||''))throw failure('产品或版本无效');
  const releases=store.state.releases.filter(r=>r.product===input.product&&r.version===input.version&&r.channel==='stable'&&['software','installer'].includes(r.kind)&&r.status==='published');
  if(!releases.length)throw failure('该版本没有已发布的正式成品',409);
  const shadow={state:{...store.state,announcements:[],updatePushes:[]},audit(){}};
  const pushes=releases.map(r=>{const n=saveCommunication(shadow,'update',{...input,title:input.title||input.product+' v'+input.version,content:input.content??r.notes,products:[input.product],releaseId:r.id});return changeCommunication(shadow,'update',n.id,'published');});
  store.state.updatePushes.unshift(...pushes);store.audit('推送产品版本',input.product+' '+input.version);return {pushes,count:pushes.length};
}
export function changeCommunication(store,kind,id,status) {
  const list=kind==='update'?store.state.updatePushes:store.state.announcements;
  const item=list.find(x=>x.id===id);
  if(!item)throw failure('通知不存在',404);
  if(!['published','withdrawn'].includes(status))throw failure('通知状态无效');
  if(item.status===status)return item;
  if(status==='published') {
    if(item.status!=='draft')throw failure('撤回通知不可再次发布，请复制创建',409);
    if(item.endsAt && Date.parse(item.endsAt)<=Date.now())throw failure('通知已过期');
    if(item.releaseId && !store.state.releases.some(r=>r.id===item.releaseId && r.status==='published'))throw failure('请先在版本中心发布关联版本');
    item.publishedAt=now();
  }
  Object.assign(item,{status,updatedAt:now()});
  store.audit((status==='published'?'发布':'撤回')+(kind==='update'?'更新推送':'公告'),id);
  return item;
}
export function live(item, at=Date.now()) {
  return item.status==='published' && (!item.startsAt || Date.parse(item.startsAt)<=at) && (!item.endsAt || Date.parse(item.endsAt)>at);
}
export function visible(store,item,license,binding,at=Date.now()) {
  return live(item,at) && item.products.includes(binding.product) && (!item.customerIds.length || item.customerIds.includes(license.customerId)) && (!item.licenseIds?.length || item.licenseIds.includes(license.id)) && (!item.releaseId || store.state.releases.some(r=>r.id===item.releaseId && r.status==='published'));
}
export function communicationFeed(store,license,binding) {
  return [...store.state.announcements,...store.state.updatePushes].filter(x=>visible(store,x,license,binding)).map(x=>{
    const receipt=store.state.deliveryReceipts.find(r=>r.notificationId===x.id && r.revision===x.revision && r.bindingId===binding.id);
    const {customerIds,licenseIds,...publicItem}=x; return {...publicItem,receipt:receipt?{status:receipt.status,updatedAt:receipt.updatedAt}:null};
  });
}
export function acknowledgeCommunication(store,license,binding,input) {
  const item=[...store.state.announcements,...store.state.updatePushes].find(x=>x.id===input.notificationId);
  if(!item || !visible(store,item,license,binding))throw failure('通知不可用或不在授权范围',404);
  if(input.revision!==item.revision)throw failure('通知版本已变化，请重新获取',409);
  const statuses=item.kind==='update'?['received','read','confirmed','downloaded','installing','installed','failed']:['received','read','confirmed'];
  if(!statuses.includes(input.status))throw failure('接收状态无效');
  const message=text(input.message??'',300);
  if(input.status==='installed') {
    const release=store.state.releases.find(r=>r.id===item.releaseId);
    if(input.version!==release.version)throw failure('安装结果版本与推送不符');
  }
  let receipt=store.state.deliveryReceipts.find(r=>r.notificationId===item.id && r.revision===item.revision && r.bindingId===binding.id);
  if(!receipt) {
    if(store.state.deliveryReceipts.length>=100000)throw failure('通知记录已达到上限，请归档',409);
    receipt={id:crypto.randomUUID(),notificationId:item.id,revision:item.revision,bindingId:binding.id,licenseId:license.id,customerId:license.customerId,product:binding.product,status:'received',createdAt:now(),events:[]};
    store.state.deliveryReceipts.unshift(receipt);
  }
  // Repeated polling or delayed read receipts must never downgrade installation success.
  const rank=s=>s==='failed'?4:statuses.indexOf(s);
  if(input.status!==receipt.status && receipt.status!=='installed' && (rank(input.status)>=rank(receipt.status) || receipt.status==='failed' && ['installing','installed'].includes(input.status)))receipt.status=input.status;
  if(!receipt.events.some(e=>e.status===input.status && e.message===message))receipt.events=[...receipt.events,{status:input.status,message,at:now()}].slice(-30);
  receipt.updatedAt=now();
  const release=store.state.releases.find(r=>r.id===item.releaseId);
  const currentOrNewer=release && (!VERSION.test(binding.version||'') || compareVersions(release.version,binding.version)>=0);
  if(input.status==='installed' && currentOrNewer)Object.assign(binding,{version:input.version,updateStatus:'current',updateError:'',lastSeenAt:now()});
  else if(currentOrNewer && receipt.status===input.status && (input.status==='installing' || input.status==='failed'))Object.assign(binding,{updateStatus:input.status==='failed'?'failed':'updating',updateError:message,lastSeenAt:now()});
  return receipt;
}
export function updateDistribution(store,license,binding) {
  const managed=new Set(store.state.updatePushes.map(x=>x.releaseId));
  const eligible=store.state.updatePushes.filter(x=>visible(store,x,license,binding));
  return { releaseIds:new Set(eligible.map(x=>x.releaseId)), managed, pushes:eligible };
}
export function validateCommunications(state) {
  initializeCommunications(state);
  for(const [key,kind] of [['announcements','announcement'],['updatePushes','update']]) {
    const ids=new Set();
    for(const x of state[key]) {
      if(!x || typeof x.id!=='string' || ids.has(x.id) || x.kind!==kind || !Number.isInteger(x.revision) || x.revision<1 || !['draft','published','withdrawn'].includes(x.status))throw failure('迁移通知数据无效');
      ids.add(x.id);
      saveCommunication({state:{...state,announcements:[],updatePushes:[]},validateHistorical:true,audit(){}},kind,x);
    }
  }
  if(state.deliveryReceipts.some(x=>!x || typeof x.id!=='string' || typeof x.bindingId!=='string' || !Array.isArray(x.events)))throw failure('迁移接收记录无效');
}
