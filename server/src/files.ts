import { constants, createWriteStream } from 'node:fs';
import { access, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PassThrough, Transform, Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { create as createTar, extract as extractTar } from 'tar';
import { HttpError, MutationQueue, text } from './errors.js';
import { writeJson } from './store.js';

export interface Root { id: string; name: string; path: string; readOnly: boolean }
export const MAX_TEXT = 2 * 1024 * 1024;
export const MAX_UPLOAD = 5 * 1024 * 1024 * 1024;
export const MAX_EXTRACTED = 100 * 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 200_000;
const INTERNAL_FILE = /^\.mcp-(?:upload|save|archive|extract)-[a-f0-9-]+$/;
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const inside = (parent: string, child: string) => child === parent || (!path.relative(parent, child).startsWith(`..${path.sep}`) && path.relative(parent, child) !== '..' && !path.isAbsolute(path.relative(parent, child)));

export function relativePath(value: unknown): string {
  const result = text(value, '路径');
  if (path.posix.isAbsolute(result) || /^[a-zA-Z]:/.test(result) || result.includes('\\') || /[\u0000-\u001f\u007f]/.test(result) || result.split('/').includes('..')) {
    throw new HttpError(400, '路径必须位于接入目录内', 'INVALID_PATH');
  }
  const normalized = path.posix.normalize(result);
  return normalized === '.' ? '' : normalized.replace(/\/$/, '');
}

function name(value: unknown): string {
  const result = text(value, '名称', 255);
  if (!result || result === '.' || result === '..' || /[\\/\u0000-\u001f\u007f]/.test(result)) throw new HttpError(400, '文件名称不正确');
  return result;
}

async function mustNotExist(target: string) {
  try { await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new HttpError(409, '目标名称已存在，原文件已保留', 'ALREADY_EXISTS');
}

async function linkNoReplace(source: string, destination: string) {
  try { await link(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '目标名称已存在，原文件已保留', 'ALREADY_EXISTS');
    throw error;
  }
}

export class Files {
  private roots: Root[] = [];
  private config: string;
  readonly changes = new MutationQueue();
  private stopping = false;
  private streams = new Set<AbortController>();

  drain(): Promise<void> {
    this.stopping = true;
    for (const stream of this.streams) stream.abort();
    return this.changes.run(async () => undefined);
  }

  constructor(private dataDir: string, private protectedPaths: string[] = []) {
    this.config = path.join(dataDir, 'roots.json');
  }

  async initialize() {
    const canonical = async (value: string) => {
      try { return await realpath(value); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(value);
        throw error;
      }
    };
    this.dataDir = await canonical(this.dataDir);
    this.protectedPaths = await Promise.all(this.protectedPaths.map(canonical));
    try {
      const roots: unknown = JSON.parse(await readFile(this.config, 'utf8'));
      if (!Array.isArray(roots) || roots.some(root => !root || typeof root.id !== 'string' || typeof root.name !== 'string' || typeof root.path !== 'string' || !path.isAbsolute(root.path) || typeof root.readOnly !== 'boolean')) {
        throw new Error('目录配置损坏，请从备份恢复；不会自动重置目录');
      }
      this.roots = roots;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private root(id: unknown, write = false): Root {
    const root = this.roots.find(item => item.id === text(id, '目录编号', 128));
    if (!root) throw new HttpError(404, '接入目录不存在');
    if (write && root.readOnly) throw new HttpError(403, '这个目录仅允许读取', 'READ_ONLY');
    return root;
  }

  async listRoots() {
    return Promise.all(this.roots.map(async root => {
      try {
        await this.resolve(root.id, '');
        await access(root.path, constants.R_OK | constants.X_OK | (root.readOnly ? 0 : constants.W_OK));
        return { ...root, available: true };
      } catch {
        return { ...root, available: false, error: '目录不存在或权限不足，请检查飞牛应用的文件夹授权' };
      }
    }));
  }

  async addRoot(input: { name?: unknown; path?: unknown; readOnly?: unknown }) {
    return this.changes.run(async () => {
      const label = text(input.name, '目录名称', 64).trim();
      const requested = text(input.path, '目录路径');
      if (!label || !path.isAbsolute(requested) || typeof input.readOnly !== 'boolean') throw new HttpError(400, '请填写名称、绝对路径和访问方式');
      const absolute = await realpath(requested);
      const reserved = ['/', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/usr', '/proc', '/dev', '/sys', '/boot', '/root', '/var', '/home'];
      if (absolute === path.parse(absolute).root || reserved.slice(1).some(parent => inside(parent, absolute)) || [this.dataDir, ...this.protectedPaths].some(parent => inside(path.resolve(parent), absolute) || inside(absolute, path.resolve(parent)))) {
        throw new HttpError(403, '请选择独立的 Java 或服务端文件夹，系统和面板目录不能接入');
      }
      if (this.roots.some(root => inside(root.path, absolute) || inside(absolute, root.path))) throw new HttpError(409, '这个目录与已接入的目录重叠');
      if (!(await lstat(absolute)).isDirectory()) throw new HttpError(400, '请选择文件夹');
      await access(absolute, constants.R_OK | constants.X_OK | (input.readOnly ? 0 : constants.W_OK));
      const root = { id: randomUUID(), name: label, path: absolute, readOnly: input.readOnly };
      const next = [...this.roots, root];
      await writeJson(this.config, next);
      this.roots = next;
      return { ...root, available: true };
    });
  }

  async removeRoot(id: unknown) {
    return this.changes.run(async () => {
      const root = this.root(id);
      const next = this.roots.filter(item => item.id !== root.id);
      await writeJson(this.config, next);
      this.roots = next;
    });
  }

  async resolve(id: unknown, input: unknown, write = false, allowMissing = false): Promise<string> {
    const root = this.root(id, write);
    const relative = relativePath(input);
    const anchor = await lstat(root.path);
    if (anchor.isSymbolicLink() || !anchor.isDirectory() || await realpath(root.path) !== root.path) throw new HttpError(403, '接入目录已发生变化，请重新接入');
    let target = root.path;
    const parts = relative ? relative.split('/') : [];
    for (let i = 0; i < parts.length; i++) {
      target = path.join(target, parts[i]);
      try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink()) throw new HttpError(403, '为避免越界，符号链接不能用于文件操作', 'SYMLINK');
        if (i < parts.length - 1 && !stat.isDirectory()) throw new HttpError(400, '上级路径不是文件夹');
      } catch (error) {
        if (allowMissing && i === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return target;
        throw error;
      }
    }
    if (!inside(root.path, target)) throw new HttpError(403, '路径超出接入目录');
    return target;
  }

  async list(id: unknown, input: unknown) {
    const relative = relativePath(input);
    const target = await this.resolve(id, relative);
    if (!(await lstat(target)).isDirectory()) throw new HttpError(400, '当前路径不是文件夹');
    // ponytail: one directory in memory; paginate when folders contain tens of thousands of entries.
    const children = await readdir(target, { withFileTypes: true });
    const entries = [];
    // Sequential metadata reads keep large NAS directories from exhausting file descriptors.
    for (const child of children) {
      if (INTERNAL_FILE.test(child.name)) continue;
      try {
        const stat = await lstat(path.join(target, child.name));
        entries.push({ name: child.name, path: path.posix.join(relative, child.name), type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, modified: stat.mtime.toISOString(), permissions: (stat.mode & 0o777).toString(8).padStart(3, '0') });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    entries.sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return { path: relative, entries };
  }

  async openFile(id: unknown, input: unknown) {
    const target = await this.resolve(id, input);
    const metadata = await lstat(target);
    if (!metadata.isFile()) throw new HttpError(400, '请选择普通文件');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new HttpError(400, '请选择普通文件');
      return { handle, stat, target };
    } catch (error) { await handle.close(); throw error; }
  }

  private async bytes(id: unknown, input: unknown) {
    const { handle, stat } = await this.openFile(id, input);
    try {
      if (stat.size > MAX_TEXT) throw new HttpError(413, '在线编辑仅支持不超过 2 MiB 的文本文件');
      const buffer = Buffer.alloc(MAX_TEXT + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > MAX_TEXT) throw new HttpError(413, '在线编辑仅支持不超过 2 MiB 的文本文件');
      return { bytes: buffer.subarray(0, count), mode: stat.mode & 0o777 };
    } finally { await handle.close(); }
  }

  async readText(id: unknown, input: unknown) {
    const { bytes } = await this.bytes(id, input);
    if (bytes.includes(0)) throw new HttpError(415, '二进制文件不能在线编辑，请下载后处理');
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new HttpError(415, '这个文件不是 UTF-8 文本，请下载后处理'); }
    return { content, revision: revision(bytes) };
  }

  async saveText(id: unknown, input: unknown, content: unknown, expected: unknown) {
    return this.changes.run(async () => {
      const target = await this.resolve(id, input, true);
      const source = text(content, '文件内容', MAX_TEXT);
      if (Buffer.byteLength(source, 'utf8') > MAX_TEXT) throw new HttpError(413, '文本内容超过 2 MiB');
      if (source.includes('\0')) throw new HttpError(415, '不能保存二进制内容');
      const version = text(expected, '文件版本', 64);
      const original = await this.bytes(id, input);
      if (revision(original.bytes) !== version) throw new HttpError(409, '文件已被其他程序修改，请重新载入后再保存', 'EDIT_CONFLICT');
      await access(target, constants.W_OK);
      const temporary = path.join(path.dirname(target), `.mcp-save-${randomUUID()}`);
      try {
        const handle = await open(temporary, 'wx', original.mode);
        try { await handle.writeFile(source, 'utf8'); await handle.chmod(original.mode); await handle.sync(); } finally { await handle.close(); }
        await this.resolve(id, input, true);
        if (revision((await this.bytes(id, input)).bytes) !== version) throw new HttpError(409, '文件已被其他程序修改，请重新载入后再保存', 'EDIT_CONFLICT');
        await rename(temporary, target);
        return { revision: revision(Buffer.from(source, 'utf8')) };
      } finally { await rm(temporary, { force: true }); }
    });
  }

  async create(id: unknown, input: unknown, type: unknown) {
    return this.changes.run(async () => {
      const relative = relativePath(input);
      if (!relative) throw new HttpError(400, '不能创建或覆盖接入目录本身');
      const target = await this.resolve(id, relative, true, true);
      await mustNotExist(target);
      if (type === 'directory') await mkdir(target);
      else if (type === 'file') { const handle = await open(target, 'wx', 0o666); await handle.close(); }
      else throw new HttpError(400, '创建类型不正确');
    });
  }

  async rename(id: unknown, input: unknown, newName: unknown) {
    return this.changes.run(async () => {
      const relative = relativePath(input);
      if (!relative) throw new HttpError(400, '不能重命名接入目录');
      const source = await this.resolve(id, relative, true);
      const destination = await this.resolve(id, path.posix.join(path.posix.dirname(relative), name(newName)), true, true);
      if (source === destination) return;
      await mustNotExist(destination);
      throw new HttpError(409, '无法安全地自动重命名；请复制、核对内容，再手动删除原项目', 'MOVE_UNSAFE');
    });
  }

  private async selected(id: unknown, inputs: string[], write: boolean) {
    const items = [...new Set(inputs.map(relativePath))];
    if (items.some(item => !item)) throw new HttpError(400, '不能操作接入目录本身');
    for (const item of items) await this.resolve(id, item, write);
    return items.filter(item => !items.some(other => other !== item && item.startsWith(`${other}/`)));
  }

  async delete(id: unknown, inputs: string[]) {
    return this.changes.run(async () => {
      const items = await this.selected(id, inputs, true);
      for (const item of items) await rm(await this.resolve(id, item, true), { recursive: true, force: false });
    });
  }

  private async checkTree(target: string): Promise<void> {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HttpError(403, '所选目录包含符号链接或特殊文件，不能继续操作');
    if (stat.isDirectory()) for (const entry of await readdir(target)) await this.checkTree(path.join(target, entry));
  }

  private async publishExtracted(id: unknown, source: string, relative: string): Promise<void> {
    const stat = await lstat(source);
    const destination = await this.resolve(id, relative, true, true);
    if (stat.isDirectory()) {
      await mkdir(destination);
      for (const entry of await readdir(source)) {
        await this.publishExtracted(id, path.join(source, entry), path.posix.join(relative, entry));
      }
    } else if (stat.isFile()) {
      await linkNoReplace(source, destination);
    } else throw new HttpError(400, '暂存目录包含链接或特殊文件，已停止解压');
  }

  async transfer(sourceId: unknown, inputs: string[], targetId: unknown, targetInput: unknown, operation: unknown) {
    return this.changes.run(async () => {
      if (operation === 'move') throw new HttpError(409, '无法安全地自动移动；请复制、核对内容，再手动删除原项目', 'MOVE_UNSAFE');
      if (operation !== 'copy') throw new HttpError(400, '操作类型不正确');
      const items = await this.selected(sourceId, inputs, false);
      const directory = await this.resolve(targetId, targetInput, true);
      if (!(await lstat(directory)).isDirectory()) throw new HttpError(400, '目标不是文件夹');
      const plans = [];
      for (const item of items) {
        const source = await this.resolve(sourceId, item);
        const destination = await this.resolve(targetId, path.posix.join(relativePath(targetInput), path.posix.basename(item)), true, true);
        if (inside(source, destination)) throw new HttpError(400, '不能把目录复制到自身内部');
        await mustNotExist(destination);
        await this.checkTree(source);
        plans.push({ source, destination });
      }
      if (new Set(plans.map(plan => plan.destination)).size !== plans.length) throw new HttpError(409, '所选项目存在同名目标');
      for (const { source, destination } of plans) {
        await cp(source, destination, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL, dereference: false, filter: async item => { await this.checkTreeEntry(item); return true; } });
      }
    });
  }

  private async checkTreeEntry(item: string) {
    const stat = await lstat(item);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new HttpError(403, '目录内容已变化，操作已停止；请检查所选目录');
  }

  private tarStream(root: Root, items: string[]) {
    return createTar({
      cwd: root.path,
      portable: true,
      follow: false,
      strict: true,
      filter: (_entryPath, stat) => {
        const type = 'type' in stat ? stat.type : stat.isFile() ? 'File' : stat.isDirectory() ? 'Directory' : '';
        if (type !== 'File' && type !== 'Directory') throw new HttpError(403, '所选目录包含符号链接或特殊文件，不能压缩');
        return true;
      },
    }, items);
  }

  async createArchive(id: unknown, inputs: string[], targetInput: unknown) {
    return this.changes.run(async () => {
      if (this.stopping) throw new HttpError(503, '面板正在停止，压缩未开始');
      const root = this.root(id, true);
      const items = await this.selected(id, inputs, false);
      const targetRelative = relativePath(targetInput);
      if (!targetRelative || !targetRelative.toLocaleLowerCase('en-US').endsWith('.tar.gz')) {
        throw new HttpError(400, '压缩文件名必须以 .tar.gz 结尾');
      }
      const target = await this.resolve(id, targetRelative, true, true);
      await mustNotExist(target);
      for (const item of items) {
        const source = await this.resolve(id, item);
        if (inside(source, target)) throw new HttpError(400, '压缩文件不能保存在所选目录内部');
        await this.checkTree(source);
      }
      const temporary = path.join(path.dirname(target), `.mcp-archive-${randomUUID()}`);
      const controller = new AbortController();
      this.streams.add(controller);
      if (this.stopping) controller.abort();
      try {
        await pipeline(this.tarStream(root, items), createGzip(), createWriteStream(temporary, { flags: 'wx', mode: 0o666 }), { signal: controller.signal });
        const handle = await open(temporary, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await this.resolve(id, targetRelative, true, true);
        await linkNoReplace(temporary, target);
        return { path: targetRelative };
      } finally {
        this.streams.delete(controller);
        await rm(temporary, { force: true });
      }
    });
  }

  async archiveDownload(id: unknown, input: unknown) {
    if (this.stopping) throw new HttpError(503, '面板正在停止，下载未开始');
    const root = this.root(id);
    const [item] = await this.selected(id, [text(input, '文件路径')], false);
    await this.checkTree(await this.resolve(id, item));
    const stream = new PassThrough();
    const controller = new AbortController();
    this.streams.add(controller);
    if (this.stopping) controller.abort();
    void pipeline(this.tarStream(root, [item]), createGzip(), stream, { signal: controller.signal }).catch(error => {
      if (!controller.signal.aborted) stream.destroy(error as Error);
    });
    let released = false;
    return {
      name: `${path.posix.basename(item)}.tar.gz`,
      stream,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        controller.abort();
        this.streams.delete(controller);
      },
    };
  }

  async extractArchive(id: unknown, input: unknown, targetInput: unknown) {
    return this.changes.run(async () => {
      if (this.stopping) throw new HttpError(503, '面板正在停止，解压未开始');
      const sourceRelative = relativePath(input);
      if (!/\.(?:tar|tar\.gz|tgz)$/i.test(sourceRelative)) throw new HttpError(400, '仅支持解压 .tar、.tar.gz 和 .tgz 文件');
      const targetRelative = relativePath(targetInput);
      const target = await this.resolve(id, targetRelative, true);
      if (!(await lstat(target)).isDirectory()) throw new HttpError(400, '解压目标不是文件夹');
      const staging = path.join(target, `.mcp-extract-${randomUUID()}`);
      await mkdir(staging, { mode: 0o700 });
      const seen = new Map<string, string>();
      const requiredDirectories = new Set<string>();
      let entries = 0;
      let expanded = 0;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      const controller = new AbortController();
      this.streams.add(controller);
      if (this.stopping) controller.abort();
      try {
        handle = (await this.openFile(id, sourceRelative)).handle;
        const extractor = extractTar({
          cwd: staging,
          strict: true,
          preservePaths: false,
          preserveOwner: false,
          noChmod: true,
          filter: (entryPath, entry) => {
            entries++;
            if (entries > MAX_ARCHIVE_ENTRIES) throw new HttpError(413, '压缩包超过 200000 个条目或解压后 100 GiB 限制');
            const normalized = relativePath(entryPath);
            if (!normalized) return false;
            if (normalized.split('/').some(part => INTERNAL_FILE.test(part))) throw new HttpError(400, '压缩包包含面板保留名称');
            if (!('type' in entry)) throw new HttpError(400, '压缩包条目类型不正确，已停止解压');
            const entryType = entry.type;
            if (entryType !== 'File' && entryType !== 'OldFile' && entryType !== 'Directory') {
              throw new HttpError(400, '压缩包包含链接或特殊文件，已停止解压');
            }
            if (seen.has(normalized)) throw new HttpError(400, '压缩包包含重复路径，已停止解压');
            const parts = normalized.split('/');
            let parent = '';
            for (const part of parts.slice(0, -1)) {
              parent = path.posix.join(parent, part);
              if (seen.get(parent) && seen.get(parent) !== 'Directory') {
                throw new HttpError(400, '压缩包中的文件与目录路径冲突，已停止解压');
              }
              requiredDirectories.add(parent);
            }
            if (entryType !== 'Directory' && requiredDirectories.has(normalized)) {
              throw new HttpError(400, '压缩包中的文件与目录路径冲突，已停止解压');
            }
            const size = Number(entry.size ?? 0);
            if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, '压缩包条目大小不正确');
            expanded += size;
            if (expanded > MAX_EXTRACTED) {
              throw new HttpError(413, '压缩包超过 200000 个条目或解压后 100 GiB 限制');
            }
            seen.set(normalized, entryType);
            return true;
          },
        });
        let aborting = false;
        const input = new Writable({
          write: (chunk, _encoding, callback) => {
            try {
              if (extractor.write(chunk)) callback();
              else extractor.once('drain', callback);
            } catch (error) { callback(error as Error); }
          },
          final: callback => {
            extractor.once('close', callback);
            extractor.end();
          },
          destroy: (error, callback) => {
            if (error && !aborting) {
              aborting = true;
              try { extractor.abort(error); } catch { /* The stream error is reported by the pipeline. */ }
            }
            callback(error);
          },
        });
        extractor.on('error', error => input.destroy(error));
        await pipeline(handle.createReadStream({ autoClose: false }), input, { signal: controller.signal });
        await this.checkTree(staging);
        const topLevel = await readdir(staging);
        const plans = [];
        for (const entry of topLevel) {
          if (INTERNAL_FILE.test(entry)) throw new HttpError(400, '压缩包包含面板保留名称');
          const relative = path.posix.join(targetRelative, entry);
          await mustNotExist(await this.resolve(id, relative, true, true));
          plans.push({ source: path.join(staging, entry), relative });
        }
        // Publish each entry exclusively. If a later conflict occurs, keep earlier published data.
        for (const plan of plans) await this.publishExtracted(id, plan.source, plan.relative);
        return { entries: plans.length };
      } finally {
        this.streams.delete(controller);
        await handle?.close().catch(() => undefined);
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  private async ensureUploadParents(id: unknown, relative: string) {
    const parent = path.posix.dirname(relative);
    if (parent === '.') return;
    let current = '';
    for (const segment of parent.split('/')) {
      current = path.posix.join(current, segment);
      const target = await this.resolve(id, current, true, true);
      try {
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HttpError(400, '上传路径中的上级项目不是文件夹');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await mkdir(target); }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
        const stat = await lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HttpError(400, '上传路径中的上级项目不是文件夹');
      }
    }
  }

  async upload(id: unknown, input: unknown, stream: Readable, size?: number, createParents = false) {
    return this.changes.run(async () => {
      if (this.stopping) throw new HttpError(503, '面板正在停止，上传未开始');
      const relative = relativePath(input);
      if (!relative) throw new HttpError(400, '请选择上传文件名');
      if (size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD)) throw new HttpError(413, '单个上传文件不能超过 5 GiB');
      if (createParents) await this.ensureUploadParents(id, relative);
      const target = await this.resolve(id, relative, true, true);
      await mustNotExist(target);
      const temporary = path.join(path.dirname(target), `.mcp-upload-${randomUUID()}`);
      let received = 0;
      const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        callback(received > MAX_UPLOAD ? new HttpError(413, '单个上传文件不能超过 5 GiB') : null, chunk);
      } });
      const controller = new AbortController();
      this.streams.add(controller);
      if (this.stopping) controller.abort();
      try {
        await pipeline(stream, limiter, createWriteStream(temporary, { flags: 'wx', mode: 0o666 }), { signal: controller.signal });
        if (size !== undefined && received !== size) throw new HttpError(400, '上传内容不完整，原文件已保留');
        const handle = await open(temporary, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        await this.resolve(id, relative, true, true);
        // Linking in the destination directory publishes atomically without replacing a file.
        await linkNoReplace(temporary, target);
      } finally {
        this.streams.delete(controller);
        await rm(temporary, { force: true });
      }
    });
  }
}
