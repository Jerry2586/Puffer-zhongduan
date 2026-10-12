import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { failure } from './store.mjs';
export const UPDATE_REPO = 'Jerry2586/Puffer-zhongduan';
export function selfUpdater({ directory, revision = '', fetcher = fetch } = {}) {
  let latest = null, checking = null;
  async function read(name) { try { return JSON.parse(await fs.readFile(path.join(directory,name),'utf8')); } catch { return null; } }
  async function status() {
    let agent = null, task = null;
    if (directory) { agent = await read('agent.json'); task = await read('status.json');
      try { const request=await fs.readFile(path.join(directory,'request'),'utf8'); const match=/^([a-f0-9-]{36}) ([a-f0-9]{40})\n$/.exec(request); if(match) task={id:match[1],revision:match[2],state:'queued',message:'等待 Linux 更新服务处理'}; } catch {} }
    const online = !!agent && Date.now()-Date.parse(agent.at) < 60000 && Date.parse(agent.at)<=Date.now()+5000;
    if (task && !['queued','running','complete','failed'].includes(task.state)) task=null;
    return { repository: UPDATE_REPO, branch:'main', currentRevision:revision, latest, available:!!latest && !!revision && latest.sha!==revision, enabled:online && !!revision, mode:directory?'linux':'local', task,
      note:directory ? (online?'Linux 更新服务在线':'Linux 更新服务未运行，请执行 sudo hetun update 安装或修复') : '当前为本地开发预览；可以检查 Git 更新，在线安装在 Linux 部署后使用' };
  }
  async function check() {
    if (checking) return checking;
    checking=(async()=>{
      try {
        const response=await fetcher('https://api.github.com/repos/'+UPDATE_REPO+'/commits/main',{headers:{Accept:'application/vnd.github+json','User-Agent':'Puffer-Terminal'},signal:AbortSignal.timeout(15000),redirect:'error'});
        if(!response.ok) throw Error();
        const commit=await response.json();
        if(!/^[a-f0-9]{40}$/.test(commit.sha)) throw Error();
        latest={sha:commit.sha,message:String(commit.commit?.message||'').split('\n')[0].slice(0,200),date:commit.commit?.committer?.date||null,checkedAt:new Date().toISOString()};
        return status();
      }catch{throw failure('无法读取 Git 仓库更新，请检查网络或稍后重试',502);}
      finally { checking=null; }
    })();
    return checking;
  }
  async function queue(sha) {
    const s=await status();
    if(!s.enabled) throw failure(s.note,409);
    if(!latest || Date.now()-Date.parse(latest.checkedAt)>600000 || sha!==latest.sha || !s.available) throw failure('请重新检查更新后选择当前 Git 版本',409);
    if(['queued','running'].includes(s.task?.state)) throw failure('已有更新正在执行',409);
    const id=crypto.randomUUID();
    const target=path.join(directory,'request');
    const temp=path.join(directory,'.request-'+id);
    try{await fs.writeFile(temp,id+' '+sha+'\n',{flag:'wx',mode:0o600});await fs.link(temp,target);}catch(e){if(e.code==='EEXIST')throw failure('已有更新等待处理',409);throw e;}finally{await fs.unlink(temp).catch(()=>{});}
    return {id,state:'queued',revision:sha,message:'更新请求已提交，正在等待 Linux 服务处理'};
  }
  return {status,check,queue};
}
