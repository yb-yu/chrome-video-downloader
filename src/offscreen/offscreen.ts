// Offscreen document: runs segmented-stream assembly + muxing off the
// (ephemeral) service worker.
//
// Pipeline per job:
//   1. fetch + parse the HLS playlist, plan video (+ optional separate audio)
//   2. assemble each track to an OPFS scratch file (bounded concurrency,
//      retry, AES-128 decrypt) — flat memory, even for multi-hour streams
//   3. produce the final file:
//        - separate audio  -> ffmpeg mux video+audio into MP4
//        - single track     -> ffmpeg remux (TS/fMP4 -> MP4)
//        - too large to mux  -> save the raw container as-is (avoids wasm OOM)
//   4. upload to a WebDAV home server, save locally through chrome.downloads,
//      or do both according to the user's storage setting

import { parseHls, type HlsPlaylist } from '../lib/hls';
import { parseDash } from '../lib/dash';
import {
  assembleHls,
  type AssembleDeps,
  type ByteRange,
  type SegmentSink,
} from '../lib/download/hls-assembler';
import { assembleSegments } from '../lib/download/segment-assembler';
import { buildDashSegments } from '../lib/download/dash-segments';
import { planHlsTracks } from '../lib/download/hls-plan';
import { planDashTracks } from '../lib/download/dash-plan';
import { abortError, describeError, withRetry } from '../lib/download/retry';
import { HttpStatusError, isRetryableHttpError } from '../lib/download/http';
import { withRequestTimeout } from '../lib/download/request-timeout';
import {
  basicAuthHeader,
  webDavFileUrl,
  webDavTempUrl,
} from '../lib/webdav';
import { muxToMp4, remuxToMp4, resetMuxer } from './muxer';
import type {
  AssembleJobSpec,
  DownloadJobPatch,
  ProgressiveJobSpec,
  RuntimeMessage,
} from '../lib/types';
import type { StorageSettings } from '../lib/storage-settings';

interface TrackResult {
  videoHandle: FileSystemFileHandle;
  audioHandle?: FileSystemFileHandle;
  /** Container extension when saving raw (no ffmpeg). */
  rawExt: string;
}

/** Above this combined track size, skip ffmpeg (which buffers output in
 * memory) and save the raw container instead. */
const MAX_MUX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB
const NETWORK_RETRIES = 3;
const MUX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 8000;
const REQUEST_TIMEOUT_MS = 30_000;

interface RunState {
  controller: AbortController;
  opfsNames: string[];
  blobUrl?: string;
}

interface OutputSpec {
  jobId: string;
  filename: string;
  storage: StorageSettings;
}

const runs = new Map<string, RunState>();
const updateChains = new Map<string, Promise<void>>();

chrome.runtime.onMessage.addListener((msg: RuntimeMessage) => {
  switch (msg.kind) {
    case 'offscreen/assemble':
      void runAssemble(msg.job);
      break;
    case 'offscreen/progressive':
      void runProgressive(msg.job);
      break;
    case 'offscreen/cancel':
      runs.get(msg.jobId)?.controller.abort();
      break;
    case 'offscreen/cleanup':
      void cleanup(msg.jobId);
      break;
  }
});

