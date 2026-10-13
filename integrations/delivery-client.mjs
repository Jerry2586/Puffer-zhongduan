import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
// Products provide their own secure credential store and installation executor.
export function createDeliveryClient({origin,publicKey,key,activationId,product,version,platform,arch='any',channel='stable',fetcher=fetch}) {
  const issuer=new URL(origin).origin;
  if(origin.replace(/\/$/,'')!==issuer || (!issuer.startsWith('https://') && !['localhost','127.0.0.1','[::1]'].includes(new URL(issuer).hostname)))throw Error('需要 HTTPS 终端地址');
  if(!publicKey || !key || !activationId || !['packer','theme-center','operations'].includes(product))throw Error('请提供已激活的产品身份和固定信任公钥');
  crypto.createPublicKey(publicKey);
  const headers={Authorization:'Bearer '+key,'X-Hetun-Activation':activationId};
  async function request(route,options={}) {
    if(!route.startsWith('/v1/') || route.startsWith('//'))throw Error('接口路径无效');
    const res=await fetcher(issuer+route,{...options,headers:{...headers,...options.headers},redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!res.ok)throw Error('终端请求失败（'+res.status+'）');
    return res;
  }
  function verify(envelope) {
    if(envelope?.algorithm!=='Ed25519' || typeof envelope.payload!=='string' || envelope.payload.length>2000000 || typeof envelope.signature!=='string')throw Error('签名清单无效');
    const bytes=Buffer.from(envelope.payload,'base64url');
    if(!crypto.verify(null,bytes,publicKey,Buffer.from(envelope.signature,'base64url')))throw Error('签名验证失败');
    const result=JSON.parse(bytes);
    if(result.issuer!==issuer || result.product!==product || result.schemaVersion!==1 || !Number.isFinite(Date.parse(result.checkedAt)) || Math.abs(Date.now()-Date.parse(result.checkedAt))>600000)throw Error('清单身份或时间无效');
    return result;
  }
  async function ack(item,status,extra={}) {
    await request('/v1/notifications/ack',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...extra,notificationId:item.id,revision:item.revision,status})});
  }
  async function notifications() {
    const value=verify(await (await request('/v1/notifications')).json());
    if(value.activationId!==activationId || !Array.isArray(value.items))throw Error('通知激活身份不符');
    for(const item of value.items)if(!item.receipt)await ack(item,'received');
    return value.items;
  }
  async function updates() {
    const params=new URLSearchParams({product,version,platform,arch,channel});
    const value=verify(await (await request('/v1/updates?'+params)).json());
    if(value.currentVersion!==version)throw Error('更新检查版本不符');
    return value;
  }
  async function download(manifest,directory) {
    // Verify again; callers cannot substitute an unsigned release object.
    const value=verify(manifest),r=value.release;
    if(!value.updateAvailable || !r || !['software','installer'].includes(r.kind) || r.product!==product || !['all',platform].includes(r.platform) || !['any',arch].includes(r.arch) || r.channel!==channel || !/^[a-f0-9-]{36}$/.test(r.id) || r.downloadPath!=='/v1/releases/'+r.id+'/download' || !/^[a-f0-9]{64}$/.test(r.sha256) || !Number.isSafeInteger(r.bytes) || r.bytes<4 || r.bytes>128*1024*1024 || !path.isAbsolute(directory))throw Error('更新文件信息无效');
    await fs.mkdir(directory,{recursive:true});
    const target=path.join(directory,r.id+'.download'),tmp=path.join(directory,crypto.randomUUID()+'.partial');
    const res=await request(r.downloadPath),handle=await fs.open(tmp,'wx',0o600),hash=crypto.createHash('sha256');let count=0;
    try {
      for await(const chunk of res.body){count+=chunk.length;if(count>r.bytes)throw Error('下载文件大小异常');hash.update(chunk);await handle.writeFile(chunk);}
      if(count!==r.bytes || hash.digest('hex')!==r.sha256)throw Error('下载文件完整性校验失败');
      await handle.close();await fs.rename(tmp,target);return {path:target,release:r};
    }catch(error){await handle.close().catch(()=>{});await fs.unlink(tmp).catch(()=>{});throw error;}
  }
  async function downloadUpdate(directory) {
    const params=new URLSearchParams({product,version,platform,arch,channel});
    return download(await (await request('/v1/updates?'+params)).json(),directory);
  }
  async function verifyBeforeInstall(file,release) {
    const content=await fs.readFile(file);
    if(content.length!==release.bytes || crypto.createHash('sha256').update(content).digest('hex')!==release.sha256)throw Error('本地更新包被修改');
    return file;
  }
  return {notifications,updates,ack,downloadUpdate,verifyBeforeInstall};
}
