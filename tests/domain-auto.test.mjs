import test from 'node:test';
import assert from 'node:assert/strict';
import { planNginx } from '../scripts/nginx-domain-plan.mjs';
const dump=(config,files='')=>'# configuration file /etc/nginx/nginx.conf:\n'+config+'\n'+files;
test('auto-domain: select included conf.d without touching existing unrelated sites',()=>{
 assert.equal(planNginx(dump('http { include /etc/nginx/conf.d/*.conf; }','# configuration file /etc/nginx/conf.d/other.conf:\nserver { server_name other.example.com; }'),'sq.appgog.com'),'/etc/nginx/conf.d/hetun-sq.appgog.com.conf');
});
test('auto-domain: detect BaoTa and ignore commented directives',()=>{
 assert.equal(planNginx(dump('# http { include /etc/nginx/conf.d/*.conf; }\nhttp { include "/www/server/panel/vhost/nginx/*.conf"; }'),'sq.appgog.com'),'/www/server/panel/vhost/nginx/hetun-sq.appgog.com.conf');
});
test('auto-domain: adopt only dedicated existing hostname config',()=>{
 const file='# configuration file /etc/nginx/conf.d/sq.conf:\nserver { server_name sq.appgog.com; }\nserver { server_name sq.appgog.com; }';
 assert.equal(planNginx(dump('http { include /etc/nginx/conf.d/*.conf; }',file),'sq.appgog.com'),'/etc/nginx/conf.d/sq.conf');
 assert.throws(()=>planNginx(dump('http { include /etc/nginx/conf.d/*.conf; }',file.replace('sq.appgog.com;', 'sq.appgog.com other.example.com;')),'sq.appgog.com'),/共用/);
});
test('auto-domain: reject shared, duplicate and global sites',()=>{
 const server='server { server_name sq.appgog.com; }';
 assert.throws(()=>planNginx(dump('http { include /etc/nginx/conf.d/*.conf; '+server+' }'),'sq.appgog.com'),/共用/);
 assert.throws(()=>planNginx(dump('http { include /etc/nginx/conf.d/*.conf; }','# configuration file /etc/nginx/conf.d/one.conf:\n'+server+'\n# configuration file /etc/nginx/conf.d/two.conf:\n'+server),'sq.appgog.com'),/多个/);
 assert.throws(()=>planNginx(dump('http { include /etc/nginx/conf.d/*.conf; }','# configuration file /etc/nginx/conf.d/hetun-sq.appgog.com.conf:\nserver { server_name other.example.com; }'),'sq.appgog.com'),/其他站点/);
});
test('auto-domain: reject unsupported, injected and misplaced configurations',()=>{
 assert.throws(()=>planNginx(dump('events { include /etc/nginx/conf.d/*.conf; }'),'sq.appgog.com'),/未找到/);
 assert.throws(()=>planNginx(dump('http { include /etc/nginx/conf.d/*.conf; }'),'sq.appgog.com;evil'),/格式/);
 assert.equal(planNginx(dump('http { include /etc/nginx/sites-enabled/*; }'),'sq.appgog.com'),'/etc/nginx/sites-enabled/hetun-sq.appgog.com.conf');
});