async function runAssemble(spec: AssembleJobSpec): Promise<void> {
  const controller = new AbortController();
  const state: RunState = { controller, opfsNames: [] };
  runs.set(spec.jobId, state);
  const signal = controller.signal;

  try {
    console.log('[cvd] assemble start', spec.jobId, spec.mediaType);
    const tracks =
      spec.mediaType === 'dash'
        ? await assembleDashTracks(spec, signal, state)
        : await assembleHlsTracks(spec, signal, state);

    if (signal.aborted) throw abortError();

    // Produce the output file.
    const videoFile = await tracks.videoHandle.getFile();
    const audioFile = tracks.audioHandle ? await tracks.audioHandle.getFile() : undefined;
    const totalBytes = videoFile.size + (audioFile?.size ?? 0);
    console.log(
      '[cvd] tracks assembled',
      { video: videoFile.size, audio: audioFile?.size ?? 0 },
      audioFile ? 'mux' : totalBytes > MAX_MUX_BYTES ? 'raw (too big)' : 'remux',
    );

    let ext: string;
    let output: Blob;
    if (audioFile) {
      await setState(spec.jobId, 'muxing');
      const out = await runMuxWithRetry(spec.jobId, () =>
        muxToMp4(videoFile, audioFile, (p) => setMuxPercent(spec.jobId, p)),
      );
      output = new Blob([out], { type: 'video/mp4' });
      ext = 'mp4';
    } else if (totalBytes > MAX_MUX_BYTES) {
      // Too big for in-memory ffmpeg output; keep the raw container.
      output = videoFile;
      ext = tracks.rawExt;
    } else {
      await setState(spec.jobId, 'muxing');
      const out = await runMuxWithRetry(spec.jobId, () =>
        remuxToMp4(videoFile, (p) => setMuxPercent(spec.jobId, p)),
      );
      output = new Blob([out], { type: 'video/mp4' });
      ext = 'mp4';
    }

    await deliverOutput(spec, output, ext, state, signal);
  } catch (err) {
    if (signal.aborted) {
      console.info('[cvd] assemble canceled', spec.jobId);
      await cleanup(spec.jobId);
      return;
    }
    const detail = describeError(err);
    console.warn('[cvd] assemble failed', spec.jobId, detail);
    await update(spec.jobId, {
      state: 'interrupted',
      error: detail,
    });
    await cleanup(spec.jobId);
  }
}

