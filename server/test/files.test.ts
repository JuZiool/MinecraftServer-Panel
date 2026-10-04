import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, symlink, rename, rm, stat, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { create as createTar } from 'tar';
import { Files, MAX_UPLOAD } from '../src/files.js';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mc-panel-test-'));
  t.after(async () => { await rm(base, { recursive: true, force: true }); });
  const directory = path.join(base, 'servers');
  const outside = path.join(base, 'outside');
  await mkdir(directory);
  await mkdir(outside);
  await writeFile(path.join(directory, 'server.properties'), 'motd=Hello\r\n');
  await writeFile(path.join(outside, 'private.txt'), 'keep private');
  const files = new Files(path.join(base, 'data'));
  await files.initialize();
  const root = await files.addRoot({ name: '服务端', path: directory, readOnly: false });
  return { files, root, base, directory, outside };
}

const errorStatus = (status: number, code?: string) => (error: unknown) => {
  const actual = error as { status?: number; code?: string };
  return actual.status === status && (code === undefined || actual.code === code);
};

test('canonical roots persist, listings retain Chinese and hidden names', async t => {
  const { files, root, base, directory } = await fixture(t);
  await files.create(root.id, '模组', 'directory');
  await files.create(root.id, '.config', 'file');
  const listing = await files.list(root.id, '');
  assert.equal(listing.entries[0].type, 'directory');
  assert.ok(listing.entries.some(entry => entry.name === '.config'));
  const restored = new Files(path.join(base, 'data'));
  await restored.initialize();
  assert.equal((await restored.listRoots())[0].path, directory);
});

test('traversal, absolute paths and filesystem-root registration are denied', async t => {
  const { files, root } = await fixture(t);
  for (const bad of ['../outside/private.txt', '/etc/passwd', 'folder/../../outside', 'folder\\..\\outside']) {
    await assert.rejects(files.readText(root.id, bad), errorStatus(400, 'INVALID_PATH'));
  }
  await assert.rejects(files.addRoot({ name: '系统', path: '/', readOnly: true }), errorStatus(403));
  await assert.rejects(files.delete(root.id, ['']), errorStatus(400));
});

test('symlinks cannot escape roots or be traversed in recursive copies', async t => {
  const { files, root, directory, outside } = await fixture(t);
  await symlink(outside, path.join(directory, 'link'), 'dir');
  const listing = await files.list(root.id, '');
  assert.equal(listing.entries.find(entry => entry.name === 'link')?.type, 'symlink');
  await assert.rejects(files.readText(root.id, 'link/private.txt'), errorStatus(403, 'SYMLINK'));
  await files.create(root.id, 'destination', 'directory');
  await files.create(root.id, 'source', 'directory');
  await symlink(outside, path.join(directory, 'source', 'unsafe'), 'dir');
  await assert.rejects(files.transfer(root.id, ['source'], root.id, 'destination', 'copy'), errorStatus(403));
  assert.equal(await readFile(path.join(outside, 'private.txt'), 'utf8'), 'keep private');
});

test('text saves preserve CRLF and BOM and reject stale revisions', async t => {
  const { files, root, directory } = await fixture(t);
  const original = await files.readText(root.id, 'server.properties');
  const saved = await files.saveText(root.id, 'server.properties', 'motd=新的服务器\r\n', original.revision);
  assert.notEqual(saved.revision, original.revision);
  assert.equal(await readFile(path.join(directory, 'server.properties'), 'utf8'), 'motd=新的服务器\r\n');
  await assert.rejects(files.saveText(root.id, 'server.properties', 'old editor', original.revision), errorStatus(409, 'EDIT_CONFLICT'));
  await writeFile(path.join(directory, 'bom.txt'), '\uFEFFhello\r\n');
  const bom = await files.readText(root.id, 'bom.txt');
  assert.equal(bom.content, '\uFEFFhello\r\n');
  await files.saveText(root.id, 'bom.txt', bom.content, bom.revision);
  assert.equal(await readFile(path.join(directory, 'bom.txt'), 'utf8'), '\uFEFFhello\r\n');
});

test('text editing retains basic mode bits under the native service umask', async t => {
  const { files, root, directory } = await fixture(t);
  const file = path.join(directory, 'server.properties');
  await chmod(file, 0o664);
  const previous = process.umask(0o077);
  t.after(() => { process.umask(previous); });
  const loaded = await files.readText(root.id, 'server.properties');
  await files.saveText(root.id, 'server.properties', 'motd=updated\n', loaded.revision);
  assert.equal((await stat(file)).mode & 0o777, 0o664);
});

