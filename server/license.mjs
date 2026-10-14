import { migrating, configuration } from './authority.mjs';
import { policy } from './product-center.mjs';
import crypto from 'node:crypto';
import { domainToASCII } from 'node:url';
import { failure, sha, now } from './store.mjs';
export const PRODUCTS = ['theme-center', 'packer', 'operations'];
export const PRODUCT_NAMES = { 'theme-center': '主题中心', packer: '打包器', operations: '影视中心〔APP 后台〕', client: 'APP 客户端' };
export const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/;
export function compareVersions(a, b) {
  const [ac, ap] = a.split(/-(.*)/s), [bc, bp] = b.split(/-(.*)/s);
  const aa = ac.split('.').map(Number), bb = bc.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  if (!ap && bp) return 1; if (ap && !bp) return -1;
  const ax = (ap || '').split('.'), bx = (bp || '').split('.');
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    if (ax[i] === bx[i]) continue;
    if (ax[i] === undefined) return -1; if (bx[i] === undefined) return 1;
    const an = /^\d+$/.test(ax[i]), bn = /^\d+$/.test(bx[i]);
    if (an && bn) return Number(ax[i]) > Number(bx[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ax[i] > bx[i] ? 1 : -1;
  }
  return 0;
}
export function hostname(value) {
  let s = String(value || '').trim().toLowerCase();
  if (s.includes('://')) { const u = new URL(s); if (u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw failure('域名不能包含路径或凭据'); s = u.hostname; }
  s = domainToASCII(s.replace(/\.$/, ''));
  if (s.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(s)) throw failure('请输入有效的完整域名，不含端口');
  return s;
}
export function sign(store, payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return { algorithm: 'Ed25519', keyId: sha(store.publicKey).slice(0, 16), payload: bytes.toString('base64url'), signature: crypto.sign(null, bytes, store.privateKey).toString('base64url') };
}
export function customerLicense(store, req) {
  const auth = String(req.headers.authorization || '');
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!/^HTN_[A-Za-z0-9_-]{43}$/.test(key)) throw failure('请提供授权 Key', 401);
  const l = store.state.licenses.find(x => x.keyHash === sha(key));
  if (!l || l.status !== 'active' || Date.parse(l.expiresAt) <= Date.now()) throw failure('授权不存在、已停用或已到期', 403);
  return l;
}
export function publicLicense(l) { const { keyHash, ...rest } = l; return rest; }
export function activate(store, req, b, issuer) {
  const license = customerLicense(store, req);
  if (!PRODUCTS.includes(b.product) || !license.products.includes(b.product)) throw failure('未授权此产品', 403);
  const binding = b.product === 'operations' ? hostname(b.domain) : String(b.deviceId || '');
  if (b.product !== 'operations' && !/^[A-Za-z0-9_:-]{8,120}$/.test(binding)) throw failure('设备标识无效');
  if (!VERSION.test(b.version || '')) throw failure('客户端版本无效');
  if (typeof b.nonce !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(b.nonce)) throw failure('需要有效的请求随机数');
  const currentPolicy = policy(store, license);
  const domain = b.domain ? hostname(b.domain) : '';
  if (license.domainRequired && !domain) throw failure('此授权必须绑定域名',403);
  if (currentPolicy.domains.length && !currentPolicy.domains.includes(domain)) throw failure('此域名不在授权范围内', 403);
  let record = store.state.bindings.find(x => x.licenseId === license.id && x.product === b.product && x.binding === binding);
  if (record?.status === 'disabled') throw failure('此绑定已停用，请联系管理员', 403);
  if (!record && migrating(store))throw failure('迁移期间暂不接受新设备激活，已有激活可继续验证',503);
  if (!record) {
    const count = store.state.bindings.filter(x => x.licenseId === license.id && x.product === b.product && x.status === 'active').length;
    if (count >= license.quotas[b.product] && !verifiedMigration(store,b,license,currentPolicy)) throw failure('设备或站点授权名额已满', 409);
    record = { id: crypto.randomUUID(), licenseId: license.id, product: b.product, binding, kind: b.product === 'operations' ? 'domain' : 'device', status: 'active', parentDeviceId:verifiedMigration(store,b,license,currentPolicy)?b.parentDeviceId:'', activatedAt: now() };
    store.state.bindings.unshift(record); store.audit('产品激活', record.id);
  }
  Object.assign(record, { version: b.version, lastSeenAt: now(), os:String(b.os||'').slice(0,80), label: String(b.label || '').slice(0, 80), domain:domain || record.domain || '', policyRevision:currentPolicy.revision, authorizationMode:currentPolicy.mode, policyFetchedAt:now() });
  const iat = Math.floor(Date.now() / 1000), days = 3;
  const payload = { schemaVersion: 4, issuer, offlineMigration:currentPolicy.mode==='silent-local', offlineDays:days, onlineGraceSeconds:currentPolicy.onlineGraceSeconds, checkIntervalSeconds:currentPolicy.checkIntervalSeconds, customerId:license.customerId, domain:domain || record.domain || '', authorizationMode:currentPolicy.mode, policyRevision:currentPolicy.revision, authorizedDomains:currentPolicy.domains, reconnectHours:currentPolicy.reconnectHours, licenseId: license.id, activationId: record.id, product: b.product, binding, nonce: b.nonce, iat, exp: currentPolicy.mode==='silent-local' ? Math.floor(Date.parse(license.expiresAt) / 1000) : Math.min(iat + days * 86400, Math.floor(Date.parse(license.expiresAt) / 1000)), licenseExpiresAt: license.expiresAt, entitlement:license.entitlement||'term', checkAfter: Math.min(iat + (currentPolicy.mode==='silent-local' ? currentPolicy.reconnectHours * 3600 : currentPolicy.checkIntervalSeconds), Math.floor(Date.parse(license.expiresAt) / 1000)), permissions: license.permissions };
  if(currentPolicy.mode==='silent-local'&&migrating(store)&&Number.isFinite(Date.parse(store.state.authority.graceUntil)))payload.exp=Math.max(payload.exp,Math.min(Math.floor(Date.parse(store.state.authority.graceUntil)/1000),Math.floor(Date.parse(license.expiresAt)/1000)));
  return { terminalConfig:configuration(store,issuer), activationId: record.id, lease: sign(store, payload), offlineDays: days, policy:currentPolicy };
}
export function authorizedBinding(store, req, product) {
  const license = customerLicense(store, req);
  const binding = store.state.bindings.find(x => x.id === req.headers['x-hetun-activation'] && x.licenseId === license.id && x.status === 'active');
  if (!binding || !license.products.includes(binding.product) || (product && binding.product !== product)) throw failure('请先激活对应产品', 403);
  const domains=policy(store,license).domains;if(domains.length&&!domains.includes(binding.product==='operations'?binding.binding:binding.domain))throw failure('绑定域名不在当前授权范围',403);
  return { license, binding };
}

function verifiedMigration(store,b,license,currentPolicy) {
 if(currentPolicy.mode!=='silent-local'||!b.parentDeviceId||!b.migrationLease)return false;
 try {const e=b.migrationLease,bytes=Buffer.from(e.payload,'base64url');if(e.algorithm!=='Ed25519'||!crypto.verify(null,bytes,store.publicKey,Buffer.from(e.signature,'base64url')))return false;const p=JSON.parse(bytes);return p.licenseId===license.id&&p.product===b.product&&p.binding===b.parentDeviceId&&p.authorizationMode==='silent-local'&&p.offlineMigration===true&&p.domain===(b.domain||'')&&p.exp>Date.now()/1000&&store.state.bindings.some(x=>x.licenseId===license.id&&x.product===b.product&&x.binding===b.parentDeviceId&&x.status==='active');}catch{return false;}
}
