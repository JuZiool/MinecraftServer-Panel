import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  AlertCircle, Archive, ArrowDown, ArrowLeft, ArrowUp, Check, ChevronRight, ClipboardPaste,
  Copy, Download, File as FileIcon, FilePlus2, Folder, FolderPlus, FolderUp, HardDrive,
  Leaf, LoaderCircle, LockKeyhole, LogOut, Plus, RefreshCw,
  Search, ShieldCheck, Trash2, Upload, X,
} from 'lucide-react';
import { api, ApiError, configureApi, errorMessage, fileUrl, uploadFile } from './api';
import type { AuthSession, AuthStatus, Entry, FileContent, Root } from './api';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const typeLabels: Record<Entry['type'], string> = {
  file: '文件', directory: '文件夹', symlink: '符号链接', other: '特殊文件',
};

function formatSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : dateFormat.format(date);
}

function joinPath(parent: string, name: string) { return parent ? `${parent}/${name}` : name; }
function operable(entry: Entry) { return entry.type === 'file' || entry.type === 'directory'; }
function validName(name: string) {
  return name.length > 0 && name !== '.' && name !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(name);
}
function validRelativeFilePath(value: string) {
  return value.length > 0 && !value.includes('\\') && value.split('/').every(validName);
}
function isArchive(entry: Entry) {
  return entry.type === 'file' && /\.(?:tar|tar\.gz|tgz)$/i.test(entry.name);
}
function defaultArchiveName(entries: Entry[]) {
  return entries.length === 1 ? `${entries[0].name}.tar.gz` : 'archive.tar.gz';
}

interface Clipboard {
  rootId: string;
  rootName: string;
  paths: string[];
}

interface Editor extends FileContent {
  rootId: string;
  path: string;
  name: string;
  savedContent: string;
  readOnly: boolean;
  status: string;
  conflict?: FileContent;
}

type Modal =
  | { type: 'create'; kind: 'file' | 'directory' }
  | { type: 'delete'; entries: Entry[] }
  | { type: 'compress'; entries: Entry[] }
  | { type: 'extract'; entry: Entry }
  | { type: 'add-root' }
  | { type: 'remove-root'; root: Root }
  | { type: 'close-editor' };

type SortKey = 'name' | 'type' | 'size' | 'modified';
interface UploadSource {
  file: File;
  relativePath: string;
  createParents: boolean;
}
interface UploadItem {
  name: string;
  size: number;
  progress: number;
  status: 'waiting' | 'uploading' | 'done' | 'failed';
  error?: string;
}

function Dialog({ title, children, busy, onClose, wide = false }: {
  title: string; children: ReactNode; busy: boolean; onClose: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); };
  }, []);
  return (
    <dialog ref={ref} className={`dialog ${wide ? 'dialog-wide' : ''}`} aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="icon-button" aria-label="关闭对话框" disabled={busy} onClick={onClose}><X size={19} /></button>
      </div>
      {children}
    </dialog>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><span className="brand-mark"><Leaf size={24} strokeWidth={1.7} /></span>
    <span><strong>MC 面板<span className="brand-dot">.</span></strong><small>{compact ? '文件管理' : 'MINECRAFT · 文件管理'}</small></span></div>;
}

