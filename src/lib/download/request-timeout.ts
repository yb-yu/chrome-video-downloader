import { abortError } from './retry';

export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs / 1000}s`);
    this.name = 'RequestTimeoutError';
  }
}

export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (callerSignal.aborted) throw abortError();

  const timeoutController = new AbortController();
  const combined = AbortSignal.any([callerSignal, timeoutController.signal]);
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    return await operation(combined);
  } catch (err) {
    if (callerSignal.aborted) throw abortError();
    if (timeoutController.signal.aborted) throw new RequestTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