async function runMuxWithRetry<T>(jobId: string, run: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MUX_RETRIES; attempt += 1) {
    if (attempt > 0) {
      console.warn('[cvd] retrying mux', jobId, describeError(lastError));
      await update(jobId, { muxPercent: 0 });
      await resetMuxer();
    }
    try {
      return await run();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

async function runProgressive(spec: ProgressiveJobSpec): Promise<void> {
  const controller = new AbortController();
  const state: RunState = { controller, opfsNames: [] };
  runs.set(spec.jobId, state);
  const signal = controller.signal;

  try {
    const handle = await assembleToOpfs(
      `${spec.jobId}-source`,
      async (sink) => {
        const res = await fetchWithTimeout(spec.url, {
          signal,
          // See fetchText: omit cookies so wildcard-CORS CDNs aren't blocked.
          credentials: 'omit',
          cache: 'no-store',
        });
        if (!res.ok) throw new HttpStatusError(res.status, 'fetching source file');
        if (!res.body) throw new Error('Source response has no readable body.');
        const total = Number(res.headers.get('content-length')) || undefined;
        const reader = res.body.getReader();
        let received = 0;
        let lastProgress = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (signal.aborted) throw abortError();
          await sink.write(value);
          received += value.byteLength;
          const now = Date.now();
          if (now - lastProgress >= 250) {
            lastProgress = now;
            reportUpdate(spec.jobId, {
              state: 'transferring',
              receivedBytes: received,
              totalBytes: total,
            });
          }
        }
        await update(spec.jobId, {
          state: 'transferring',
          receivedBytes: received,
          totalBytes: total,
        });
      },
      state,
    );
    await deliverOutput(spec, await handle.getFile(), spec.mediaType, state, signal);
  } catch (err) {
    if (signal.aborted) {
      console.info('[cvd] progressive transfer canceled', spec.jobId);
      await cleanup(spec.jobId);
      return;
    }
    const detail = describeError(err);
    console.warn('[cvd] progressive transfer failed', spec.jobId, detail);
    await update(spec.jobId, { state: 'interrupted', error: detail });
    await cleanup(spec.jobId);
  }
}

async function deliverOutput(
  spec: OutputSpec,
  output: Blob,
  ext: string,
  state: RunState,
  signal: AbortSignal,
): Promise<void> {
  const filename = swapExtension(spec.filename, ext);
  const remote = spec.storage.destination !== 'local';
  const local = spec.storage.destination !== 'server';

  if (remote) {
    await update(spec.jobId, {
      state: 'uploading',
      filename,
      receivedBytes: 0,
      totalBytes: output.size,
    });
    await uploadToServer(spec, output, filename, signal);
  }

  if (!local) {
    await update(spec.jobId, {
      state: 'complete',
      filename,
      receivedBytes: output.size,
      totalBytes: output.size,
    });
    await cleanup(spec.jobId);
    return;
  }

  state.blobUrl = URL.createObjectURL(output);
  console.log('[cvd] output ready, handing off to local save', spec.jobId, ext);
  const msg: RuntimeMessage = {
    kind: 'offscreen/assembled',
    jobId: spec.jobId,
    blobUrl: state.blobUrl,
    ext,
  };
  await chrome.runtime.sendMessage(msg);
}

async function uploadToServer(
  spec: OutputSpec,
  output: Blob,
  filename: string,
  signal: AbortSignal,
): Promise<void> {
  const folderUrl = spec.storage.serverUrl;
  if (!folderUrl) throw new Error('WebDAV folder URL is not configured.');
  const authorization = basicAuthHeader(spec.storage.username, spec.storage.password);
  const tempUrl = webDavTempUrl(folderUrl, filename, spec.jobId);
  const finalUrl = webDavFileUrl(folderUrl, filename);

  await withRetry(
    async () => {
      await putBlob(tempUrl, output, filename, spec.jobId, authorization, signal);
    },
    {
      signal,
      retries: NETWORK_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      retryIf: isRetryableHttpError,
    },
  );

  const move = await fetch(tempUrl, {
    method: 'MOVE',
    signal,
    cache: 'no-store',
    headers: {
      Authorization: authorization,
      Destination: finalUrl,
      Overwrite: 'T',
    },
  });
  if (!move.ok) {
    await fetch(tempUrl, {
      method: 'DELETE',
      signal,
      headers: { Authorization: authorization },
    }).catch(() => {});
    throw new HttpStatusError(move.status, 'finalizing WebDAV upload');
  }
}

function putBlob(
  url: string,
  output: Blob,
  filename: string,
  jobId: string,
  authorization: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new XMLHttpRequest();
    const finish = (callback: () => void) => {
      signal.removeEventListener('abort', onSignalAbort);
      callback();
    };
    const onSignalAbort = () => xhr.abort();

    xhr.open('PUT', url);
    xhr.setRequestHeader('Authorization', authorization);
    xhr.setRequestHeader('Content-Type', contentTypeFor(filename));
    xhr.upload.onprogress = (event) => {
      reportUpdate(jobId, {
        state: 'uploading',
        receivedBytes: event.loaded,
        totalBytes: event.lengthComputable ? event.total : output.size,
      });
    };
    xhr.onload = () => {
      finish(() => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new HttpStatusError(xhr.status, 'uploading to WebDAV'));
      });
    };
    xhr.onerror = () => finish(() => reject(new TypeError('WebDAV upload failed.')));
    xhr.onabort = () => finish(() => reject(abortError()));
    signal.addEventListener('abort', onSignalAbort, { once: true });
    xhr.send(output);
  });
}

function contentTypeFor(filename: string): string {
  if (/\.webm$/i.test(filename)) return 'video/webm';
  if (/\.ts$/i.test(filename)) return 'video/mp2t';
  return 'video/mp4';
}

function swapExtension(filename: string, ext: string): string {
  return `${filename.replace(/\.[a-z0-9]{1,5}$/i, '')}.${ext}`;
}

