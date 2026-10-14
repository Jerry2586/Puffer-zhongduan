import net from 'node:net';
import crypto from 'node:crypto';

const owned = new Set();

// OS-owned listener: a crash releases ownership without a stale lock file.
export async function acquireInstance(root) {
  const hash = crypto.createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest();
  const identity = hash.toString('hex');
  if (owned.has(identity)) throw Error('运行目录已有终端实例；禁止并发写入');
  owned.add(identity);
  const address = process.platform === 'win32'
    ? { path: '\\\\.\\pipe\\puffer-terminal-' + hash.toString('hex') }
    : { host: '127.0.0.1', port: 16000 + hash.readUInt16BE(0) % 48000, exclusive: true };
  const guard = net.createServer(socket => socket.destroy());
  try { await new Promise((resolve, reject) => {
    const failed = error => { guard.close(); reject(Object.assign(new Error(error.code === 'EADDRINUSE' ? '运行目录已有终端实例，或实例保护地址被占用；禁止并发写入，请检查现有进程' : '无法建立终端实例保护：' + error.code), { cause: error })); };
    guard.once('error', failed);
    guard.listen(address, () => { guard.removeListener('error', failed); resolve(); });
  }); } catch (error) { owned.delete(identity); throw error; }
  guard.unref();
  let closing;
  return () => closing ||= new Promise(resolve => guard.close(() => { owned.delete(identity); resolve(); }));
}
