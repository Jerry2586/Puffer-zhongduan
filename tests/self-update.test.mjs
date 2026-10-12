import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {selfUpdater,UPDATE_REPO} from '../server/self-update.mjs';
const old='a'.repeat(40), next='b'.repeat(40);
const fetcher=async(url)=>{assert.equal(url,'https://api.github.com/repos/'+UPDATE_REPO+'/commits/main');return {ok:true,json:async()=>({sha:next,commit:{message:'更新说明\n正文'}})};};
async function fixture(t){const base=process.env.HETUN_TEST_ROOT||os.tmpdir();await fs.mkdir(base,{recursive:true});const directory=await fs.mkdtemp(path.join(base,'update-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.writeFile(path.join(directory,'agent.json'),JSON.stringify({at:new Date().toISOString()}));return {directory,up:selfUpdater({directory,revision:old,fetcher})};}
test('本地可检查固定 Git 仓库，禁止执行 Linux 更新',async()=>{const up=selfUpdater({fetcher});const s=await up.check();assert.equal(s.latest.sha,next);assert.equal(s.latest.message,'更新说明');assert.equal(s.enabled,false);await assert.rejects(up.queue(next),/本地开发/);});
test('只能提交检查过的版本，原子请求在重读后仍显示等待状态',async t=>{const {directory,up}=await fixture(t);await assert.rejects(up.queue(next),/重新检查/);await up.check();await assert.rejects(up.queue(old),/重新检查/);const task=await up.queue(next);assert.equal((await up.status()).task.id,task.id);assert.match(await fs.readFile(path.join(directory,'request'),'utf8'),new RegExp('^'+task.id+' '+next+'\n$'));await assert.rejects(up.queue(next),/已有更新/);assert.equal((await fs.readdir(directory)).some(n=>n.startsWith('.request-')),false);});
test('并发更新只有一个请求成功，完成与失败状态可读取',async t=>{const {directory,up}=await fixture(t);await up.check();const r=await Promise.allSettled([up.queue(next),up.queue(next)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);await fs.unlink(path.join(directory,'request'));await fs.writeFile(path.join(directory,'status.json'),JSON.stringify({state:'failed',message:'已回退'}));assert.equal((await up.status()).task.state,'failed');});
test('过期代理心跳与 Git 网络失败不会启用更新',async t=>{const {directory,up}=await fixture(t);await up.check();await fs.writeFile(path.join(directory,'agent.json'),JSON.stringify({at:'2020-01-01T00:00:00Z'}));await assert.rejects(up.queue(next),/未运行/);const broken=selfUpdater({fetcher:async()=>({ok:false})});await assert.rejects(broken.check(),/无法读取/);assert.equal((await broken.status()).latest,null);});
