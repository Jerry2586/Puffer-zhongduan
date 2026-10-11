import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
let count=0;
for(const dir of ['server','public','scripts','tests']) for(const name of await fs.readdir(path.join(root,dir))) if(/\.(mjs|js)$/.test(name)) {
 const result=spawnSync(process.execPath,['--check',path.join(root,dir,name)],{encoding:'utf8'});
 if(result.status!==0){console.error(result.stderr);process.exit(1);} count++;
}
for(const name of ['index.html','logo.svg','style.css','app.js']) await fs.access(path.join(root,'public',name));
console.log('Syntax and static assets checked: '+count+' scripts.');
