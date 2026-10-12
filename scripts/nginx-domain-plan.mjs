import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Read nginx -T output; never execute or rewrite directives from that output.
export function tokenize(text) {
  const tokens=[]; const pattern=/#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[{};]|[^\s{};#]+/g;
  for(const match of text.matchAll(pattern)) {
    let token=match[0]; if(token.startsWith('#'))continue;
    if(token.startsWith('"')||token.startsWith("'"))token=token.slice(1,-1);
    tokens.push(token);
  }
  return tokens;
}
export function planNginx(text,domain) {
  if(!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(domain))throw Error('域名格式无效');
  const files=[]; const headers=[...text.matchAll(/^# configuration file ([^\n]+):\r?$/gm)];
  for(let i=0;i<headers.length;i++)files.push({path:headers[i][1],text:text.slice(headers[i].index+headers[i][0].length,headers[i+1]?.index??text.length)});
  const included=[]; const named=[];
  for(const file of files) {
    const stack=[];let statement=[]; const names=[];
    for(const token of tokenize(file.text)) {
      if(token==='{'){stack.push(statement[0]);statement=[];}
      else if(token==='}'){stack.pop();statement=[];}
      else if(token===';'){
        if(statement[0]==='include'&&stack.at(-1)==='http')included.push(statement[1]);
        if(statement[0]==='server_name')names.push(...statement.slice(1));
        statement=[];
      }else statement.push(token);
    }
    if(names.includes(domain))named.push({path:file.path,names});
  }
  // Only known vhost locations. Arbitrary/global configuration is never replaced.
  const dirs=['/www/server/panel/vhost/nginx','/etc/nginx/conf.d','/etc/nginx/sites-enabled','/usr/local/nginx/conf/vhost'];
  const directory=dirs.find(dir=>included.includes(dir+'/*.conf')||included.includes(dir+'/*'));
  if(!directory)throw Error('未找到受支持的 Nginx 站点目录；现有网站未改动。支持宝塔、conf.d 和 sites-enabled。');
  let target=directory+'/hetun-'+domain+'.conf';
  if(named.length) {
    if(named.length!==1)throw Error('此域名分布在多个配置文件，已停止自动接入，避免影响已有网站。');
    const file=named[0];
    if(file.names.some(name=>name!==domain)||!dirs.some(dir=>file.path.startsWith(dir+'/'))||!file.path.endsWith('.conf'))
      throw Error('此域名与其他域名共用配置，无法安全自动替换；已有网站未改动。');
    target=file.path;
  }
  if(!named.length&&files.some(file=>file.path===target))throw Error('目标配置文件已存在且属于其他站点，停止覆盖。');
  if(!/^\/[A-Za-z0-9_./-]+$/.test(target)||target.split('/').includes('..'))throw Error('站点路径不支持安全自动处理。');
  return target;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try{console.log(planNginx(fs.readFileSync(0,'utf8'),process.argv[2]));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
