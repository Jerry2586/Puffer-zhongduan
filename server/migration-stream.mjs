import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { inspectMigration, validateSnapshot } from './migration.mjs';
const derive=promisify(crypto.scrypt),magic=Buffer.from('HETUNM02');
export const migrationLimit=8*1024*1024*1024;
const metadataLimit=8*1024*1024;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const pass=v=>{if(typeof v!=='string'||!v||Buffer.byteLength(v)>4096)throw fail('请输入迁移密码（最多 4096 字节）');};
async function disk(root,needed){const stats=await fs.statfs(root,{bigint:true});if(stats.bavail*stats.bsize<BigInt(needed)+32n*1024n*1024n)throw fail('服务器临时磁盘空间不足，请释放空间后重试',507);}
async function temp(root){return fs.mkdtemp(path.join(root,'.transfer-'));}
function guard(max){let n=0;return new Transform({transform(b,_enc,cb){n+=b.length;cb(n>max?fail('迁移包超过 8 GiB 限制',413):null,b);}});}
function artifacts(state){const map=new Map();for(const r of [...state.releases,...state.jobs.map(j=>j.artifact).filter(Boolean)]){
  if(!/^[a-f0-9-]{36}\.bin$/.test(r.file)||!Number.isSafeInteger(r.bytes)||r.bytes<1||!/^[a-f0-9]{64}$/.test(r.sha256))throw fail('业务文件清单无效');
  const previous=map.get(r.file);if(previous&&(previous.bytes!==r.bytes||previous.sha256!==r.sha256))throw fail('业务文件记录冲突');map.set(r.file,{bytes:r.bytes,sha256:r.sha256});
}return map;}
export async function exportMigrationFile(store,password,origin){
  pass(password);if(store.state.jobs.some(j=>j.status==='running'))throw fail('请等待正在运行的构建完成后导出',409);
  const state=structuredClone(store.state),required=artifacts(state);const total=[...required.values()].reduce((n,r)=>n+r.bytes,0);if(total>migrationLimit-metadataLimit)throw fail('业务文件累计超过 8 GiB，请使用 Linux 备份恢复',413);
  const snapshot={format:'hetun-migration',version:1,createdAt:new Date().toISOString(),origin,state,admin:store.admin,privateKey:store.privateKey,publicKey:store.publicKey,files:{}};
  const metadata=Buffer.from(JSON.stringify(snapshot));if(metadata.length>metadataLimit)throw fail('业务记录过大，请使用 Linux 备份恢复');
  await disk(store.root,total+metadata.length+metadataLimit);
  const dir=await temp(store.root),file=path.join(dir,'migration.hetun'),salt=crypto.randomBytes(16),iv=crypto.randomBytes(12);
  const cleanup=()=>fs.rm(dir,{recursive:true,force:true});
  try{
    const cipher=crypto.createCipheriv('aes-256-gcm',await derive(password,salt,32),iv);
    await fs.writeFile(file,Buffer.concat([magic,salt,iv]),{mode:0o600,flag:'wx'});
    async function* content(){const length=Buffer.alloc(4);length.writeUInt32BE(metadata.length);yield length;yield metadata;
      for(const [name,r]of required){const stat=await fs.stat(path.join(store.root,'files',name));if(!stat.isFile()||stat.size!==r.bytes)throw fail('业务文件缺失或大小异常');
        let n=0;const hash=crypto.createHash('sha256');for await(const b of createReadStream(path.join(store.root,'files',name))){n+=b.length;hash.update(b);yield b;}
        if(n!==r.bytes||hash.digest('hex')!==r.sha256)throw fail('业务文件完整性异常，迁移已停止');
      }
    }
    await pipeline(Readable.from(content()),guard(migrationLimit),createGzip(),cipher,createWriteStream(file,{flags:'a',mode:0o600}));
    await fs.appendFile(file,cipher.getAuthTag());const bytes=(await fs.stat(file)).size;
    if(bytes>migrationLimit)throw fail('加密迁移包超过 8 GiB，请使用 Linux 备份恢复',413);
    return {path:file,bytes,cleanup};
  }catch(e){await cleanup();throw e;}
}
export async function receiveMigration(root,req){
  const length=Number(req.headers['content-length']);if(length>migrationLimit)throw fail('迁移包超过 8 GiB 限制',413);
  const dir=await temp(root),file=path.join(dir,'upload.hetun'),cleanup=()=>fs.rm(dir,{recursive:true,force:true});
  try{await pipeline(req,guard(migrationLimit),createWriteStream(file,{flags:'wx',mode:0o600}));return {path:file,cleanup};}catch(e){await cleanup();throw e;}
}
async function readAt(handle,length,position){const b=Buffer.alloc(length);let read=0;while(read<length){const n=(await handle.read(b,read,length-read,position+read)).bytesRead;if(!n)throw fail('迁移包内容不完整');read+=n;}return b;}
export async function inspectMigrationFile(root,file,password){
  pass(password);const stat=await fs.stat(file);if(stat.size<53||stat.size>migrationLimit)throw fail('请选择有效的 .hetun 迁移包');
  const input=await fs.open(file,'r');let header,tag;try{header=await readAt(input,36,0);tag=await readAt(input,16,stat.size-16);}finally{await input.close();}
  if(header.subarray(0,8).toString()==='HETUNM01'){if(stat.size>128*1024*1024)throw fail('旧版迁移包过大');return {...await inspectMigration(await fs.readFile(file),password),cleanup:async()=>{}};}
  if(!header.subarray(0,8).equals(magic))throw fail('迁移包格式不支持');
  const dir=await temp(root),plain=path.join(dir,'plain'),cleanup=()=>fs.rm(dir,{recursive:true,force:true});
  try{
    const decipher=crypto.createDecipheriv('aes-256-gcm',await derive(password,header.subarray(8,24),32),header.subarray(24,36));decipher.setAuthTag(tag);
    // Never parse or import unauthenticated plaintext. Decrypt+authenticate completely on disk first.
    try{await pipeline(createReadStream(file,{start:36,end:stat.size-17}),decipher,createGunzip(),guard(migrationLimit),createWriteStream(plain,{flags:'wx',mode:0o600}));}catch(e){if(e.code==='ENOSPC')throw fail('服务器临时磁盘空间不足',507);throw fail('迁移密码错误、迁移包损坏或超出容量限制');}
    const handle=await fs.open(plain,'r');let value,position;
    try{const length=(await readAt(handle,4,0)).readUInt32BE();if(length>metadataLimit)throw fail('迁移记录过大');value=JSON.parse((await readAt(handle,length,4)).toString('utf8'));position=4+length;}finally{await handle.close();}
    const required=artifacts(value.state),files=new Map();validateSnapshot(value,files);
    await disk(root,[...required.values()].reduce((n,r)=>n+r.bytes*2,0));
    for(const [name,r]of required){const out=path.join(dir,name),hash=crypto.createHash('sha256');let bytes=0;
      await pipeline(createReadStream(plain,{start:position,end:position+r.bytes-1}),new Transform({transform(b,_enc,cb){bytes+=b.length;hash.update(b);cb(null,b);}}),createWriteStream(out,{flags:'wx',mode:0o600}));
      if(bytes!==r.bytes||hash.digest('hex')!==r.sha256)throw fail('迁移文件校验失败');files.set(name,{path:out,bytes});position+=r.bytes;
    }
    if(position!==(await fs.stat(plain)).size)throw fail('迁移包有多余或缺失文件');
    await fs.unlink(plain);return {...validateSnapshot(value,files),cleanup};
  }catch(e){await cleanup();throw e.status?e:fail('迁移包业务数据无效');}
}
