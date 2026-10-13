import { history } from './product-center.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { failure, sha, now } from './store.mjs';
import { PRODUCTS, VERSION, compareVersions, sign } from './license.mjs';
import { readZip } from './zip.mjs';
export const KINDS = ['software', 'product-source', 'client-source', 'theme', 'installer'];
export const PLATFORMS = ['windows', 'linux', 'android', 'ios', 'web', 'all'];
export function publicRelease(r) { const { file, ...value } = r; return { ...value, downloadPath: '/v1/releases/' + r.id + '/download' }; }
export function metadata(input) {
  const m = { kind: input.kind, product: input.product, platform: input.platform, arch: input.arch || 'any', channel: input.channel || 'stable', version: input.version, name: String(input.name || '').trim(), notes: String(input.notes || '').trim(), minVersion: input.minVersion || '0.0.0', force: input.force === true, engine: input.engine || 'none', filename: String(input.filename || '') };
  if (!KINDS.includes(m.kind) || ![...PRODUCTS, 'client'].includes(m.product) || !PLATFORMS.includes(m.platform) || !['any', 'x64', 'arm64'].includes(m.arch) || !['stable', 'beta'].includes(m.channel) || !VERSION.test(m.version || '') || !VERSION.test(m.minVersion) || !m.name || m.name.length > 80 || !m.notes || m.notes.length > 5000 || !['none', 'flutter', 'uniapp'].includes(m.engine)) throw failure('版本信息不完整或格式无效');
  if (m.kind === 'software' && !PRODUCTS.includes(m.product)) throw failure('软件发布只能选择三个产品');
  if (['client-source','theme'].includes(m.kind) && m.product !== 'client') throw failure('APP 源码与主题模板归属客户端资源');
  if (m.kind === 'product-source' && !PRODUCTS.includes(m.product)) throw failure('产品源码请选择打包器、主题中心或影视中心');
  if (m.kind === 'client-source' && m.engine === 'none') throw failure('源码包必须声明 Flutter 或 uni-app');
  if (!/^[^\x00-\x1f\\/]{1,160}\.(?:zip|exe|msi|apk|aab|ipa|dmg|tar\.gz|deb|AppImage)$/i.test(m.filename)) throw failure('安装包文件名或格式不支持');
  for (const key of ['installNotes','upgradeNotes','compatibility','sourceOrigin']) { m[key]=String(input[key] || '').trim(); if(m[key].length>5000) throw failure('版本说明过长'); }
  if(input.gitSource) {const g=input.gitSource;if(!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(g.repository||'')||!Number.isSafeInteger(g.assetId))throw failure('Git 来源无效');m.gitSource={repository:g.repository,assetId:g.assetId,tag:String(g.tag||'').slice(0,100)};}
  return m;
}
export function validatePackage(m, bytes) {
  if (bytes.length < 4) throw failure('上传文件为空或不完整');
  const lower = m.filename.toLowerCase();
  if (lower.endsWith('.exe') && bytes.subarray(0, 2).toString() !== 'MZ') throw failure('不是有效的 EXE 文件');
  if (lower.endsWith('.tar.gz') && !(bytes[0] === 31 && bytes[1] === 139)) throw failure('不是 gzip 归档');
  if (/\.(zip|apk|aab|ipa)$/.test(lower) && bytes.readUInt32LE(0) !== 0x04034b50) throw failure('不是 ZIP 格式包');
  if (!['client-source', 'product-source', 'theme'].includes(m.kind)) return {};
  if (!lower.endsWith('.zip')) throw failure('源码和主题必须使用 ZIP 包');
  const files = readZip(bytes);
  if ([...files.keys()].some(n => /(^|\/)(node_modules|\.git|\.env)(\/|$)/.test(n) || /\.(pem|jks|p12|key)$/i.test(n))) throw failure('包内含环境、Git 数据或私钥，请移除后上传');
  if (m.kind === 'product-source') { if (!files.size) throw failure('产品源码包不能为空'); return {files:files.size}; }
  if (m.kind === 'client-source') {
    const required = m.engine === 'flutter' ? ['pubspec.yaml', 'lib/main.dart'] : ['package.json', 'src/manifest.json', 'src/pages.json'];
    if (required.some(n => !files.has(n))) throw failure('源码根目录缺少：' + required.join('、'));
    return { files: files.size, renderer: m.engine };
  }
  const manifest = files.get('manifest.json');
  if (!manifest) throw failure('主题包根目录缺少 manifest.json');
  let value; try { value = JSON.parse(manifest.toString('utf8')); } catch { throw failure('主题清单不是有效 JSON'); }
  if (value.format !== 'hetun-skeleton' || ![2, 3].includes(value.version) || !['hetun-v2', 'hetun-flutter-v1'].includes(value.renderer) || !['mobile', 'tablet', 'tv', 'web', 'desktop'].includes(value.platform) || !/^[a-z0-9][a-z0-9-]{2,100}$/.test(value.id || '') || !value.theme || typeof value.theme !== 'object') throw failure('主题清单格式或渲染器不支持');
  return { files: files.size, renderer: value.renderer, themeId: value.id, device: value.platform };
}
export async function createRelease(store, input, bytes) {
  const m = metadata(input), info = validatePackage(m, bytes);
  if (store.state.releases.some(r => r.kind === m.kind && r.product === m.product && r.platform === m.platform && r.arch === m.arch && r.channel === m.channel && r.version === m.version)) throw failure('此产品、平台、渠道的版本已存在，请增加版本号', 409);
  const id = crypto.randomUUID(), file = id + '.bin';
  await fs.writeFile(path.join(store.root, 'files', file), bytes, { flag: 'wx', mode: 0o600 });
  const release = { id, ...m, ...info, file, bytes: bytes.length, sha256: sha(bytes), status: 'draft', createdAt: now() };
  store.state.releases.unshift(release); history(store,m.kind==='theme'?'templates':m.product,'上传版本草稿',id,m.name+' '+m.version); store.audit('上传版本草稿', id); await store.commit();
  return publicRelease(release);
}
export function updateManifest(store, product, current, platform, arch, channel, issuer, distribution) {
  if (!PRODUCTS.includes(product) || !VERSION.test(current || '') || !PLATFORMS.includes(platform) || !['any', 'x64', 'arm64'].includes(arch) || !['stable', 'beta'].includes(channel)) throw failure('更新检查参数无效');
  const versions = store.state.releases.filter(r => r.status === 'published' && ['software','installer'].includes(r.kind) && r.product === product && ['all', platform].includes(r.platform) && ['any', arch].includes(r.arch) && r.channel === channel && (!distribution || !distribution.managed.has(r.id) || distribution.releaseIds.has(r.id))).sort((a, b) => compareVersions(b.version, a.version));
  const latest = versions[0], push=latest && distribution?.pushes.find(x=>x.releaseId===latest.id);
  return sign(store, { schemaVersion: 1, issuer, product, currentVersion: current, checkedAt: now(), updateAvailable: !!latest && compareVersions(latest.version, current) > 0, force: !!latest && compareVersions(latest.version, current) > 0 && (latest.force || push?.force || compareVersions(current, latest.minVersion) < 0), pushId:push?.id || null, release: latest ? publicRelease(latest) : null });
}
export function createJob(store, b, owner = 'admin') {
  const source = store.state.releases.find(r => r.id === b.sourceId && r.kind === 'client-source' && r.status === 'published');
  const theme = store.state.releases.find(r => r.id === b.themeId && r.kind === 'theme' && r.status === 'published');
  if (!source || !theme) throw failure('请选择已发布的源码和主题');
  if ((source.engine === 'flutter' && theme.renderer !== 'hetun-flutter-v1') || (source.engine === 'uniapp' && theme.renderer !== 'hetun-v2')) throw failure('源码与主题渲染器不兼容');
  const target = String(b.target || '');
  if (!['android', 'ios', 'windows', 'web'].includes(target)) throw failure('构建目标无效');
  const devices = { android: ['mobile', 'tablet', 'tv'], ios: ['mobile', 'tablet'], windows: ['desktop', 'web'], web: ['web'] };
  if (!devices[target].includes(theme.device)) throw failure('主题设备类型与构建目标不兼容');
  const app = { name: String(b.name || '').trim(), packageId: String(b.packageId || ''), version: String(b.version || ''), backend: String(b.backend || ''), buildNumber: Number(b.buildNumber || 1) };
  if (!app.name || app.name.length > 60 || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*){2,}$/.test(app.packageId) || !VERSION.test(app.version) || !Number.isSafeInteger(app.buildNumber) || app.buildNumber < 1) throw failure('应用名称、包名或版本无效');
  let backend; try { backend = new URL(app.backend); } catch { throw failure('运营地址无效'); }
  if (backend.protocol !== 'https:' || backend.username || backend.password || backend.search || backend.hash) throw failure('运营地址必须是无凭据的 HTTPS 地址');
  const job = { id: crypto.randomUUID(), owner, sourceId: source.id, themeId: theme.id, engine: source.engine, target, app, status: 'queued', createdAt: now(), logs: ['已进入队列；等待匹配的构建节点。'] };
  store.state.jobs.unshift(job); store.audit('创建构建任务', job.id);
  return job;
}
