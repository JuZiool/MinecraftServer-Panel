import { mkdir, mkdtemp, cp, writeFile, readFile, readdir, chmod, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { deflateSync, inflateSync } from 'node:zlib';
import assert from 'node:assert/strict';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(project, 'artifacts');
const fpk = process.argv.includes('--fpk');
const fnpackUrl = process.env.FNPACK_URL ?? '';
const fnpackHash = process.env.FNPACK_SHA256 ?? '';
if (process.platform !== 'linux' || process.arch !== 'x64' || !process.version.startsWith('v24.')) {
  throw new Error('Native packaging must run on Linux x64 with Node 24 in GitHub Actions');
}
if (fpk) {
  if (!fnpackUrl.startsWith('https://') || !/^[a-fA-F0-9]{64}$/.test(fnpackHash)) throw new Error('Set a pinned official FNPACK_URL and FNPACK_SHA256 repository variable');
  const resource = JSON.parse(await readFile(path.join(project, 'fpk/config/resource'), 'utf8'));
  if (Object.keys(resource).length === 0) throw new Error('FPK folder-authorization schema is still missing. Verify the official resource declaration before building an installable FPK. See fpk/README.md.');
}

function run(command, args, cwd = project) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
}

async function download(url, destination, limit = 128 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > limit) { callback(new Error('Download exceeded the size limit')); return; }
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx' }));
  return hash.digest('hex');
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const kind = Buffer.from(type);
  const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([kind, bytes])));
  return Buffer.concat([length, kind, bytes, crc]);
}
function icon(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size; const v = y / size;
    const folder = (u > 0.2 && u < 0.8 && v > 0.4 && v < 0.7) || (u > 0.23 && u < 0.48 && v > 0.31 && v <= 0.4);
    const color = folder ? [224, 251, 241, 255] : [14, 92, 72, 255];
    const at = y * (size * 4 + 1) + 1 + x * 4;
    raw.set(color, at);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const compressed = deflateSync(raw);
  assert.deepEqual(inflateSync(compressed), raw);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}
assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);

await mkdir(artifacts, { recursive: true });
const stage = await mkdtemp(path.join(artifacts, 'stage-'));
await cp(path.join(project, 'fpk'), stage, { recursive: true });
const app = path.join(stage, 'app');
await mkdir(path.join(app, 'server'), { recursive: true });
await mkdir(path.join(app, 'client'), { recursive: true });
await cp(path.join(project, 'server/dist'), path.join(app, 'server/dist'), { recursive: true });
await copyFile(path.join(project, 'server/package.json'), path.join(app, 'server/package.json'));
await cp(path.join(project, 'client/dist'), path.join(app, 'client/dist'), { recursive: true });
run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(app, 'server'));

// Bundle the exact Node patch used by this cloud build and verify its official digest.
const version = process.version;
const archiveName = `node-${version}-linux-x64.tar.xz`;
const archivePath = path.join(artifacts, archiveName);
const base = `https://nodejs.org/dist/${version}/`;
const checksums = await fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(30_000) });
if (!checksums.ok) throw new Error('Cannot retrieve the official Node checksum list');
const expected = (await checksums.text()).split('\n').map(line => line.trim().split(/\s+/)).find(parts => parts[1] === archiveName)?.[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw new Error('Official Node digest not found');
const actual = await download(base + archiveName, archivePath);
if (actual !== expected) throw new Error('Bundled Node checksum mismatch');
const unpacked = await mkdtemp(path.join(artifacts, 'node-'));
run('tar', ['-xJf', archivePath, '-C', unpacked]);
const nodeRoot = path.join(unpacked, `node-${version}-linux-x64`);
await mkdir(path.join(app, 'node/bin'), { recursive: true });
await copyFile(path.join(nodeRoot, 'bin/node'), path.join(app, 'node/bin/node'));
await copyFile(path.join(nodeRoot, 'LICENSE'), path.join(app, 'node/LICENSE'));
await chmod(path.join(app, 'node/bin/node'), 0o755);
await chmod(path.join(stage, 'cmd/main'), 0o755);
await mkdir(path.join(app, 'ui/images'), { recursive: true });
for (const size of [64, 256]) {
  const bytes = icon(size);
  await writeFile(path.join(stage, size === 64 ? 'ICON.PNG' : 'ICON_256.PNG'), bytes);
  await writeFile(path.join(app, `ui/images/icon-${size}.png`), bytes);
}
await writeFile(path.join(artifacts, 'build-info.json'), JSON.stringify({ version: JSON.parse(await readFile(path.join(project, 'package.json'), 'utf8')).version, node: version, nodeSha256: actual, platform: 'linux-x64', fpkRequested: fpk }, null, 2) + '\n');

// Exercise the bundled runtime and lifecycle on the Linux runner, never on the developer PC.
const smokeData = await mkdtemp(path.join(artifacts, 'smoke-data-'));
const control = path.join(stage, 'cmd/main');
const env = { ...process.env, PANEL_APP_DIR: app, PANEL_DATA_DIR: smokeData, SERVER_PORT: '4560' };
const lifecycle = action => {
  const result = spawnSync('sh', [control, action], { cwd: project, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Lifecycle ${action} failed with exit ${result.status}`);
};
try {
  lifecycle('start');
  lifecycle('start');
  lifecycle('status');
  lifecycle('restart');
  const health = await fetch('http://127.0.0.1:4560/api/health');
  assert.equal(health.status, 200);
  const page = await fetch('http://127.0.0.1:4560/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
} finally { lifecycle('stop'); }
const stopped = spawnSync('sh', [control, 'status'], { env, stdio: 'inherit' });
assert.equal(stopped.status, 3);

run('tar', ['-czf', path.join(artifacts, 'native-preview-linux-x64.tar.gz'), '-C', stage, '.']);
if (fpk) {
  const tool = path.join(artifacts, 'fnpack');
  if ((await download(fnpackUrl, tool, 64 * 1024 * 1024)).toLowerCase() !== fnpackHash.toLowerCase()) throw new Error('fnpack checksum mismatch');
  await chmod(tool, 0o755);
  run(tool, ['--help'], stage);
  run(tool, ['build', '--help'], stage);
  run(tool, ['build'], stage);
  const candidates = (await readdir(stage)).filter(file => file.endsWith('.fpk'));
  if (!candidates.length) throw new Error('fnpack did not produce an FPK in the staging directory; verify its CLI and configuration');
  for (const file of candidates) await copyFile(path.join(stage, file), path.join(artifacts, file));
}
console.log(fpk ? 'Cloud build produced FPK artifacts; fnOS device validation is still required.' : 'Cloud build produced a native preview; FPK schema remains pending verification.');
