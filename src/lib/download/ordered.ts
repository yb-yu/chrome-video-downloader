// Windowed, bounded-concurrency producer/consumer.
//
// `produce(i)` runs in parallel (up to `concurrency`) but `consume(i, value)`
// is always invoked strictly in index order 0,1,2,…  A sliding `window` caps
// how far production may run ahead of consumption, which bounds memory when a
// slow early item would otherwise let many later items pile up in the buffer.
//
// This is the core of streaming assembly: fetch many segments at once, but
// write them to disk in order without holding the whole file in memory.

import { abortError } from './retry';

export interface OrderedOptions {
  concurrency?: number;
  window?: number;
  signal?: AbortSignal;
}

export function forEachOrdered<T>(
  count: number,
  produce: (i: number) => Promise<T>,
  consume: (i: number, value: T) => Promise<void>,
  opts: OrderedOptions = {},
): Promise<void> {
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const window = Math.max(concurrency, opts.window ?? concurrency * 2);
  const signal = opts.signal;

  return new Promise<void>((resolve, reject) => {
    if (count <= 0) return resolve();

    const buffer = new Map<number, T>();
    let nextProduce = 0;
    let nextConsume = 0;
    let active = 0;
    let draining = false;
    let settled = false;

    const onAbort = () => fail(abortError());
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    function fail(err: unknown): void {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    }

    function done(): void {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      while (!settled && buffer.has(nextConsume)) {
        const value = buffer.get(nextConsume) as T;
        buffer.delete(nextConsume);
        try {
          await consume(nextConsume, value);
        } catch (err) {
          draining = false;
          return fail(err);
        }
        nextConsume++;
        if (nextConsume === count) {
          draining = false;
          return done();
        }
      }
      draining = false;
      pump();
    }

    function pump(): void {
      if (settled) return;
      while (
        active < concurrency &&
        nextProduce < count &&
        nextProduce - nextConsume < window
      ) {
        const i = nextProduce++;
        active++;
        Promise.resolve()
          .then(() => produce(i))
          .then((value) => {
            active--;
            if (settled) return;
            buffer.set(i, value);
            void drain();
          })
          .catch((err) => {
            active--;
            fail(err);
          });
      }
    }

    pump();
  });
}