async function assembleHlsTracks(
  spec: AssembleJobSpec,
  signal: AbortSignal,
  state: RunState,
): Promise<TrackResult> {
  const baseDeps: AssembleDeps = {
    signal,
    concurrency: spec.concurrency,
    retries: NETWORK_RETRIES,
    retryBaseDelayMs: RETRY_BASE_DELAY_MS,
    retryMaxDelayMs: RETRY_MAX_DELAY_MS,
    retryIf: isRetryableHttpError,
    fetchText: (url) => fetchText(url, signal),
    fetchBytes: (url, range) => fetchBytes(url, range, signal),
  };

  const text = await fetchManifestText(spec.url, signal);
  const playlist = parseHls(text, spec.url);
  const plan = planHlsTracks(spec.url, playlist, spec.variantUri);
  console.log('[cvd] hls plan ready', {
    separateAudio: Boolean(plan.audioUrl),
  });

  const videoHandle = await assembleToOpfs(
    `${spec.jobId}-v`,
    (sink) =>
      assembleHls(plan.videoUrl, { ...baseDeps, onProgress: progressReporter(spec.jobId) }, sink),
    state,
  );
  const audioHandle = plan.audioUrl
    ? await assembleToOpfs(
        `${spec.jobId}-a`,
        (sink) => assembleHls(plan.audioUrl!, baseDeps, sink),
        state,
      )
    : undefined;

  return { videoHandle, audioHandle, rawExt: rawExtForHls(playlist) };
}

async function assembleDashTracks(
  spec: AssembleJobSpec,
  signal: AbortSignal,
  state: RunState,
): Promise<TrackResult> {
  const fetchBytesS = (url: string, range?: ByteRange) => fetchBytes(url, range, signal);
  const text = await fetchManifestText(spec.url, signal);
  const manifest = parseDash(text, spec.url);
  const plan = planDashTracks(manifest, spec.repId);

  const video = buildDashSegments(text, spec.url, plan.videoRepId);
  console.log('[cvd] dash plan ready', {
    separateAudio: Boolean(plan.audioRepId),
    videoSegments: video.media.length,
  });
  const videoHandle = await assembleToOpfs(
    `${spec.jobId}-v`,
    (sink) =>
      assembleSegments(video.init, video.media, {
        fetchBytes: fetchBytesS,
        signal,
        concurrency: spec.concurrency,
        retries: NETWORK_RETRIES,
        retryBaseDelayMs: RETRY_BASE_DELAY_MS,
        retryMaxDelayMs: RETRY_MAX_DELAY_MS,
        retryIf: isRetryableHttpError,
        onProgress: progressReporter(spec.jobId),
      }, sink),
    state,
  );

  let audioHandle: FileSystemFileHandle | undefined;
  if (plan.audioRepId) {
    const audio = buildDashSegments(text, spec.url, plan.audioRepId);
    audioHandle = await assembleToOpfs(
      `${spec.jobId}-a`,
      (sink) =>
        assembleSegments(audio.init, audio.media, {
          fetchBytes: fetchBytesS,
          signal,
          concurrency: spec.concurrency,
          retries: NETWORK_RETRIES,
          retryBaseDelayMs: RETRY_BASE_DELAY_MS,
          retryMaxDelayMs: RETRY_MAX_DELAY_MS,
          retryIf: isRetryableHttpError,
        }, sink),
      state,
    );
  }

  // DASH segments are fragmented MP4; the raw container is .mp4.
  return { videoHandle, audioHandle, rawExt: 'mp4' };
}

async function assembleToOpfs(
  name: string,
  run: (sink: SegmentSink) => Promise<void>,
  state: RunState,
): Promise<FileSystemFileHandle> {
  state.opfsNames.push(name);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await run({
      write: async (bytes) => {
        try {
          await writable.write(bytes);
        } catch (err) {
          throw new Error(`Temporary file write failed: ${describeError(err)}`);
        }
      },
    });
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    throw err;
  }
  return handle;
}

function rawExtForHls(playlist: HlsPlaylist): string {
  return playlist.kind === 'media' && playlist.map ? 'mp4' : 'ts';
}