test('binary and non-UTF8 content cannot be edited', async t => {
  const { files, root, directory } = await fixture(t);
  await writeFile(path.join(directory, 'world.bin'), Buffer.from([1, 0, 2]));
  await writeFile(path.join(directory, 'bad.txt'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(files.readText(root.id, 'world.bin'), errorStatus(415));
  await assert.rejects(files.readText(root.id, 'bad.txt'), errorStatus(415));
});

test('create, copy and upload never overwrite; rename and move require explicit copy then delete', async t => {
  const { files, root, directory } = await fixture(t);
  await files.create(root.id, 'new.txt', 'file');
  await assert.rejects(files.create(root.id, 'new.txt', 'file'), errorStatus(409));
  await assert.rejects(files.rename(root.id, 'new.txt', 'server.properties'), errorStatus(409));
  await assert.rejects(files.rename(root.id, 'new.txt', 'renamed.txt'), errorStatus(409, 'MOVE_UNSAFE'));
  await files.create(root.id, 'copies', 'directory');
  await assert.rejects(files.transfer(root.id, ['new.txt'], root.id, 'copies', 'move'), errorStatus(409, 'MOVE_UNSAFE'));
  assert.ok((await files.list(root.id, '')).entries.some(entry => entry.name === 'new.txt'));
  await assert.rejects(files.upload(root.id, 'server.properties', Readable.from(['replace'])), errorStatus(409));
  await files.transfer(root.id, ['server.properties'], root.id, 'copies', 'copy');
  await assert.rejects(files.transfer(root.id, ['server.properties'], root.id, 'copies', 'copy'), errorStatus(409));
  assert.equal(await readFile(path.join(directory, 'server.properties'), 'utf8'), 'motd=Hello\r\n');
});

test('streamed uploads publish complete files and enforce declared size limits', async t => {
  const { files, root, directory } = await fixture(t);
  await files.upload(root.id, '上传.jar', Readable.from([Buffer.from([0, 1]), Buffer.from([2, 3])]), 4);
  assert.deepEqual(await readFile(path.join(directory, '上传.jar')), Buffer.from([0, 1, 2, 3]));
  await assert.rejects(files.upload(root.id, 'too-big.jar', Readable.from([]), MAX_UPLOAD + 1), errorStatus(413));
  const failed = Readable.from((async function* () { yield 'partial'; throw new Error('cancelled'); })());
  await assert.rejects(files.upload(root.id, 'cancelled.jar', failed));
  assert.ok(!(await files.list(root.id, '')).entries.some(entry => entry.name.includes('mcp-upload') || entry.name === 'cancelled.jar'));
});

test('folder uploads create missing parents only when explicitly requested', async t => {
  const { files, root, directory } = await fixture(t);
  await assert.rejects(files.upload(root.id, 'pack/mods/a.jar', Readable.from(['a']), 1));
  await files.upload(root.id, 'pack/mods/a.jar', Readable.from(['a']), 1, true);
  await files.upload(root.id, 'pack/config/server.txt', Readable.from(['ok']), 2, true);
  assert.equal(await readFile(path.join(directory, 'pack', 'mods', 'a.jar'), 'utf8'), 'a');
  assert.equal(await readFile(path.join(directory, 'pack', 'config', 'server.txt'), 'utf8'), 'ok');
});

test('directory rename refuses an unsafe replace-capable move and preserves the source', async t => {
  const { files, root, directory } = await fixture(t);
  await mkdir(path.join(directory, 'source'));
  await writeFile(path.join(directory, 'source', 'keep.txt'), 'keep');
  await assert.rejects(files.rename(root.id, 'source', 'destination'), errorStatus(409, 'MOVE_UNSAFE'));
  assert.equal(await readFile(path.join(directory, 'source', 'keep.txt'), 'utf8'), 'keep');
  assert.ok(!(await readdir(directory)).includes('destination'));
});

test('archives round-trip without overwriting and reject links', async t => {
  const { files, root, directory, outside } = await fixture(t);
  await mkdir(path.join(directory, 'world', 'data'), { recursive: true });
  await writeFile(path.join(directory, 'world', 'data', 'level.dat'), 'level');
  await files.createArchive(root.id, ['world'], 'world-backup.tar.gz');
  await mkdir(path.join(directory, 'restore'));
  await files.extractArchive(root.id, 'world-backup.tar.gz', 'restore');
  assert.equal(await readFile(path.join(directory, 'restore', 'world', 'data', 'level.dat'), 'utf8'), 'level');
  await assert.rejects(files.extractArchive(root.id, 'world-backup.tar.gz', 'restore'), errorStatus(409));
  assert.equal(await readFile(path.join(directory, 'restore', 'world', 'data', 'level.dat'), 'utf8'), 'level');
  await mkdir(path.join(directory, 'empty-restore', 'world'), { recursive: true });
  await assert.rejects(files.extractArchive(root.id, 'world-backup.tar.gz', 'empty-restore'), errorStatus(409));
  assert.deepEqual(await readdir(path.join(directory, 'empty-restore', 'world')), []);

  const download = await files.archiveDownload(root.id, 'world');
  let bytes = 0;
  for await (const chunk of download.stream) bytes += (chunk as Buffer).length;
  download.release();
  assert.equal(download.signal.aborted, true);
  assert.ok(bytes > 0);

  const abandoned = await files.archiveDownload(root.id, 'world');
  abandoned.release();
  abandoned.release();
  assert.equal(abandoned.signal.aborted, true);

  await writeFile(path.join(directory, 'duplicate.txt'), 'duplicate');
  await createTar({ cwd: directory, file: path.join(directory, 'duplicate.tar') }, ['duplicate.txt', 'duplicate.txt']);
  await assert.rejects(files.extractArchive(root.id, 'duplicate.tar', 'restore'), errorStatus(400));
  assert.ok(!(await readdir(path.join(directory, 'restore'))).includes('duplicate.txt'));

  await symlink(outside, path.join(directory, 'unsafe-link'), 'dir');
  await createTar({ cwd: directory, file: path.join(directory, 'unsafe.tar') }, ['unsafe-link']);
  await assert.rejects(files.extractArchive(root.id, 'unsafe.tar', 'restore'), errorStatus(400));
  assert.ok(!(await readdir(path.join(directory, 'restore'))).some(entry => entry.includes('mcp-extract')));
});

test('readonly roots reject writes and unregistering keeps source data', async t => {
  const { files, outside, root, directory } = await fixture(t);
  const readonly = await files.addRoot({ name: 'Java', path: outside, readOnly: true });
  assert.equal((await files.readText(readonly.id, 'private.txt')).content, 'keep private');
  await assert.rejects(files.create(readonly.id, 'new.txt', 'file'), errorStatus(403, 'READ_ONLY'));
  await assert.rejects(files.delete(readonly.id, ['private.txt']), errorStatus(403, 'READ_ONLY'));
  await files.transfer(readonly.id, ['private.txt'], root.id, '', 'copy');
  await files.removeRoot(root.id);
  assert.equal(await readFile(path.join(directory, 'server.properties'), 'utf8'), 'motd=Hello\r\n');
});

test('copying into itself is rejected and selected descendants are deleted once', async t => {
  const { files, root, directory } = await fixture(t);
  await files.create(root.id, 'mods', 'directory');
  await files.create(root.id, 'mods/one.jar', 'file');
  await assert.rejects(files.transfer(root.id, ['mods'], root.id, 'mods', 'copy'), errorStatus(400));
  await files.delete(root.id, ['mods', 'mods/one.jar']);
  assert.ok(!(await files.list(root.id, '')).entries.some(entry => entry.name === 'mods'));
  assert.equal(await readFile(path.join(directory, 'server.properties'), 'utf8'), 'motd=Hello\r\n');
});

test('replacing the registered root with a symlink marks it unavailable', async t => {
  const { files, root, base, directory, outside } = await fixture(t);
  await rename(directory, path.join(base, 'old-servers'));
  await symlink(outside, directory, 'dir');
  assert.equal((await files.listRoots())[0].available, false);
  await assert.rejects(files.readText(root.id, 'private.txt'), errorStatus(403));
});

test('application data and runtime stay protected through platform symlink aliases', async t => {
  const { base } = await fixture(t);
  const privateData = path.join(base, 'private-data');
  const runtime = path.join(base, 'runtime');
  const dataAlias = path.join(base, 'data-alias');
  const runtimeAlias = path.join(base, 'runtime-alias');
  await mkdir(privateData);
  await mkdir(runtime);
  await symlink(privateData, dataAlias, 'dir');
  await symlink(runtime, runtimeAlias, 'dir');
  const files = new Files(dataAlias, [runtimeAlias]);
  await files.initialize();
  await assert.rejects(files.addRoot({ name: '应用数据', path: privateData, readOnly: true }), errorStatus(403));
  await assert.rejects(files.addRoot({ name: '应用程序', path: runtime, readOnly: true }), errorStatus(403));
});

test('shutdown cancels an active upload, removes its temporary file and rejects new uploads', async t => {
  const { files, root } = await fixture(t);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let sent = false;
  const stream = new Readable({ read() {
    if (!sent) { sent = true; this.push(Buffer.from('partial')); started(); }
  } });
  const uploading = files.upload(root.id, 'interrupted.jar', stream);
  const failed = assert.rejects(uploading);
  await ready;
  await files.drain();
  await failed;
  assert.ok(!(await files.list(root.id, '')).entries.some(entry => entry.name === 'interrupted.jar' || entry.name.includes('mcp-upload')));
  await assert.rejects(files.upload(root.id, 'new.jar', Readable.from([])), errorStatus(503));
});
