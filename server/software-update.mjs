import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { checkRepository, downloadAsset, history } from './product-center.mjs';
import { metadata, validatePackage, publicRelease } from './packages.mjs';
import { failure, now, sha } from './store.mjs';
import { PRODUCTS, VERSION } from './license.mjs';
const locks=new WeakMap();
export function installableAsset(asset){
 const name=asset.name.toLowerCase();
 if(/(?:source|sources|源码|checksum|sha256|manifest|blockmap|symbols|debug)/.test(name))return false;
 return /\.(exe|msi|apk|aab|ipa|dmg|deb|appimage|tar\.gz)$/.test(name)||(/\.zip$/.test(name)&&/(portable|win(?:dows)?|linux|mac(?:os)?|installer|setup|dist|release)/.test(name));
}
function assetPlatform(name){const n=name.toLowerCase();return /\.(exe|msi)$/.test(n)||/win(?:dows)?/.test(n)?'windows':/\.(apk|aab)$/.test(n)?'android':/\.ipa$/.test(n)?'ios':/\.(deb|appimage|tar\.gz)$/.test(n)||/linux/.test(n)?'linux':null;}
export async function updateSoftware(store,product,fetcher=fetch){
 if(!PRODUCTS.includes(product))throw failure('请选择产品软件');
 let active=locks.get(store);if(!active){active=new Set();locks.set(store,active);}if(active.has(product))throw failure('该产品正在更新，请等待完成',409);active.add(product);
 const files=[];let added=[];
 try{
  const config=await checkRepository(store,product,fetcher);if(config.error)throw failure(config.error,502);
  const upstream=(config.upstream||[]).filter(r=>!r.prerelease).sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt))[0];
  if(!upstream)return {updated:false,message:'仓库暂无正式成品版本',releases:[]};
  const version=upstream.tag.replace(/^v/i,'');if(!VERSION.test(version))throw failure('正式版本标签需使用版本号，例如 v1.2.3');
  const assets=upstream.assets.filter(a=>installableAsset(a)&&assetPlatform(a.name));if(!assets.length)return {updated:false,message:'最新正式版本没有可识别的成品安装包，源码不会自动发布',releases:[]};
  const pending=assets.filter(a=>!store.state.releases.some(r=>r.status==='published'&&r.product===product&&r.gitSource?.repository===config.repository&&r.gitSource?.assetId===a.id));
  if(!pending.length)return {updated:false,message:'已经是最新发布版本',version,releases:[]};
  // Download and validate every file before changing any published version.
  const staged=[];
  for(const asset of pending){
   const platform=assetPlatform(asset.name);if(!platform)throw failure('暂不支持自动发布此平台：'+asset.name+'，请手动上传并指定平台');
   const incoming=await downloadAsset(store,product,asset.id,fetcher);
   const m=metadata({kind:'software',product,platform,arch:/arm64|aarch64/i.test(asset.name)?'arm64':/x64|amd64|x86_64/i.test(asset.name)?'x64':'any',channel:'stable',version,name:(upstream.name||product).slice(0,80),notes:upstream.notes||'版本 '+version,filename:asset.name,sourceOrigin:'GitHub Release',gitSource:{repository:config.repository,assetId:asset.id,tag:upstream.tag}});
   const info=validatePackage(m,incoming.bytes);const id=crypto.randomUUID(),file=id+'.bin';
   staged.push({release:{id,...m,...info,file,bytes:incoming.bytes.length,sha256:sha(incoming.bytes),status:'published',createdAt:now(),publishedAt:now()},bytes:incoming.bytes});
  }
  for(const item of staged){const file=path.join(store.root,'files',item.release.file);await fs.writeFile(file,item.bytes,{flag:'wx',mode:0o600});files.push(file);}
  added=staged.map(x=>x.release);store.state.releases.unshift(...added);
  history(store,product,'更新并自动发布',upstream.tag,version+' · '+added.length+' 个成品文件');store.audit('更新并自动发布',product);await store.commit();
  return {updated:true,message:'版本 '+version+' 已自动发布，可选择授权推送',version,releases:added.map(publicRelease)};
 }catch(e){if(added.length)store.state.releases=store.state.releases.filter(r=>!added.some(x=>x.id===r.id));await Promise.all(files.map(f=>fs.rm(f,{force:true})));throw e;}finally{active.delete(product);}
}
