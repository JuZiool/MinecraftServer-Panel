export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
}

export interface AuthSession {
  username: string;
  csrfToken: string;
}

export interface Root {
  id: string;
  name: string;
  path: string;
  readOnly: boolean;
  available: boolean;
  error?: string;
}

export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  modified: string;
  permissions: string;
}

export interface FileContent {
  content: string;
  revision: string;
}

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let csrfToken = '';
let onUnauthorized: () => void = () => {};

export function configureApi(token: string | undefined, unauthorized: () => void) {
  csrfToken = token ?? '';
  onUnauthorized = unauthorized;
}

function responseError(status: number, payload: unknown): ApiError {
  const data = payload && typeof payload === 'object'
    ? payload as { error?: unknown; code?: unknown }
    : {};
  return new ApiError(
    typeof data.error === 'string' ? data.error : `请求失败（HTTP ${status}）`,
    status,
    typeof data.code === 'string' ? data.code : undefined,
  );
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  publicRequest?: boolean;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && !options.publicRequest) {
    if (!csrfToken) throw new ApiError('会话验证信息缺失，请重新登录。', 403);
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, {
    method,
    headers,
    credentials: 'same-origin',
    signal: options.signal,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && !options.publicRequest) onUnauthorized();
    throw responseError(response.status, payload);
  }
  if (payload === null) throw new ApiError('服务器没有返回有效的 JSON 响应。', response.status);
  return payload as T;
}

export function fileUrl(action: 'list' | 'read' | 'upload' | 'download' | 'archive-download', rootId: string, path: string) {
  return `/api/files/${action}?${new URLSearchParams({ rootId, path })}`;
}

export function uploadFile(rootId: string, path: string, file: File, progress: (percent: number) => void, createParents = false): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!csrfToken) {
      reject(new ApiError('会话验证信息缺失，请重新登录。', 403));
      return;
    }
    const xhr = new XMLHttpRequest();
    const url = fileUrl('upload', rootId, path) + (createParents ? '&parents=1' : '');
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-CSRF-Token', csrfToken);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) progress(Math.round(event.loaded / event.total * 100));
    };
    xhr.onerror = () => reject(new ApiError('上传连接中断，请刷新目录确认文件状态。'));
    xhr.onabort = () => reject(new ApiError('上传已中止，请刷新目录确认文件状态。'));
    xhr.onload = () => {
      let payload: unknown = null;
      try { payload = JSON.parse(xhr.responseText); } catch { /* Report HTTP errors even without JSON. */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        progress(100);
        resolve();
      } else {
        if (xhr.status === 401) onUnauthorized();
        reject(responseError(xhr.status, payload));
      }
    };
    xhr.send(file);
  });
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.code) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : '操作失败，请稍后重试。';
}
