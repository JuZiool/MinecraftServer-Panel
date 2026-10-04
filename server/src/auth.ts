import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { HttpError, MutationQueue, text } from './errors.js';
import { writeJson } from './store.js';

interface Admin { username: string; salt: string; hash: string }
interface Session { username: string; csrfToken: string; expires: number }
const SESSION_MS = 12 * 60 * 60 * 1000;

function hashPassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  });
}

export class Auth {
  private admin?: Admin;
  private sessions = new Map<string, Session>();
  private failures = new Map<string, { count: number; expires: number }>();
  private changes = new MutationQueue();
  private file: string;

  constructor(dataDir: string) { this.file = path.join(dataDir, 'admin.json'); }

  async initialize() {
    try {
      const admin: Admin = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof admin.username !== 'string' || !/^[a-f0-9]{32}$/.test(admin.salt) || !/^[a-f0-9]{128}$/.test(admin.hash)) {
        throw new Error('管理员配置损坏，请从备份恢复；不会自动重置管理员');
      }
      this.admin = admin;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private session(req: Request): Session | undefined {
    const now = Date.now();
    for (const [key, value] of this.sessions) if (value.expires <= now) this.sessions.delete(key);
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('mc_panel_session='));
    return cookie ? this.sessions.get(cookie.slice('mc_panel_session='.length)) : undefined;
  }

  status(req: Request) {
    const session = this.session(req);
    return {
      initialized: Boolean(this.admin), authenticated: Boolean(session),
      ...(session ? { username: session.username, csrfToken: session.csrfToken } : {})
    };
  }

  checkOrigin(req: Request) {
    const origin = req.get('origin');
    if (!origin) return;
    let url: URL;
    try { url = new URL(origin); } catch { throw new HttpError(403, '请求来源不正确'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.host !== req.get('host')) {
      throw new HttpError(403, '请从面板地址执行此操作');
    }
  }

  require(req: Request) {
    const session = this.session(req);
    if (!session) throw new HttpError(401, '请先登录');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      this.checkOrigin(req);
      const token = req.get('x-csrf-token') ?? '';
      const actual = Buffer.from(token);
      const expected = Buffer.from(session.csrfToken);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new HttpError(403, '登录凭据已更新，请刷新页面');
      }
    }
    return session;
  }

  private credentials(body: unknown) {
    const data = body as Record<string, unknown> | null;
    const username = text(data?.username, '用户名', 64).trim();
    const password = text(data?.password, '密码', 256);
    if (!username || /[\u0000-\u001f\u007f]/.test(username)) throw new HttpError(400, '请填写有效用户名');
    return { username, password };
  }

  private issue(req: Request, res: Response) {
    const id = randomBytes(32).toString('hex');
    const session = { username: this.admin!.username, csrfToken: randomBytes(32).toString('hex'), expires: Date.now() + SESSION_MS };
    while (this.sessions.size >= 32) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(id, session);
    res.cookie('mc_panel_session', id, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/', maxAge: SESSION_MS });
    return { username: session.username, csrfToken: session.csrfToken };
  }

  async setup(req: Request, res: Response) {
    this.checkOrigin(req);
    return this.changes.run(async () => {
      if (this.admin) throw new HttpError(409, '管理员已经设置，请登录');
      const { username, password } = this.credentials(req.body);
      if (password.length < 12) throw new HttpError(400, '密码至少需要 12 个字符');
      const salt = randomBytes(16).toString('hex');
      const admin = { username, salt, hash: (await hashPassword(password, salt)).toString('hex') };
      await writeJson(this.file, admin);
      this.admin = admin;
      return this.issue(req, res);
    });
  }

  async login(req: Request, res: Response) {
    this.checkOrigin(req);
    if (!this.admin) throw new HttpError(409, '请先设置管理员');
    const now = Date.now();
    for (const [key, value] of this.failures) if (value.expires <= now) this.failures.delete(key);
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const attempt = this.failures.get(ip) ?? { count: 0, expires: now + 10 * 60 * 1000 };
    if (attempt.count >= 5 || (!this.failures.has(ip) && this.failures.size >= 1000)) {
      throw new HttpError(429, '登录尝试过多，请稍后再试');
    }
    // Reserve before awaiting scrypt so parallel requests cannot bypass the limit.
    attempt.count++;
    this.failures.set(ip, attempt);
    const { username, password } = this.credentials(req.body);
    const actual = await hashPassword(password, this.admin.salt);
    if (!timingSafeEqual(actual, Buffer.from(this.admin.hash, 'hex')) || username !== this.admin.username) {
      throw new HttpError(401, '用户名或密码错误');
    }
    this.failures.delete(ip);
    return this.issue(req, res);
  }

  drain(): Promise<void> { return this.changes.run(async () => undefined); }

  logout(req: Request, res: Response) {
    this.require(req);
    const cookie = req.headers.cookie?.split(';').map(item => item.trim()).find(item => item.startsWith('mc_panel_session='));
    if (cookie) this.sessions.delete(cookie.slice('mc_panel_session='.length));
    res.clearCookie('mc_panel_session', { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/' });
    return { ok: true };
  }
}
