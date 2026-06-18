// ffmpeg.wasm wrapper for the mux/remux step.
//
// Inputs are mounted via WORKERFS, which reads the (disk-backed OPFS) blobs
// lazily instead of copying them into wasm memory — important for large
// streams. The single output MP4 still lives in MEMFS and is read back into
// memory, so output size remains the practical ceiling. All operations
// stream-copy, so there is no re-encoding.

import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg';
import { buildMuxArgs, buildRemuxArgs } from '../lib/mux/args';

const IN_DIR = '/in';
const OUT = '/out.mp4';

let loadPromise: Promise<FFmpeg> | undefined;
let queue: Promise<void> = Promise.resolve();

export function isMuxerLoaded(): boolean {
  return loadPromise !== undefined;
}

export async function resetMuxer(): Promise<void> {
  await enqueue(async () => {
    const current = loadPromise;
    loadPromise = undefined;
    if (!current) return;
    try {
      (await current).terminate();
    } catch {
      // A wedged wasm worker should not block the retry path.
    }
  });
}

async function getFFmpeg(): Promise<FFmpeg> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const ff = new FFmpeg();
      const coreURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.js');
      const wasmURL = chrome.runtime.getURL('ffmpeg/ffmpeg-core.wasm');
      console.log('[cvd] ffmpeg loading');
      // Load the packaged core directly by extension URL. The offscreen page's
      // CSP allows `'self'` scripts (covers chrome-extension:// resources) and
      // `'wasm-unsafe-eval'` for WebAssembly — see manifest content_security_policy.
      // A blob: URL would be blocked by script-src, so we avoid toBlobURL here.
      await ff.load({ coreURL, wasmURL });
      console.log('[cvd] ffmpeg loaded');
      return ff;
    })().catch((err: unknown) => {
      // A rejected promise would otherwise poison every later mux attempt for
      // the lifetime of this offscreen document.
      loadPromise = undefined;
      throw err;
    });
  }
  return loadPromise;
}

export type MuxProgress = (percent: number) => void;

/** Remux a single (typically MPEG-TS) track into MP4. */
export async function remuxToMp4(
  video: Blob,
  onProgress?: MuxProgress,
): Promise<Uint8Array<ArrayBuffer>> {
  return enqueue(() =>
    run([{ name: 'video', data: video }], buildRemuxArgs(`${IN_DIR}/video`, OUT), onProgress),
  );
}

/** Mux separate video + audio tracks into a single MP4. */
export async function muxToMp4(
  video: Blob,
  audio: Blob,
  onProgress?: MuxProgress,
): Promise<Uint8Array<ArrayBuffer>> {
  return enqueue(() =>
    run(
      [
        { name: 'video', data: video },
        { name: 'audio', data: audio },
      ],
      buildMuxArgs(`${IN_DIR}/video`, `${IN_DIR}/audio`, OUT),
      onProgress,
    ),
  );
}

async function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
  }
}

async function run(
  blobs: { name: string; data: Blob }[],
  args: string[],
  onProgress?: MuxProgress,
): Promise<Uint8Array<ArrayBuffer>> {
  const ff = await getFFmpeg();
  const progress = onProgress
    ? ({ progress }: { progress: number }) =>
        onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))))
    : undefined;
  if (progress) ff.on('progress', progress);

  await ff.createDir(IN_DIR).catch(() => {});
  await ff.mount(FFFSType.WORKERFS, { blobs }, IN_DIR);
  try {
    console.log('[cvd] ffmpeg exec');
    const code = await ff.exec(args);
    console.log('[cvd] ffmpeg exec done, code', code);
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}`);
    }
    const data = await ff.readFile(OUT);
    if (typeof data === 'string') throw new Error('Unexpected ffmpeg text output');
    // MEMFS readFile returns an ArrayBuffer-backed view; assert it as such so
    // it satisfies BlobPart without an extra copy.
    return data as Uint8Array<ArrayBuffer>;
  } finally {
    if (progress) ff.off('progress', progress);
    await ff.deleteFile(OUT).catch(() => {});
    await ff.unmount(IN_DIR).catch(() => {});
    await ff.deleteDir(IN_DIR).catch(() => {});
  }
}