async function cleanup(jobId: string): Promise<void> {
  const state = runs.get(jobId);
  runs.delete(jobId);
  if (state?.blobUrl) URL.revokeObjectURL(state.blobUrl);
  const names = state?.opfsNames ?? [`${jobId}-v`, `${jobId}-a`];
  const root = await navigator.storage.getDirectory();
  for (const name of names) {
    await root.removeEntry(name).catch(() => {});
  }
}

// --- progress reporting -----------------------------------------------------
//
// The offscreen document has no chrome.storage access, so all job updates go
// to the service worker (which persists them) via runtime messaging.

function update(jobId: string, patch: DownloadJobPatch): Promise<void> {
  const previous = updateChains.get(jobId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const msg: RuntimeMessage = { kind: 'offscreen/update', jobId, patch };
      await chrome.runtime.sendMessage(msg);
    });
  updateChains.set(jobId, next);
  void next.finally(() => {
    if (updateChains.get(jobId) === next) updateChains.delete(jobId);
  }).catch(() => {});
  return next;
}

function reportUpdate(jobId: string, patch: DownloadJobPatch): void {
  void update(jobId, patch).catch((err) => {
    console.warn('[cvd] progress update failed', jobId, describeError(err));
  });
}

function progressReporter(jobId: string) {
  let last = 0;
  return (p: { segmentsDone: number; segmentsTotal: number; bytesWritten: number }) => {
    const now = Date.now();
    const finished = p.segmentsDone === p.segmentsTotal;
    if (!finished && now - last < 250) return;
    last = now;
    reportUpdate(jobId, {
      state: 'assembling',
      segmentsDone: p.segmentsDone,
      segmentsTotal: p.segmentsTotal,
      receivedBytes: p.bytesWritten,
    });
  };
}

async function setState(jobId: string, stateName: 'muxing'): Promise<void> {
  await update(jobId, { state: stateName, muxPercent: 0 });
}

let lastMux = 0;
function setMuxPercent(jobId: string, percent: number): void {
  const now = Date.now();
  if (percent < 100 && now - lastMux < 250) return;
  lastMux = now;
  reportUpdate(jobId, { muxPercent: percent });
}

// --- fetch helpers ----------------------------------------------------------

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  return withRequestTimeout(
    async (requestSignal) => {
      const res = await fetch(url, {
        signal: requestSignal,
        // Media CDNs answer with `Access-Control-Allow-Origin: *`, which the
        // browser rejects for credentialed requests — so omit cookies. These
        // streams authorize via signed/token URLs, not cookies.
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!res.ok) throw new HttpStatusError(res.status, 'fetching playlist');
      return res.text();
    },
    signal,
    REQUEST_TIMEOUT_MS,
  );
}

async function fetchBytes(
  url: string,
  range: ByteRange | undefined,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const headers = range
    ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
    : undefined;
  return withRequestTimeout(
    async (requestSignal) => {
      const res = await fetch(url, {
        headers,
        signal: requestSignal,
        // Media CDNs answer with `Access-Control-Allow-Origin: *`, which the
        // browser rejects for credentialed requests — so omit cookies. These
        // streams authorize via signed/token URLs, not cookies.
        credentials: 'omit',
        cache: 'no-store',
      });
      if (!res.ok && res.status !== 206) {
        throw new HttpStatusError(res.status, 'fetching segment');
      }
      return res.arrayBuffer();
    },
    signal,
    REQUEST_TIMEOUT_MS,
  );
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { signal: AbortSignal },
): Promise<Response> {
  return withRequestTimeout(
    (requestSignal) => fetch(url, { ...init, signal: requestSignal }),
    init.signal,
    REQUEST_TIMEOUT_MS,
  );
}

async function fetchManifestText(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await withRetry(() => fetchText(url, signal), {
      signal,
      retries: NETWORK_RETRIES,
      baseDelayMs: RETRY_BASE_DELAY_MS,
      maxDelayMs: RETRY_MAX_DELAY_MS,
      retryIf: isRetryableHttpError,
    });
  } catch (err) {
    throw new Error(`Manifest request failed: ${describeError(err)}`);
  }
}
