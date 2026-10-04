export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) {
    throw new HttpError(400, `${name}格式不正确`);
  }
  return value;
}

export function paths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 200) {
    throw new HttpError(400, '请选择 1 至 200 个文件或文件夹');
  }
  return [...new Set(value.map(item => text(item, '文件路径')))];
}

// ponytail: serialize this process's mutations; external NAS clients remain independent.
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
