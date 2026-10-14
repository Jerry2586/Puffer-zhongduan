import crypto from 'node:crypto';
import { failure, now } from './store.mjs';
import { PRODUCTS } from './license.mjs';
export function packageFields(input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw failure('套餐名称为1–80字');
  if (!Array.isArray(input.products) || !input.products.length || new Set(input.products).size !== input.products.length || input.products.some(p=>!PRODUCTS.includes(p))) throw failure('请选择有效的授权产品');
  if (![null,'online','silent-local'].includes(input.authorizationMode)) throw failure('套餐授权模式无效');
  if (!['days','months','years','permanent'].includes(input.durationUnit)) throw failure('套餐期限单位无效');
  const duration=Number(input.duration);
  if (input.durationUnit!=='permanent' && (!Number.isInteger(duration)||duration<1||duration>36500)) throw failure('套餐期限必须为1–36500的整数');
  if (!['optional','required'].includes(input.domainRule)) throw failure('套餐域名规则无效');
  const quotas={};for(const p of PRODUCTS){const n=Number(input.quotas?.[p]??(p==='operations'?1:2));if(!Number.isInteger(n)||n<1||n>100)throw failure('产品名额为1–100');quotas[p]=n;}
  return {name:input.name.trim(),products:[...input.products],authorizationMode:input.authorizationMode,durationUnit:input.durationUnit,duration:input.durationUnit==='permanent'?null:duration,domainRule:input.domainRule,quotas,permissions:Object.fromEntries(['sourceDownload','localBuild','cloudBuild'].map(k=>[k,input.permissions?.[k]!==false]))};
}
export function initializePackages(state){state.authorizationPackages??=[];}
export function savePackage(store,input,id){const fields=packageFields(input);let item;if(id){item=store.state.authorizationPackages.find(x=>x.id===id);if(!item)throw failure('套餐不存在',404);Object.assign(item,fields,{updatedAt:now(),revision:item.revision+1});}else{if(store.state.authorizationPackages.length>=200)throw failure('套餐最多200个');item={...fields,id:crypto.randomUUID(),revision:1,createdAt:now(),updatedAt:now()};store.state.authorizationPackages.push(item);}return item;}
export function packageGrant(store,input,clock=new Date()){
  const item=store.state.authorizationPackages.find(x=>x.id===input.packageId);if(!item)throw failure('套餐不存在，请重新选择',404);
  if(input.packageRevision!==item.revision)throw failure('套餐已修改，请重新选择后签发',409);
  const snapshot=structuredClone(item),expiry=new Date(clock),day=expiry.getUTCDate();
  if(item.durationUnit==='permanent')expiry.setTime(Date.parse('9999-12-31T23:59:59.000Z'));
  else if(item.durationUnit==='days')expiry.setUTCDate(day+item.duration);
  else {expiry.setUTCDate(1);expiry.setUTCMonth(expiry.getUTCMonth()+item.duration*(item.durationUnit==='years'?12:1));const last=new Date(Date.UTC(expiry.getUTCFullYear(),expiry.getUTCMonth()+1,0)).getUTCDate();expiry.setUTCDate(Math.min(day,last));}
  if(!Number.isFinite(expiry.getTime())||expiry.getUTCFullYear()>9999)throw failure('套餐期限超出支持范围');
  if(item.domainRule==='required'&&(!Array.isArray(input.domains)||!input.domains.length))throw failure('该套餐需要填写授权域名');
  return {...input,products:snapshot.products,quotas:snapshot.quotas,permissions:snapshot.permissions,authorizationMode:snapshot.authorizationMode,domainRequired:item.domainRule==='required',expiresAt:expiry.toISOString(),entitlement:item.durationUnit==='permanent'?'permanent':'term',packageSnapshot:snapshot};
}
export function validatePackages(state){if(state.authorizationPackages===undefined)return;const items=state.authorizationPackages;if(!Array.isArray(items)||items.length>200||new Set(items.map(x=>x?.id)).size!==items.length)throw failure('迁移套餐列表无效');for(const x of items){if(!/^[a-f0-9-]{36}$/.test(x.id)||!Number.isSafeInteger(x.revision)||x.revision<1||!Number.isFinite(Date.parse(x.createdAt)))throw failure('迁移套餐身份无效');packageFields(x);}}
