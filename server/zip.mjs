import { inflateRawSync } from 'node:zlib';
import { failure } from './store.mjs';
export function crc32(buffer) {
  let c = 0xffffffff;
  for (const x of buffer) { c ^= x; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
export function readZip(buffer) {
  if (buffer.length < 22) throw failure('ZIP 文件不完整');
  let e = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { e = i; break; }
  }
  if (e < 0) throw failure('ZIP 文件损坏');
  const count = buffer.readUInt16LE(e + 10), offset = buffer.readUInt32LE(e + 16), centralSize = buffer.readUInt32LE(e + 12);
  if (!count || count > 5000 || buffer.readUInt16LE(e + 4) || buffer.readUInt16LE(e + 6) || buffer.readUInt16LE(e + 8) !== count || offset + centralSize !== e) throw failure('不支持分卷、ZIP64 或超量文件');
  let p = offset, total = 0;
  const files = new Map(), seen = new Set(), ranges = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > e || buffer.readUInt32LE(p) !== 0x02014b50) throw failure('ZIP 目录损坏');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10), crc = buffer.readUInt32LE(p + 16), size = buffer.readUInt32LE(p + 20), plain = buffer.readUInt32LE(p + 24), nl = buffer.readUInt16LE(p + 28), ex = buffer.readUInt16LE(p + 30), co = buffer.readUInt16LE(p + 32), local = buffer.readUInt32LE(p + 42), mode = buffer.readUInt32LE(p + 38) >>> 16;
    if (p + 46 + nl + ex + co > e) throw failure('ZIP 路径越界');
    const n = buffer.subarray(p + 46, p + 46 + nl).toString('utf8'); p += 46 + nl + ex + co;
    if (!n || n.length > 240 || /[\x00-\x1f\x7f\\:]/.test(n) || n.startsWith('/') || n.split('/').some(x => x === '..' || x === '.') || seen.has(n.toLowerCase()) || (mode & 0xf000) === 0xa000 || flags & 1 || ![0, 8].includes(method) || plain > 32 * 1024 * 1024) throw failure('ZIP 含不安全路径、链接或不支持内容');
    seen.add(n.toLowerCase()); total += plain;
    if (total > 128 * 1024 * 1024 || local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50) throw failure('ZIP 大小或文件头无效');
    const ln = buffer.readUInt16LE(local + 26), le = buffer.readUInt16LE(local + 28), begin = local + 30 + ln + le;
    if (begin + size > offset || buffer.subarray(local + 30, local + 30 + ln).toString('utf8') !== n || buffer.readUInt16LE(local + 8) !== method || ranges.some(([a, z]) => local < z && begin + size > a)) throw failure('ZIP 路径或文件区间不一致');
    ranges.push([local, begin + size]);
    let out;
    try { out = method === 8 ? inflateRawSync(buffer.subarray(begin, begin + size), { maxOutputLength: Math.min(plain + 1, 32 * 1024 * 1024 + 1) }) : buffer.subarray(begin, begin + size); }
    catch { throw failure('ZIP 解压失败'); }
    if (out.length !== plain || crc32(out) !== crc) throw failure('ZIP CRC 校验失败');
    if (!n.endsWith('/')) files.set(n, out);
  }
  if (p !== e) throw failure('ZIP 目录长度不符');
  return files;
}
export function makeZip(entries) {
  const locals = [], central = []; let offset = 0;
  for (const [name, content] of entries) {
    const b = Buffer.from(content), n = Buffer.from(name), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt32LE(crc32(b), 14); h.writeUInt32LE(b.length, 18); h.writeUInt32LE(b.length, 22); h.writeUInt16LE(n.length, 26);
    locals.push(h, n, b); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt32LE(crc32(b), 16); c.writeUInt32LE(b.length, 20); c.writeUInt32LE(b.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42); central.push(c, n); offset += h.length + n.length + b.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
