// Assemble an HLS variant into a single byte stream, written in order to a
// sink (a File System Access writable in the offscreen document).
//
// Network + storage are injected as `deps`; container conversion and audio
// muxing are handled by the offscreen muxer.

import { parseHls, type HlsKey, type HlsMediaPlaylist } from '../hls';
import {
  decryptAes128Cbc,
  hexToBytes,
  importAes128Key,
  ivFromSequence,
} from './crypto';
import { forEachOrdered } from './ordered';
import { describeError, withRetry } from './retry';

export interface ByteRange {
  offset: number;
  length: number;
}

export interface AssembleDeps {
  fetchText(url: string): Promise<string>;
  fetchBytes(url: string, range?: ByteRange): Promise<ArrayBuffer>;
  signal?: AbortSignal;
  concurrency?: number;
  retries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryIf?(error: unknown): boolean;
  onProgress?(p: AssembleProgress): void;
}

export interface AssembleProgress {
  segmentsDone: number;
  segmentsTotal: number;
  bytesWritten: number;
}

/** Disk-backed byte chunks (ArrayBuffer-backed, so they satisfy BufferSource). */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface SegmentSink {
  write(bytes: Bytes): Promise<void>;
}

export async function assembleHls(
  mediaPlaylistUrl: string,
  deps: AssembleDeps,
  sink: SegmentSink,
): Promise<void> {
  const playlist = await loadMediaPlaylist(mediaPlaylistUrl, deps);
  if (playlist.isLive) {
    throw new Error('Live streams are not supported for download.');
  }
  if (playlist.segments.length === 0) {
    throw new Error('No segments found in the playlist.');
  }

  // Initialization segment (fMP4) goes first, unencrypted.
  if (playlist.map?.uri) {
    const init = await withRetry(
      () => deps.fetchBytes(playlist.map!.uri, playlist.map!.byteRange),
      retryOptions(deps),
    );
    await sink.write(new Uint8Array(init));
  }

  const keyCache = new Map<string, Promise<CryptoKey>>();
  const total = playlist.segments.length;
  let bytesWritten = 0;
  let segmentsDone = 0;

  await forEachOrdered<Bytes>(
    total,
    (i) => produceSegment(i, playlist, deps, keyCache),
    async (_i, bytes) => {
      await sink.write(bytes);
      bytesWritten += bytes.byteLength;
      segmentsDone++;
      deps.onProgress?.({ segmentsDone, segmentsTotal: total, bytesWritten });
    },
    { concurrency: deps.concurrency, signal: deps.signal },
  );
}

async function loadMediaPlaylist(
  url: string,
  deps: AssembleDeps,
): Promise<HlsMediaPlaylist> {
  const text = await withRetry(() => deps.fetchText(url), {
    ...retryOptions(deps),
  });
  const parsed = parseHls(text, url);
  if (parsed.kind === 'media') return parsed;

  // Given a master by mistake: follow the highest-bandwidth variant.
  const best = parsed.variants[0];
  if (!best) throw new Error('Master playlist has no variants.');
  return loadMediaPlaylist(best.uri, deps);
}

async function produceSegment(
  i: number,
  playlist: HlsMediaPlaylist,
  deps: AssembleDeps,
  keyCache: Map<string, Promise<CryptoKey>>,
): Promise<Bytes> {
  const seg = playlist.segments[i];
  try {
    return await withRetry(async () => {
      const raw = await deps.fetchBytes(seg.uri, seg.byteRange);

      if (!seg.key || seg.key.method === 'NONE') {
        return new Uint8Array(raw);
      }
      if (seg.key.method !== 'AES-128') {
        throw new Error(`Unsupported encryption method: ${seg.key.method}`);
      }

      const key = await getKey(seg.key, deps, keyCache);
      const iv = seg.key.iv
        ? hexToBytes(seg.key.iv)
        : ivFromSequence(playlist.mediaSequence + i);
      try {
        const decrypted = await decryptAes128Cbc(raw, key, iv);
        return new Uint8Array(decrypted);
      } catch (err) {
        throw new Error(`Failed to decrypt: ${describeError(err)}`);
      }
    }, retryOptions(deps));
  } catch (err) {
    throw new Error(
      `Segment ${i + 1}/${playlist.segments.length} failed: ${describeError(err)}`,
    );
  }
}

function getKey(
  key: HlsKey,
  deps: AssembleDeps,
  cache: Map<string, Promise<CryptoKey>>,
): Promise<CryptoKey> {
  const uri = key.uri;
  if (!uri) return Promise.reject(new Error('AES-128 key has no URI.'));
  let pending = cache.get(uri);
  if (!pending) {
    pending = withRetry(() => deps.fetchBytes(uri), {
      ...retryOptions(deps),
    }).then((buf) => importAes128Key(buf));
    cache.set(uri, pending);
  }
  return pending;
}

function retryOptions(deps: AssembleDeps) {
  return {
    signal: deps.signal,
    retries: deps.retries,
    baseDelayMs: deps.retryBaseDelayMs,
    maxDelayMs: deps.retryMaxDelayMs,
    retryIf: deps.retryIf,
  };
}
