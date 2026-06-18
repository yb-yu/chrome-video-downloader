// Assemble a precomputed list of segments (init first, then media in order)
// into a sink. Used for DASH, where segment URLs are derived from the MPD up
// front. Segments are plain byte fetches; DRM/CENC is out of scope.

import { forEachOrdered } from './ordered';
import { describeError, withRetry } from './retry';
import type { AssembleProgress, Bytes, ByteRange, SegmentSink } from './hls-assembler';
import type { SegmentRef } from './dash-segments';

export interface SegmentAssembleDeps {
  fetchBytes(url: string, range?: ByteRange): Promise<ArrayBuffer>;
  signal?: AbortSignal;
  concurrency?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryIf?(error: unknown): boolean;
  onProgress?(p: AssembleProgress): void;
}

export async function assembleSegments(
  init: SegmentRef | undefined,
  media: SegmentRef[],
  deps: SegmentAssembleDeps,
  sink: SegmentSink,
): Promise<void> {
  if (media.length === 0) {
    throw new Error('No segments to download.');
  }

  if (init) {
    const bytes = await withRetry(() => deps.fetchBytes(init.url, init.byteRange), {
      ...retryOptions(deps),
    });
    await sink.write(new Uint8Array(bytes));
  }

  const total = media.length;
  let bytesWritten = 0;
  let segmentsDone = 0;

  await forEachOrdered<Bytes>(
    total,
    async (i) => {
      const seg = media[i];
      try {
        const buf = await withRetry(() => deps.fetchBytes(seg.url, seg.byteRange), {
          ...retryOptions(deps),
        });
        return new Uint8Array(buf);
      } catch (err) {
        throw new Error(
          `Segment ${i + 1}/${media.length} failed: ${describeError(err)}`,
        );
      }
    },
    async (_i, bytes) => {
      await sink.write(bytes);
      bytesWritten += bytes.byteLength;
      segmentsDone++;
      deps.onProgress?.({ segmentsDone, segmentsTotal: total, bytesWritten });
    },
    { concurrency: deps.concurrency, signal: deps.signal },
  );
}

function retryOptions(deps: SegmentAssembleDeps) {
  return {
    signal: deps.signal,
    retries: deps.retries,
    baseDelayMs: deps.retryBaseDelayMs,
    maxDelayMs: deps.retryMaxDelayMs,
    retryIf: deps.retryIf,
  };
}
