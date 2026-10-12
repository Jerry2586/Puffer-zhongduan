import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../server/store.mjs';
import {exportMigration,inspectMigration} from '../server/migration.mjs';
await fs.mkdir(process.env.HETUN_TEST_ROOT||os.tmpdir(),{recursive:true});

test('中断恢复：已移动和未移动的文件恢复成完整旧快照',async t=>{
 const root=await fs.mkdtemp(path.join(process.env.HETUN_TEST_ROOT||os.tmpdir(),'hetun-recover-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=await openStore(root),oldKey=s.publicKey;
 await fs.mkdir(path.join(root,'.migration-old'));await fs.mkdir(path.join(root,'.migration-new'));
 await fs.writeFile(path.join(root,'.migration-journal.json'),'{}');await fs.rename(path.join(root,'data.json'),path.join(root,'.migration-old/data.json'));await fs.writeFile(path.join(root,'data.json'),'broken');await fs.rename(path.join(root,'keys'),path.join(root,'.migration-old/keys'));
 const recovered=await openStore(root);assert.equal(recovered.publicKey,oldKey);assert.equal(recovered.state.schemaVersion,1);await assert.rejects(fs.access(path.join(root,'.migration-journal.json')));
});
test('合法加密但业务格式损坏的迁移包也被拒绝',async t=>{
 const root=await fs.mkdtemp(path.join(process.env.HETUN_TEST_ROOT||os.tmpdir(),'hetun-invalid-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=await openStore(root);await s.changePassword('1');s.state.settings.checkHours=999;const bytes=await exportMigration(s,'迁移','http://localhost');await assert.rejects(inspectMigration(bytes,'迁移'),/策略/);
});
