import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';

test('real HTTP: setup, sessions, CSRF, file operations and restart persistence', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mc-panel-http-'));
  const dataDir = path.join(base, 'data');
  const directory = path.join(base, 'files');
  await mkdir(directory);
  await writeFile(path.join(directory, 'server.properties'), 'motd=test\n');
  const { app } = await createApp({ dataDir });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(base, { recursive: true, force: true });
  });
  let cookie = '';
  let csrf = '';
  async function request(url: string, method = 'GET', body?: unknown, withCsrf = true, suppliedOrigin = origin) {
    const headers: Record<string, string> = { origin: suppliedOrigin };
    if (cookie) headers.cookie = cookie;
    if (withCsrf && csrf) headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    return fetch(origin + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  assert.equal((await request('/api/roots')).status, 401);
  assert.equal((await request('/api/auth/setup', 'POST', { username: 'admin', password: 'correct-passphrase' }, true, 'http://evil.invalid')).status, 403);
  const setup = await request('/api/auth/setup', 'POST', { username: 'admin', password: 'correct-passphrase' });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get('set-cookie')!.split(';')[0];
  csrf = ((await setup.json()) as { csrfToken: string }).csrfToken;
  assert.equal((await request('/api/auth/setup', 'POST', { username: 'other', password: 'another-password' })).status, 409);
  assert.equal((await request('/api/roots', 'POST', { name: '服务端', path: directory, readOnly: false }, false)).status, 403);
  const registered = await request('/api/roots', 'POST', { name: '服务端', path: directory, readOnly: false });
  assert.equal(registered.status, 201);
  const id = ((await registered.json()) as { root: { id: string } }).root.id;
  const query = `rootId=${encodeURIComponent(id)}&path=server.properties`;
  const loaded = await request(`/api/files/read?${query}`);
  const text = await loaded.json() as { content: string; revision: string };
  assert.equal(text.content, 'motd=test\n');
  assert.equal((await request('/api/files/content', 'PUT', { rootId: id, path: 'server.properties', content: 'motd=updated\n', revision: text.revision })).status, 200);
  assert.equal((await request('/api/files/content', 'PUT', { rootId: id, path: 'server.properties', content: 'stale', revision: text.revision })).status, 409);
  const upload = await fetch(`${origin}/api/files/upload?rootId=${id}&path=mod.jar`, {
    method: 'PUT', headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, body: new Uint8Array([0, 1, 2, 3])
  });
  assert.equal(upload.status, 201);
  const downloaded = await request(`/api/files/download?rootId=${id}&path=mod.jar`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), new Uint8Array([0, 1, 2, 3]));
  const folderUpload = await fetch(`${origin}/api/files/upload?rootId=${id}&path=packs%2Fmods%2Fexample.jar&parents=1`, {
    method: 'PUT', headers: { cookie, origin, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, body: new Uint8Array([4, 5])
  });
  assert.equal(folderUpload.status, 201);
  const unsafeRename = await request('/api/files/rename', 'POST', { rootId: id, path: 'packs', name: 'renamed-packs' });
  assert.equal(unsafeRename.status, 409);
  assert.equal(((await unsafeRename.json()) as { code?: string }).code, 'MOVE_UNSAFE');
  assert.equal((await request('/api/files/archive', 'POST', { rootId: id, paths: ['packs'], destination: 'packs.tar.gz' })).status, 201);
  assert.equal((await request('/api/files/create', 'POST', { rootId: id, path: 'restored', type: 'directory' })).status, 201);
  assert.equal((await request('/api/files/extract', 'POST', { rootId: id, path: 'packs.tar.gz', targetPath: 'restored' })).status, 200);
  const restored = await request(`/api/files/download?rootId=${id}&path=restored%2Fpacks%2Fmods%2Fexample.jar`);
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), new Uint8Array([4, 5]));
  const directoryArchive = await request(`/api/files/archive-download?rootId=${id}&path=packs`);
  assert.equal(directoryArchive.status, 200);
  assert.match(directoryArchive.headers.get('content-disposition') ?? '', /packs\.tar\.gz/);
  assert.ok((await directoryArchive.arrayBuffer()).byteLength > 0);
  assert.equal((await request('/api/auth/logout', 'POST')).status, 200);
  assert.equal((await request('/api/roots')).status, 401);
  const wrong = await request('/api/auth/login', 'POST', { username: 'admin', password: 'incorrect-password' });
  assert.equal(wrong.status, 401);
  const login = await request('/api/auth/login', 'POST', { username: 'admin', password: 'correct-passphrase' });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
  const initialized = await createApp({ dataDir });
  assert.equal(initialized.auth.status({ headers: {} } as Parameters<typeof initialized.auth.status>[0]).initialized, true);
  assert.equal((await initialized.files.listRoots()).length, 1);
});
