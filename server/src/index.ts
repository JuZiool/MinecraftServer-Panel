import express, { type ErrorRequestHandler } from 'express';
import { createServer } from 'node:http';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Auth } from './auth.js';
import { Files } from './files.js';
import { HttpError, paths } from './errors.js';

export interface AppOptions { dataDir: string; publicDir?: string; protectedPaths?: string[] }

export async function createApp(options: AppOptions) {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
  const auth = new Auth(options.dataDir);
  const files = new Files(options.dataDir, options.protectedPaths);
  await auth.initialize();
  await files.initialize();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(express.json({ limit: '12mb' }));
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/auth/status', (req, res) => { res.json(auth.status(req)); });
  app.post('/api/auth/setup', async (req, res) => { res.status(201).json(await auth.setup(req, res)); });
  app.post('/api/auth/login', async (req, res) => { res.json(await auth.login(req, res)); });
  app.post('/api/auth/logout', (req, res) => { res.json(auth.logout(req, res)); });
  app.use('/api', (req, _res, next) => { auth.require(req); next(); });

  app.get('/api/roots', async (_req, res) => { res.json({ roots: await files.listRoots() }); });
  app.post('/api/roots', async (req, res) => { res.status(201).json({ root: await files.addRoot(req.body ?? {}) }); });
  app.delete('/api/roots/:id', async (req, res) => { await files.removeRoot(req.params.id); res.json({ ok: true }); });
  app.get('/api/files/list', async (req, res) => { res.json(await files.list(req.query.rootId, req.query.path ?? '')); });
  app.get('/api/files/read', async (req, res) => { res.json(await files.readText(req.query.rootId, req.query.path)); });
  app.put('/api/files/content', async (req, res) => {
    const body = req.body ?? {};
    res.json(await files.saveText(body.rootId, body.path, body.content, body.revision));
  });
  app.post('/api/files/create', async (req, res) => {
    const body = req.body ?? {};
    await files.create(body.rootId, body.path, body.type);
    res.status(201).json({ ok: true });
  });
  app.post('/api/files/rename', async (req, res) => {
    const body = req.body ?? {};
    await files.rename(body.rootId, body.path, body.name);
    res.json({ ok: true });
  });
  app.post('/api/files/transfer', async (req, res) => {
    const body = req.body ?? {};
    await files.transfer(body.sourceRootId, paths(body.paths), body.targetRootId, body.targetPath, body.operation);
    res.json({ ok: true });
  });
  app.delete('/api/files', async (req, res) => {
    const body = req.body ?? {};
    await files.delete(body.rootId, paths(body.paths));
    res.json({ ok: true });
  });
  app.put('/api/files/upload', async (req, res) => {
    if (!req.is('application/octet-stream')) throw new HttpError(415, '上传需要原始文件数据');
    const length = req.get('content-length');
    await files.upload(req.query.rootId, req.query.path, req, length === undefined ? undefined : Number(length), req.query.parents === '1');
    res.status(201).json({ ok: true });
  });
  app.post('/api/files/archive', async (req, res) => {
    const body = req.body ?? {};
    res.status(201).json(await files.createArchive(body.rootId, paths(body.paths), body.destination));
  });
  app.post('/api/files/extract', async (req, res) => {
    const body = req.body ?? {};
    res.json(await files.extractArchive(body.rootId, body.path, body.targetPath));
  });
  app.get('/api/files/archive-download', async (req, res, next) => {
    const archive = await files.archiveDownload(req.query.rootId, req.query.path);
    try {
      res.attachment(archive.name);
      res.type('application/gzip');
      await pipeline(archive.stream, res, { signal: archive.signal });
    } catch (error) { if (!res.destroyed) next(error); }
    finally { archive.release(); }
  });
  app.get('/api/files/download', async (req, res, next) => {
    const { handle, stat, target } = await files.openFile(req.query.rootId, req.query.path);
    try {
      res.attachment(path.basename(target));
      res.set('Content-Length', String(stat.size));
      await pipeline(handle.createReadStream({ autoClose: false }), res);
    } catch (error) { if (!res.destroyed) next(error); }
    finally { await handle.close().catch(() => undefined); }
  });
  app.use('/api', () => { throw new HttpError(404, '接口不存在'); });

  if (options.publicDir) {
    const publicDir = options.publicDir;
    await access(path.join(publicDir, 'index.html'));
    app.use(express.static(publicDir, { dotfiles: 'deny', index: false }));
    app.get('/{*path}', (_req, res) => { res.sendFile(path.join(publicDir, 'index.html')); });
  }
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    const native = error as NodeJS.ErrnoException & { status?: number; type?: string };
    const errors: Record<string, [number, string]> = {
      ENOENT: [404, '文件或目录不存在，请刷新列表'],
      EACCES: [403, '没有操作权限，请检查飞牛应用的文件夹授权'],
      EPERM: [403, '没有操作权限，请检查飞牛应用的文件夹授权'],
      EEXIST: [409, '目标名称已存在，原文件已保留'],
      ENOTDIR: [400, '上级路径不是文件夹'],
      EISDIR: [400, '请选择普通文件'],
      ENOTEMPTY: [409, '目标目录已有内容，操作已停止'],
      ENOSPC: [507, '存储空间不足，操作已停止'],
      ELOOP: [403, '符号链接不能用于文件操作']
    };
    if (native.type === 'entity.parse.failed') { res.status(400).json({ error: '请求不是有效 JSON' }); return; }
    if (native.type === 'entity.too.large') { res.status(413).json({ error: '请求内容过大' }); return; }
    const known = native.code ? errors[native.code] : undefined;
    if (known) { res.status(known[0]).json({ error: known[1], code: native.code }); return; }
    console.error('Request failed:', error);
    res.status(500).json({ error: '操作失败，请刷新列表确认当前状态；已有文件不会自动回滚' });
  };
  app.use(errorHandler);
  return { app, files, auth };
}

async function main() {
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const dataDir = path.resolve(process.env.PANEL_DATA_DIR ?? path.join(projectDir, '.data'));
  const publicDir = path.resolve(process.env.PANEL_PUBLIC_DIR ?? path.join(projectDir, 'client/dist'));
  const portString = process.env.SERVER_PORT ?? '4560';
  if (!/^\d+$/.test(portString) || Number(portString) < 1 || Number(portString) > 65535) throw new Error('SERVER_PORT 必须是 1 至 65535 的整数');
  const port = Number(portString);
  const { app, files, auth } = await createApp({ dataDir, publicDir, protectedPaths: [projectDir] });
  const server = createServer(app);
  server.requestTimeout = 60 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  server.listen(port, process.env.PANEL_HOST ?? '0.0.0.0', () => { console.log(`Minecraft Server Panel listening on port ${port}`); });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { console.error('Shutdown timed out'); process.exit(1); }, 30_000);
    const closed = new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    void Promise.all([closed, files.drain(), auth.drain()]).then(async () => {
      await Promise.all([files.drain(), auth.drain()]);
      clearTimeout(deadline);
      process.exit(0);
    }).catch(error => {
      console.error('Shutdown failed:', error);
      clearTimeout(deadline);
      process.exit(1);
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
