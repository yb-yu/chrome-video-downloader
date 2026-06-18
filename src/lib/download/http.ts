export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    operation: string,
  ) {
    const caution =
      status === 403
        ? ' Access was denied; stopped without retrying.'
        : status === 429
          ? ' Rate limit reached; stopped without retrying.'
          : '';
    super(`HTTP ${status} ${operation}.${caution}`);
    this.name = 'HttpStatusError';
  }
}

/** Retry transient network/server failures, but do not hammer on client errors. */
export function isRetryableHttpError(error: unknown): boolean {
  if (!(error instanceof HttpStatusError)) return true;
  return error.status === 408 || error.status >= 500;
}
