import { diagnoseDomain } from '../server/cloudflare.mjs';
try {
  const result=await diagnoseDomain(process.env.HETUN_TERMINAL_DATA||'/data',process.argv[2]);
  console.log('检查通过：'+result.url+'；HTTPS 与当前终端身份匹配。');
} catch(e) { console.error(e.message); process.exitCode=1; }
