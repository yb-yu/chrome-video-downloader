// Retry with exponential backoff.

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  retryIf?(error: unknown): boolean;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 8000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw abortError();
    try {
      return await fn(attempt);
    } catch (err) {
      // Only the caller's signal proves this was a deliberate cancel. Browsers
      // may also surface transient network resets as AbortError.
      if (opts.signal?.aborted) throw abortError();
      lastErr = err;
      if (attempt === retries || opts.retryIf?.(err) === false) break;
      const delay = Math.min(max, base * 2 ** attempt);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export function isAbort(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    err.name === 'AbortError'
  );
}

export function describeError(err: unknown): string {
  let detail: string;
  if (typeof err === 'object' && err !== null) {
    const name = 'name' in err && typeof err.name === 'string' ? err.name : '';
    const message =
      'message' in err && typeof err.message === 'string' ? err.message : '';
    if (name && message) detail = `${name}: ${message}`;
    else if (message) detail = message;
    else if (name) detail = name;
    else detail = String(err);
  } else {
    detail = String(err);
  }
  return detail.replace(
    /\b(?:https?|blob|chrome-extension):\/\/[^\s"'<>]+/gi,
    '[redacted URL]',
  );
}
