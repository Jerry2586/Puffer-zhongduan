import { prepareTunnel, rollbackTunnel, verifyTunnel, completeTunnel } from '../server/cloudflare.mjs';
const root=process.env.HETUN_TERMINAL_DATA||'/data';
const [action,domain]=process.argv.slice(2);
try{
if(action==='verify'){await verifyTunnel(root,domain);await completeTunnel(root);console.log('HTTPS 和当前终端签名身份核验通过');}
else {let token='';for await(const chunk of process.stdin){token+=chunk;if(token.length>8192)throw Error('令牌长度无效');}if(action==='prepare'){await prepareTunnel(root,domain,token.trim());console.log('Tunnel 与 DNS 已准备，等待 HTTPS 核验');}else if(action==='rollback'){await rollbackTunnel(root,token.trim());console.log('Cloudflare 记录已回滚');}else throw Error('未知域名操作');}
}catch(e){console.error(e.message);process.exitCode=1;}