export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authError, setAuthError] = useState('');
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [roots, setRoots] = useState<Root[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [rootId, setRootId] = useState('');
  const [path, setPath] = useState('');
  const locationRef = useRef({ rootId, path });
  locationRef.current = { rootId, path };
  const [entries, setEntries] = useState<Entry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState('');
  const listSequence = useRef(0);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({ key: 'name', ascending: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [modal, setModal] = useState<Modal | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderUploadInput = useRef<HTMLInputElement>(null);
  const selectAllInput = useRef<HTMLInputElement>(null);
  const root = roots.find(item => item.id === rootId);
  const canWrite = Boolean(root?.available && !root.readOnly);
  const editorRoot = roots.find(item => item.id === editor?.rootId);
  const editorCanWrite = Boolean(editor && !editor.readOnly && editorRoot?.available && !editorRoot.readOnly);
  const dirty = Boolean(editor && editor.content !== editor.savedContent);

  const expireSession = useCallback(() => {
    setAuth(current => ({ initialized: current?.initialized ?? true, authenticated: false }));
    setAuthError('登录已过期，请重新登录。未保存的编辑内容会暂时保留。');
    setModal(null);
  }, []);

  useEffect(() => { configureApi(auth?.csrfToken, expireSession); }, [auth?.csrfToken, expireSession]);

  useEffect(() => {
    const controller = new AbortController();
    setAuthError('');
    api<AuthStatus>('/api/auth/status', { signal: controller.signal })
      .then(status => {
        if (controller.signal.aborted) return;
        configureApi(status.csrfToken, expireSession);
        setAuth(status);
      })
      .catch(reason => { if (!controller.signal.aborted) setAuthError(errorMessage(reason)); });
    return () => controller.abort();
  }, [authAttempt, expireSession]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function begin(label: string) {
    // ponytail: one global mutation lock; independent queues only if concurrent work is needed.
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(label);
    return true;
  }
  function finish() { busyRef.current = false; setBusy(''); }

  const loadList = useCallback(async (id: string, relativePath: string, signal?: AbortSignal) => {
    const sequence = ++listSequence.current;
    setListLoading(true);
    setListError('');
    try {
      const data = await api<{ path: string; entries: Entry[] }>(fileUrl('list', id, relativePath), { signal });
      if (sequence !== listSequence.current || signal?.aborted) return;
      setEntries(data.entries);
      const paths = new Set(data.entries.filter(operable).map(entry => entry.path));
      setSelected(current => new Set([...current].filter(item => paths.has(item))));
    } catch (reason) {
      if (sequence !== listSequence.current || signal?.aborted) return;
      setListError(errorMessage(reason));
      setEntries([]);
      setSelected(new Set());
    } finally {
      if (sequence === listSequence.current && !signal?.aborted) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!auth?.authenticated) return;
    const controller = new AbortController();
    setRootsLoading(true);
    api<{ roots: Root[] }>('/api/roots', { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted) return;
        setRoots(data.roots);
        const location = locationRef.current;
        if (!data.roots.some(item => item.id === location.rootId)) {
          const nextId = data.roots.find(item => item.available)?.id ?? data.roots[0]?.id ?? '';
          locationRef.current = { rootId: nextId, path: '' };
          setRootId(nextId);
          setPath('');
        }
      })
      .catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setRootsLoading(false); });
    return () => controller.abort();
  }, [auth?.authenticated]);

  useEffect(() => {
    setEntries([]);
    setSelected(new Set());
    setSearch('');
    setListError('');
    if (!auth?.authenticated || !rootId || !root?.available) {
      setListLoading(false);
      return;
    }
    const controller = new AbortController();
    void loadList(rootId, path, controller.signal);
    return () => controller.abort();
  }, [auth?.authenticated, rootId, path, root?.available, loadList]);

  async function refreshWorkspace() {
    try {
      const data = await api<{ roots: Root[] }>('/api/roots');
      setRoots(data.roots);
      const location = locationRef.current;
      const current = data.roots.find(item => item.id === location.rootId);
      if (!current) {
        const nextId = data.roots.find(item => item.available)?.id ?? data.roots[0]?.id ?? '';
        locationRef.current = { rootId: nextId, path: '' };
        setRootId(nextId);
        setPath('');
        setEntries([]);
        setSelected(new Set());
      } else if (current.available) {
        await loadList(location.rootId, location.path);
      } else {
        setEntries([]);
        setSelected(new Set());
      }
    } catch (reason) {
      setError(current => current || errorMessage(reason));
      // A roots refresh failure must not prevent checking partial file mutations.
      const location = locationRef.current;
      if (location.rootId) await loadList(location.rootId, location.path);
    }
  }

  async function mutation(label: string, action: () => Promise<void>) {
    if (!begin(label)) return;
    setError('');
    setDialogError('');
    setNotice('');
    try {
      await action();
      setNotice(`${label}完成`);
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      setDialogError(message);
      setModal(current => current?.type === 'delete' ? null : current);
    } finally {
      await refreshWorkspace();
      finish();
    }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');
    if (!username || !password) { setAuthError('请填写用户名和密码。'); return; }
    if (!begin(auth?.initialized ? '登录' : '创建管理员')) return;
    setAuthError('');
    try {
      const session = await api<AuthSession>(auth?.initialized ? '/api/auth/login' : '/api/auth/setup', {
        method: 'POST', body: { username, password }, publicRequest: true,
      });
      configureApi(session.csrfToken, expireSession);
      setAuth({ initialized: true, authenticated: true, ...session });
      setError('');
      setNotice('');
    } catch (reason) { setAuthError(errorMessage(reason)); }
    finally { finish(); }
  }

  async function logout() {
    if (!begin('退出登录')) return;
    setError('');
    try {
      await api('/api/auth/logout', { method: 'POST' });
      configureApi(undefined, expireSession);
      setAuth({ initialized: true, authenticated: false });
      setClipboard(null);
      setRoots([]);
      setRootId('');
      setPath('');
      setEntries([]);
      setSelected(new Set());
      setUploads([]);
      setAuthError('');
    } catch (reason) { setError(errorMessage(reason)); }
    finally { finish(); }
  }

  function navigate(id: string, nextPath: string) {
    if (busyRef.current || (id === rootId && nextPath === path)) return;
    locationRef.current = { rootId: id, path: nextPath };
    setRootId(id);
    setPath(nextPath);
    setEntries([]);
    setSelected(new Set());
    setError('');
    setNotice('');
  }

  function openModal(next: Modal) {
    if (busyRef.current) return;
    setDialogError('');
    setModal(next);
  }

  async function openFile(entry: Entry) {
    if (entry.type === 'directory') { navigate(rootId, entry.path); return; }
    if (entry.type !== 'file' || !root?.available) return;
    if (entry.size > MAX_TEXT_BYTES) {
      setError('文本编辑仅支持不超过 2 MiB 的 UTF-8 文件，请使用下载。');
      return;
    }
    if (!begin('读取文件')) return;
    setError('');
    try {
      const data = await api<FileContent>(fileUrl('read', rootId, entry.path));
      setEditor({ ...data, rootId, path: entry.path, name: entry.name, savedContent: data.content,
        readOnly: root.readOnly, status: root.readOnly ? '只读目录 · 可查看和下载' : '已载入 · UTF-8' });
    } catch (reason) { setError(errorMessage(reason)); }
    finally { finish(); }
  }

  async function saveEditor() {
    if (!editor || !editorCanWrite || editor.conflict || !dirty) return;
    if (new TextEncoder().encode(editor.content).length > MAX_TEXT_BYTES) {
      setEditor(current => current ? { ...current, status: '内容超过 2 MiB，无法保存。' } : current);
      return;
    }
    if (!begin('保存文件')) return;
    const draft = editor;
    setEditor(current => current ? { ...current, status: '正在保存…' } : current);
    setError('');
    try {
      const data = await api<{ revision: string }>('/api/files/content', {
        method: 'PUT', body: { rootId: draft.rootId, path: draft.path, content: draft.content, revision: draft.revision },
      });
      setEditor(current => current ? { ...current, revision: data.revision, savedContent: draft.content,
        status: `已保存 · ${new Date().toLocaleTimeString('zh-CN')}` } : current);
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      setEditor(current => current ? { ...current, status: message } : current);
      if (reason instanceof ApiError && reason.status === 409) {
        try {
          const latest = await api<FileContent>(fileUrl('read', draft.rootId, draft.path));
          setEditor(current => current ? { ...current, conflict: latest,
            status: '服务器文件已变化，本地编辑已保留。请选择恢复方式。' } : current);
        } catch (recoveryError) {
          setEditor(current => current ? { ...current,
            status: `版本冲突；无法读取最新文件：${errorMessage(recoveryError)}。请下载本地草稿后重试。` } : current);
        }
      }
    } finally {
      await refreshWorkspace();
      finish();
    }
  }

  function closeEditor() {
    if (busyRef.current) return;
    if (dirty) openModal({ type: 'close-editor' });
    else setEditor(null);
  }

  async function downloadEntry(entry: Entry) {
    if (!operable(entry) || !root?.available || !begin('准备下载')) return;
    setError('');
    try {
      const status = await api<AuthStatus>('/api/auth/status');
      if (!status.authenticated) { expireSession(); return; }
      configureApi(status.csrfToken, expireSession);
      setAuth(status);
      const archive = entry.type === 'directory';
      const anchor = document.createElement('a');
      anchor.href = fileUrl(archive ? 'archive-download' : 'download', rootId, entry.path);
      anchor.download = archive ? `${entry.name}.tar.gz` : entry.name;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (reason) { setError(errorMessage(reason)); }
    finally { finish(); }
  }

  function downloadDraft() {
    if (!editor) return;
    const url = URL.createObjectURL(new Blob([editor.content], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = editor.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function submitModal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal) return;
    const data = new FormData(event.currentTarget);
    if (modal.type === 'create') {
      const name = String(data.get('name') ?? '').trim();
      if (!validName(name)) { setDialogError('名称不能为空、为 . 或 ..，或包含斜杠、反斜杠及控制字符。'); return; }
      if (!canWrite) { setDialogError('当前目录不可写。'); return; }
      await mutation('新建', async () => {
        await api('/api/files/create', { method: 'POST', body: { rootId, path: joinPath(path, name), type: modal.kind } });
        setModal(null);
      });
    } else if (modal.type === 'add-root') {
      const name = String(data.get('name') ?? '').trim();
      const nativePath = String(data.get('path') ?? '').trim();
      if (!name || !nativePath) { setDialogError('请填写目录名称与本机绝对路径。'); return; }
      await mutation('注册目录', async () => {
        const result = await api<{ root: Root }>('/api/roots', {
          method: 'POST', body: { name, path: nativePath, readOnly: data.get('readOnly') === 'on' },
        });
        setRoots(current => [...current.filter(item => item.id !== result.root.id), result.root]);
        locationRef.current = { rootId: result.root.id, path: '' };
        setRootId(result.root.id);
        setPath('');
        setModal(null);
      });
    } else if (modal.type === 'remove-root') {
      const removing = modal.root;
      await mutation('移除注册', async () => {
        await api(`/api/roots/${encodeURIComponent(removing.id)}`, { method: 'DELETE' });
        if (clipboard?.rootId === removing.id) setClipboard(null);
        setModal(null);
      });
    } else if (modal.type === 'delete') {
      if (!canWrite) { setDialogError('当前目录不可写。'); return; }
      const deleting = modal.entries;
      await mutation('删除', async () => {
        await api('/api/files', { method: 'DELETE', body: { rootId, paths: deleting.map(entry => entry.path) } });
        setModal(null);
      });
    } else if (modal.type === 'compress') {
      if (!canWrite) { setDialogError('当前目录不可写。'); return; }
      const archiveName = String(data.get('name') ?? '').trim();
      if (!validName(archiveName) || !archiveName.toLocaleLowerCase('en-US').endsWith('.tar.gz')) {
        setDialogError('压缩文件名称必须合法并以 .tar.gz 结尾。');
        return;
      }
      const compressing = modal.entries;
      await mutation('压缩', async () => {
        await api('/api/files/archive', { method: 'POST', body: {
          rootId, paths: compressing.map(entry => entry.path), destination: joinPath(path, archiveName),
        } });
        setModal(null);
      });
    } else if (modal.type === 'extract') {
      if (!canWrite) { setDialogError('当前目录不可写。'); return; }
      const extracting = modal.entry;
      await mutation('解压', async () => {
        await api('/api/files/extract', { method: 'POST', body: { rootId, path: extracting.path, targetPath: path } });
        setModal(null);
      });
    }
  }

  const selectedEntries = entries.filter(entry => selected.has(entry.path) && operable(entry));
  const visibleEntries = useMemo(() => {
    const query = search.toLocaleLowerCase('zh-CN');
    return entries.filter(entry => entry.name.toLocaleLowerCase('zh-CN').includes(query)).sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (b.type === 'directory' && a.type !== 'directory') return 1;
      let order = 0;
      if (sort.key === 'size') order = a.size - b.size;
      else if (sort.key === 'modified') order = (Date.parse(a.modified) || 0) - (Date.parse(b.modified) || 0);
      else if (sort.key === 'type') order = collator.compare(typeLabels[a.type], typeLabels[b.type]);
      else order = collator.compare(a.name, b.name);
      return (order || collator.compare(a.name, b.name)) * (sort.ascending ? 1 : -1);
    });
  }, [entries, search, sort]);
  const selectable = visibleEntries.filter(operable);
  const allSelected = selectable.length > 0 && selectable.every(entry => selected.has(entry.path));
  const someSelected = selectable.some(entry => selected.has(entry.path));
  useEffect(() => {
    if (selectAllInput.current) selectAllInput.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  function toggleAll() {
    setSelected(current => {
      const next = new Set(current);
      for (const entry of selectable) { if (allSelected) next.delete(entry.path); else next.add(entry.path); }
      return next;
    });
  }

  function prepareClipboard() {
    if (!root || !selectedEntries.length || busyRef.current) return;
    setClipboard({ rootId, rootName: root.name, paths: selectedEntries.map(entry => entry.path) });
    setNotice(`已复制 ${selectedEntries.length} 项；可切换目录后粘贴。`);
  }

  async function paste() {
    if (!clipboard || !canWrite) return;
    const source = roots.find(item => item.id === clipboard.rootId);
    if (!source?.available) {
      setError('来源目录不可用，请重新选择文件。');
      return;
    }
    const saved = clipboard;
    await mutation('复制', async () => {
      await api('/api/files/transfer', { method: 'POST', body: {
        sourceRootId: saved.rootId, paths: saved.paths, targetRootId: rootId,
        targetPath: path, operation: 'copy',
      } });
    });
  }

  async function upload(files: File[], preservePaths = false) {
    if (!files.length || !canWrite || !begin(preservePaths ? '上传文件夹' : '上传文件')) return;
    const destinationRoot = rootId;
    const destinationPath = path;
    const sources: UploadSource[] = files.map(file => ({
      file,
      relativePath: preservePaths ? (file.webkitRelativePath || file.name) : file.name,
      createParents: preservePaths,
    }));
    const queue: UploadItem[] = sources.map(source => ({ name: source.relativePath, size: source.file.size, progress: 0, status: 'waiting' }));
    setUploads(queue);
    setError('');
    setNotice('');
    const update = (index: number, changes: Partial<UploadItem>) => {
      setUploads(current => current.map((item, position) => position === index ? { ...item, ...changes } : item));
    };
    let failures = 0;
    try {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index];
        if (!validRelativeFilePath(source.relativePath) || source.file.size > MAX_UPLOAD_BYTES) {
          failures++;
          update(index, { status: 'failed', error: source.file.size > MAX_UPLOAD_BYTES ? '超过单文件 5 GiB 限制' : '文件相对路径不合法' });
          continue;
        }
        update(index, { status: 'uploading' });
        try {
          await uploadFile(destinationRoot, joinPath(destinationPath, source.relativePath), source.file,
            progress => update(index, { progress }), source.createParents);
          update(index, { status: 'done', progress: 100 });
        } catch (reason) {
          failures++;
          const message = errorMessage(reason);
          update(index, { status: 'failed', error: message });
          setError(message);
          await loadList(destinationRoot, destinationPath);
          if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403)) {
            for (let remaining = index + 1; remaining < sources.length; remaining++) {
              update(remaining, { status: 'failed', error: '会话失效，未上传' });
              failures++;
            }
            break;
          }
        }
      }
      setNotice(failures ? `上传结束：${sources.length - failures} 个成功，${failures} 个失败。` : `已上传 ${sources.length} 个文件。`);
    } finally {
      await refreshWorkspace();
      finish();
    }
  }

  function sortBy(key: SortKey) {
    setSort(current => ({ key, ascending: current.key === key ? !current.ascending : true }));
  }

  const sortHeading = (key: SortKey, title: string, className = '') => (
    <th scope="col" className={className} aria-sort={sort.key === key ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => sortBy(key)}>{title}
        {sort.key === key && (sort.ascending ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
      </button>
    </th>
  );

  if (!auth) return (
    <main className="auth-page"><div className="auth-card"><Brand />
      <div className="auth-heading"><h1>连接文件管理</h1><p>正在读取本地面板状态。</p></div>
      {authError ? <><div className="alert error" role="alert"><AlertCircle size={18} />{authError}</div>
        <button type="button" className="button primary full-width" onClick={() => setAuthAttempt(current => current + 1)}><RefreshCw size={17} />重试连接</button></>
        : <div className="loading-state" role="status"><LoaderCircle className="spin" size={24} />连接中…</div>}
    </div></main>
  );

  if (!auth.authenticated) return (
    <main className="auth-page">
      <div className="auth-decoration" aria-hidden="true"><Leaf size={160} strokeWidth={0.6} /></div>
      <section className="auth-card"><Brand />
        <div className="auth-heading"><span className="eyebrow">LOCAL FILES, QUIETLY ORGANIZED</span>
          <h1>{auth.initialized ? '登录管理面板' : '设置管理员账户'}</h1>
          <p>{auth.initialized ? '登录后管理已注册目录中的文件。' : '首次使用：创建管理员账户，随后添加本机目录。'}</p></div>
        <form onSubmit={authenticate} className="form-stack">
          <label>用户名<input name="username" required autoFocus autoComplete="username" disabled={Boolean(busy)} placeholder="管理员用户名" /></label>
          <label>密码<input name="password" type="password" required autoComplete={auth.initialized ? 'current-password' : 'new-password'} disabled={Boolean(busy)} placeholder={auth.initialized ? '输入密码' : '设置管理员密码'} /></label>
          {authError && <div className="alert error" role="alert"><AlertCircle size={17} /><span>{authError}</span></div>}
          <button className="button primary full-width" type="submit" disabled={Boolean(busy)}>
            {busy ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={18} />}
            {busy || (auth.initialized ? '登录面板' : '创建账户并进入')}
          </button>
        </form>
        <p className="auth-footnote"><ShieldCheck size={15} /> 登录后管理已接入的文件夹</p>
      </section><p className="auth-caption">Minecraft 服务器文件管理</p>
    </main>
  );

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="已注册目录">
        <Brand compact />
        <div className="sidebar-section-label"><span>目录空间</span><span className="count-pill">{roots.length}</span></div>
        <nav className="root-list" aria-label="选择目录">
          {roots.map(item => <div className={`root-row ${rootId === item.id ? 'active' : ''}`} key={item.id}>
            <button type="button" className="root-button" disabled={Boolean(busy)} onClick={() => navigate(item.id, '')} aria-current={rootId === item.id ? 'page' : undefined} title={item.path}>
              <HardDrive size={19} /><span className="root-text"><strong>{item.name}</strong><small>{!item.available ? '目录不可用' : item.readOnly ? '只读目录' : '本地目录'}</small></span>
              {!item.available ? <AlertCircle size={14} className="warning-icon" /> : item.readOnly ? <LockKeyhole size={13} /> : <span className="root-dot" />}
            </button>
            <button type="button" className="root-remove icon-button" aria-label={`移除 ${item.name} 的目录注册`} disabled={Boolean(busy)} onClick={() => openModal({ type: 'remove-root', root: item })}><X size={15} /></button>
          </div>)}
          {!rootsLoading && roots.length === 0 && <p className="sidebar-empty">还没有注册目录</p>}
          {rootsLoading && <p className="sidebar-empty" role="status">正在读取目录…</p>}
        </nav>
        <button type="button" className="add-root" disabled={Boolean(busy)} onClick={() => openModal({ type: 'add-root' })}><Plus size={17} />添加本机目录</button>
        <div className="sidebar-note"><ShieldCheck size={18} /><p>只访问你注册的目录。<br />每次修改，都由你决定。</p></div>
        <div className="sidebar-footer"><span className="avatar">{(auth.username ?? '管').slice(0, 1).toUpperCase()}</span>
          <span><strong>{auth.username ?? '管理员'}</strong><small>本地管理员</small></span>
          <button type="button" className="icon-button" aria-label="退出登录" disabled={Boolean(busy)} onClick={() => void logout()}><LogOut size={18} /></button>
        </div>
      </aside>

      <main className="workspace">
        <header className="workspace-header"><div><span className="eyebrow">YOUR LOCAL WORKSPACE</span><h1>文件管理<span className="heading-dot">.</span></h1><p>整理文件，专注下一次创造。</p></div>
          <div className="workspace-status"><span className="status-dot" />{busy || '本地文件管理'}</div>
        </header>

        <section className="file-panel" aria-label="文件浏览器">
          <div className="browser-location">
            <nav className="breadcrumbs" aria-label="当前位置">
              <HardDrive size={17} />
              <button type="button" disabled={!root || Boolean(busy)} onClick={() => navigate(rootId, '')}>{root?.name ?? '选择目录'}</button>
              {path.split('/').filter(Boolean).map((part, index, parts) => <span key={parts.slice(0, index + 1).join('/')}><ChevronRight size={14} />
                <button type="button" disabled={Boolean(busy)} onClick={() => navigate(rootId, parts.slice(0, index + 1).join('/'))} aria-current={index === parts.length - 1 ? 'location' : undefined}>{part}</button></span>)}
            </nav>
            <button type="button" className="icon-button" aria-label="刷新目录" disabled={Boolean(busy) || rootsLoading || listLoading} onClick={() => void mutation('刷新', async () => {})}><RefreshCw size={17} className={listLoading ? 'spin' : ''} /></button>
          </div>
          {root && <div className="directory-meta"><span className="native-path" title={root.path}>{root.path}{path ? ` / ${path}` : ''}</span>
            <span className={`access-badge ${!root.available || root.readOnly ? 'readonly' : ''}`}>{!root.available ? <AlertCircle size={12} /> : root.readOnly ? <LockKeyhole size={12} /> : <ShieldCheck size={12} />}{!root.available ? '不可用' : root.readOnly ? '只读' : '可读写'}</span></div>}

          <div className="browser-toolbar">
            <div className="toolbar-actions">
              <button type="button" className="button primary" disabled={!canWrite || Boolean(busy) || listLoading} onClick={() => uploadInput.current?.click()}><Upload size={16} />上传文件</button>
              <button type="button" className="button" disabled={!canWrite || Boolean(busy) || listLoading} onClick={() => folderUploadInput.current?.click()}><FolderUp size={16} />上传文件夹</button>
              <button type="button" className="button" disabled={!canWrite || Boolean(busy) || listLoading} onClick={() => openModal({ type: 'create', kind: 'directory' })}><FolderPlus size={16} />新建文件夹</button>
              <button type="button" className="button" disabled={!canWrite || Boolean(busy) || listLoading} onClick={() => openModal({ type: 'create', kind: 'file' })}><FilePlus2 size={16} />新建文件</button>
              <input ref={uploadInput} type="file" multiple className="visually-hidden" aria-label="选择上传文件" disabled={!canWrite || Boolean(busy)} onChange={event => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                void upload(files);
              }} />
              <input ref={element => { folderUploadInput.current = element; element?.setAttribute('webkitdirectory', ''); }} type="file" multiple className="visually-hidden" aria-label="选择上传文件夹" disabled={!canWrite || Boolean(busy)} onChange={event => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                void upload(files, true);
              }} />
            </div>
            <label className="search-field"><Search size={17} /><span className="visually-hidden">搜索当前文件夹</span>
              <input type="search" placeholder="搜索当前文件夹" value={search} onChange={event => setSearch(event.target.value)} disabled={!root?.available} />
              <kbd aria-hidden="true">本层</kbd></label>
          </div>

          {busy && <div className="busy-strip" role="status"><LoaderCircle className="spin" size={15} />{busy}…</div>}
          {(error || notice) && <div className={`alert inline-alert ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}>
            {error ? <AlertCircle size={17} /> : <Check size={17} />}<span>{error || notice}</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}><X size={15} /></button>
          </div>}
          {root?.readOnly && <div className="readonly-note"><LockKeyhole size={14} /> 此目录为只读，可浏览、查看文本、下载或复制到可写目录。</div>}
          {clipboard && <div className="clipboard-bar"><ClipboardPaste size={16} /><span>待复制 <strong>{clipboard.paths.length}</strong> 项 · 来自 {clipboard.rootName}</span>
            <button type="button" className="button small" disabled={!canWrite || Boolean(busy) || listLoading} onClick={() => void paste()}>粘贴到此处</button>
            <button type="button" className="icon-button" aria-label="清空剪贴板" disabled={Boolean(busy)} onClick={() => setClipboard(null)}><X size={15} /></button>
          </div>}

          <div className="selection-bar"><span>{selectedEntries.length ? `已选择 ${selectedEntries.length} 项` : '选择文件进行操作'}</span>
            <div className="selection-actions">
              <button type="button" className="text-button" disabled={selectedEntries.length !== 1 || Boolean(busy) || listLoading} onClick={() => void downloadEntry(selectedEntries[0])}><Download size={14} />下载</button>
              <button type="button" className="text-button" disabled={!selectedEntries.length || !canWrite || Boolean(busy) || listLoading} onClick={() => openModal({ type: 'compress', entries: selectedEntries })}><Archive size={14} />压缩</button>
              <button type="button" className="text-button" disabled={selectedEntries.length !== 1 || !isArchive(selectedEntries[0]) || !canWrite || Boolean(busy) || listLoading} onClick={() => openModal({ type: 'extract', entry: selectedEntries[0] })}><Archive size={14} />解压</button>
              <button type="button" className="text-button" disabled={!selectedEntries.length || Boolean(busy) || listLoading} onClick={prepareClipboard}><Copy size={14} />复制</button>
              <button type="button" className="text-button danger-text" disabled={!selectedEntries.length || !canWrite || Boolean(busy) || listLoading} onClick={() => openModal({ type: 'delete', entries: selectedEntries })}><Trash2 size={14} />删除</button>
            </div>
          </div>

          {!root && !rootsLoading ? <div className="empty-state"><span className="empty-icon"><FolderPlus size={34} strokeWidth={1.3} /></span><h2>给文件一个入口</h2><p>注册一个本机目录，开始浏览和整理 Minecraft 文件。</p>
            <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => openModal({ type: 'add-root' })}><Plus size={16} />添加第一个目录</button></div>
            : root && !root.available ? <div className="empty-state"><span className="empty-icon warning"><AlertCircle size={32} /></span><h2>目录暂时不可用</h2><p>{root.error ?? '无法访问注册路径，请检查路径或本机权限。'}</p><button type="button" className="button" disabled={Boolean(busy)} onClick={() => void mutation('刷新', async () => {})}><RefreshCw size={16} />重新检查</button></div>
            : listError ? <div className="empty-state" role="alert"><span className="empty-icon warning"><AlertCircle size={32} /></span><h2>无法读取文件夹</h2><p>{listError}</p><div className="dialog-actions">{path && <button type="button" className="button" disabled={Boolean(busy)} onClick={() => navigate(rootId, path.split('/').slice(0, -1).join('/'))}><ArrowLeft size={16} />返回上级</button>}<button type="button" className="button" disabled={Boolean(busy)} onClick={() => void mutation('刷新', async () => {})}><RefreshCw size={16} />重试</button></div></div>
            : <div className="table-scroll" aria-busy={listLoading || rootsLoading}>
              <table className="file-table"><thead><tr><th scope="col" className="check-cell"><input ref={selectAllInput} type="checkbox" aria-label="选择当前搜索结果中的所有可操作文件" checked={allSelected} disabled={!selectable.length || Boolean(busy) || listLoading} onChange={toggleAll} /></th>
                {sortHeading('name', '名称', 'name-column')}{sortHeading('type', '类型', 'type-column')}{sortHeading('size', '大小', 'size-column')}{sortHeading('modified', '修改时间', 'date-column')}<th scope="col" className="permissions-column">权限</th><th scope="col" className="row-actions"><span className="visually-hidden">操作</span></th></tr></thead>
                <tbody>{visibleEntries.map(entry => <tr key={entry.path} className={`${selected.has(entry.path) ? 'selected' : ''} ${!operable(entry) ? 'restricted-row' : ''}`}>
                  <td className="check-cell"><input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selected.has(entry.path)} disabled={!operable(entry) || Boolean(busy) || listLoading} onChange={() => setSelected(current => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })} /></td>
                  <td className="name-cell"><span className={`file-icon ${entry.type === 'directory' ? 'folder-icon' : ''}`}>{entry.type === 'directory' ? <Folder size={21} strokeWidth={1.7} /> : <FileIcon size={20} strokeWidth={1.6} />}</span>
                    {operable(entry) ? <button type="button" className="file-name" disabled={Boolean(busy) || listLoading} onClick={() => void openFile(entry)} title={entry.type === 'directory' ? `打开 ${entry.name}` : `查看 UTF-8 文本 ${entry.name}`}>{entry.name}</button>
                      : <span className="file-name disabled-name" title="符号链接与特殊文件仅展示，不能操作">{entry.name}</span>}
                  </td>
                  <td className="type-column">{typeLabels[entry.type]}</td><td className="size-column">{entry.type === 'directory' ? '—' : formatSize(entry.size)}</td><td className="date-column">{formatDate(entry.modified)}</td><td className="permissions-column"><code>{entry.permissions || '—'}</code></td>
                  <td className="row-actions">{operable(entry) && <a className={`icon-button ${busy ? 'disabled-link' : ''}`} href={busy ? undefined : fileUrl(entry.type === 'directory' ? 'archive-download' : 'download', rootId, entry.path)} aria-label={`下载 ${entry.name}`} aria-disabled={Boolean(busy)} onClick={event => { event.preventDefault(); void downloadEntry(entry); }} download><Download size={16} /></a>}</td>
                </tr>)}</tbody>
              </table>
              {(listLoading || rootsLoading) && <div className="table-loading" role="status"><LoaderCircle className="spin" size={23} />正在读取文件…</div>}
              {!listLoading && !rootsLoading && visibleEntries.length === 0 && <div className="empty-state compact"><span className="empty-icon"><Search size={29} strokeWidth={1.4} /></span><h2>{search ? '没有匹配的文件' : '这个文件夹很安静'}</h2><p>{search ? '搜索只检查当前文件夹，试试其他名称。' : root?.readOnly ? '此目录目前没有文件。' : '上传文件，或新建你的第一个文件夹。'}</p></div>}
            </div>}
          <footer className="browser-footer"><span>{entries.length} 个项目{search ? ` · ${visibleEntries.length} 个匹配` : ''}{selectedEntries.length ? ` · 已选 ${selectedEntries.length} 项` : ''}</span><span>UTF-8 编辑 ≤ 2 MiB <span className="footer-divider">/</span> 上传 ≤ 5 GiB</span></footer>
        </section>

        {uploads.length > 0 && <section className="upload-panel" aria-label="上传进度"><div className="upload-heading"><h2><Upload size={17} />文件上传</h2><span>顺序上传 · 同名文件保留原文件</span><button type="button" className="icon-button" aria-label="关闭上传列表" disabled={Boolean(busy)} onClick={() => setUploads([])}><X size={17} /></button></div>
          <ul className="upload-list">{uploads.map((item, index) => <li key={`${index}-${item.name}`}><FileIcon size={17} /><div className="upload-detail"><div className="upload-file-heading"><strong>{item.name}</strong><span>{formatSize(item.size)}</span></div><progress max={100} value={item.progress} aria-label={`${item.name} 上传进度`} />{item.error && <p className="upload-error">{item.error}</p>}</div><span className={`upload-status ${item.status}`} aria-live="polite">{item.status === 'done' ? '已完成' : item.status === 'failed' ? '失败' : item.status === 'waiting' ? '等待中' : `${item.progress}%`}</span></li>)}</ul>
        </section>}
        <p className="workspace-footnote">文件留在本机。操作仅发生于已注册目录。</p>
      </main>

      {editor && <Dialog title={editor.name} busy={Boolean(busy)} onClose={closeEditor} wide>
        <div className="editor-meta"><span title={editor.path}>{roots.find(item => item.id === editor.rootId)?.name ?? '本地目录'} / {editor.path}</span><span className="access-badge">{editorCanWrite ? 'UTF-8' : '只读'}</span></div>
        <textarea className="code-editor" aria-label={`${editor.name} 的 UTF-8 内容`} value={editor.content} readOnly={!editorCanWrite} disabled={Boolean(busy)} spellCheck={false} onChange={event => setEditor(current => current ? { ...current, content: event.target.value, status: '有未保存的更改' } : current)} />
        {editor.conflict && <div className="conflict-box" role="alert"><h3><AlertCircle size={17} />文件版本发生变化</h3><p>本地内容已保留。载入服务器内容，或保留本地编辑并使用最新版本号再次保存。</p>
          <details><summary>查看服务器最新内容</summary><textarea className="conflict-preview" value={editor.conflict.content} readOnly aria-label="服务器最新内容" /></details>
          <div className="conflict-actions"><button type="button" className="button small" disabled={Boolean(busy)} onClick={() => setEditor(current => current?.conflict ? { ...current, ...current.conflict, savedContent: current.conflict.content, conflict: undefined, status: '已载入服务器最新内容' } : current)}>用服务器内容替换本地编辑</button>
            <button type="button" className="button small" disabled={Boolean(busy)} onClick={() => setEditor(current => current?.conflict ? { ...current, revision: current.conflict.revision, savedContent: current.conflict.content, conflict: undefined, status: '已保留本地内容。再次保存会更新服务器文件。' } : current)}>保留本地编辑，更新版本号</button></div>
        </div>}
        <div className="editor-footer"><span className={`editor-status ${dirty ? 'unsaved' : ''}`} role="status">{editor.status}{dirty ? ' · 未保存' : ''}</span><div className="dialog-actions"><button type="button" className="button" disabled={Boolean(busy)} onClick={downloadDraft}><Download size={15} />下载{dirty ? '本地草稿' : '文本'}</button><button type="button" className="button" disabled={Boolean(busy)} onClick={closeEditor}>关闭</button>{editorCanWrite && <button type="button" className="button primary" disabled={Boolean(busy) || !dirty || Boolean(editor.conflict)} onClick={() => void saveEditor()}>{busy === '保存文件' ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}保存更改</button>}</div></div>
      </Dialog>}

      {modal && <Dialog title={modal.type === 'create' ? (modal.kind === 'directory' ? '新建文件夹' : '新建文件') : modal.type === 'delete' ? '确认永久删除' : modal.type === 'compress' ? '压缩所选项目' : modal.type === 'extract' ? '解压归档' : modal.type === 'add-root' ? '添加本机目录' : modal.type === 'remove-root' ? '移除目录注册' : '关闭未保存的文件'} busy={Boolean(busy)} onClose={() => setModal(null)}>
        {modal.type === 'close-editor' ? <><p className="dialog-copy">“{editor?.name}” 有未保存的编辑。关闭后，这些更改将丢失。</p><div className="dialog-actions"><button type="button" className="button" onClick={() => setModal(null)}>继续编辑</button><button type="button" className="button" onClick={downloadDraft}><Download size={15} />下载草稿</button><button type="button" className="button danger" onClick={() => { setModal(null); setEditor(null); }}>放弃更改并关闭</button></div></>
          : <form className="form-stack" onSubmit={submitModal}>
            {modal.type === 'create' && <><p className="dialog-copy">位置：{root?.name} / {path || '根目录'}。同名项目不会被覆盖。</p><label>名称<input name="name" autoFocus required disabled={Boolean(busy)} placeholder={modal.kind === 'directory' ? '例如：world' : '例如：server.properties'} /></label></>}
            {modal.type === 'add-root' && <><p className="dialog-copy">注册本机已有目录的绝对路径。面板只会访问这些明确注册的目录。</p><label>显示名称<input name="name" autoFocus required disabled={Boolean(busy)} placeholder="例如：Minecraft 主目录" /></label><label>本机绝对路径<input name="path" required disabled={Boolean(busy)} placeholder="例如：/vol1/1000/minecraft" autoComplete="off" /></label><label className="checkbox-label"><input type="checkbox" name="readOnly" disabled={Boolean(busy)} />以只读模式注册</label><p className="field-hint">只读目录仍可浏览、下载及复制文件；不能修改内容。</p></>}
            {modal.type === 'remove-root' && <><p className="dialog-copy">从面板移除 <strong>{modal.root.name}</strong>？这只会取消目录注册，磁盘上的文件会保留。</p><code className="path-preview">{modal.root.path}</code></>}
            {modal.type === 'delete' && <><div className="destructive-notice"><AlertCircle size={20} /><p>将永久删除 <strong>{modal.entries.length}</strong> 个项目。文件夹内的内容也会被删除，此操作无法撤销。</p></div><ul className="delete-list">{modal.entries.map(entry => <li key={entry.path}>{entry.type === 'directory' ? <Folder size={15} /> : <FileIcon size={15} />}<span>{entry.name}</span></li>)}</ul><p className="field-hint">若部分删除失败，列表会刷新以显示实际结果。</p></>}
            {modal.type === 'compress' && <><p className="dialog-copy">将 <strong>{modal.entries.length}</strong> 个所选项目压缩到 {root?.name} / {path || '根目录'}。同名文件不会被覆盖。</p><label>归档名称<input name="name" autoFocus required disabled={Boolean(busy)} defaultValue={defaultArchiveName(modal.entries)} /></label></>}
            {modal.type === 'extract' && <><p className="dialog-copy">将 <strong>{modal.entry.name}</strong> 解压到 {root?.name} / {path || '根目录'}。</p><p className="field-hint">现有文件不会被覆盖；包含链接、特殊文件或越界路径的归档会被拒绝。</p></>}
            {dialogError && <div className="alert error" role="alert"><AlertCircle size={17} /><span>{dialogError}</span></div>}
            <div className="dialog-actions"><button type="button" className="button" disabled={Boolean(busy)} onClick={() => setModal(null)}>取消</button><button type="submit" className={`button ${modal.type === 'delete' ? 'danger' : 'primary'}`} disabled={Boolean(busy)}>
              {busy && <LoaderCircle className="spin" size={15} />}{busy || (modal.type === 'delete' ? `永久删除 ${modal.entries.length} 项` : modal.type === 'compress' ? '开始压缩' : modal.type === 'extract' ? '开始解压' : modal.type === 'remove-root' ? '移除注册' : modal.type === 'add-root' ? '注册目录' : '创建')}
            </button></div>
          </form>}
      </Dialog>}
    </div>
  );
}
