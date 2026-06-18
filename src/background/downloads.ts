// Progressive download orchestration.
//
// Local-only MP4/WebM files use chrome.downloads. Home-server destinations use
// the offscreen engine so the same source can be uploaded through WebDAV and,
// for the "both" mode, saved locally afterward.
//
// HLS/DASH streams that must be assembled are handled separately by the
// offscreen engine.

import type { DownloadRequest, DownloadJob, DownloadState } from '../lib/types';
import { findJobByDownloadId, getJob, saveJob } from './jobs';
import { onAssembleDownloadDone } from './assemble';
import { ensureOffscreen } from './offscreen';
import { loadStorageSettings, localDownloadPath } from '../lib/storage-settings';

export async function startDownload(req: DownloadRequest): Promise<DownloadJob> {
  const storage = await loadStorageSettings();
  if (storage.destination !== 'local') {
    return startProgressiveTransfer(req, storage);
  }

  const jobId = crypto.randomUUID();
  const now = Date.now();
  const job: DownloadJob = {
    jobId,
    url: req.url,
    filename: req.filename,
    mediaType: req.mediaType,
    engine: 'native',
    state: 'queued',
    receivedBytes: 0,
    startedAt: now,
    updatedAt: now,
  };
  await saveJob(job);

  try {
    const downloadId = await chrome.downloads.download({
      url: req.url,
      filename: localDownloadPath(storage.subfolder, req.filename),
      saveAs: false,
    });
    job.downloadId = downloadId;
    job.state = 'downloading';
    await saveJob(job);
    // Backfill total size if Chrome already knows it.
    void refreshFromItem(downloadId);
  } catch (err) {
    job.state = 'interrupted';
    job.error = err instanceof Error ? err.message : 'Failed to start download';
    await saveJob(job);
  }
  return job;
}

async function startProgressiveTransfer(
  req: DownloadRequest,
  storage: Awaited<ReturnType<typeof loadStorageSettings>>,
): Promise<DownloadJob> {
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const job: DownloadJob = {
    jobId,
    url: req.url,
    filename: req.filename,
    mediaType: req.mediaType,
    engine: 'transfer',
    state: 'queued',
    receivedBytes: 0,
    startedAt: now,
    updatedAt: now,
  };
  await saveJob(job);

  try {
    requireServerSettings(storage);
    if (req.mediaType !== 'mp4' && req.mediaType !== 'webm') {
      throw new Error('Only MP4 and WebM files can use the progressive transfer path.');
    }
    await ensureOffscreen();
    job.state = 'transferring';
    await saveJob(job);
    await chrome.runtime.sendMessage({
      kind: 'offscreen/progressive',
      job: {
        jobId,
        url: req.url,
        filename: req.filename,
        mediaType: req.mediaType,
        storage,
      },
    });
  } catch (err) {
    job.state = 'interrupted';
    job.error = err instanceof Error ? err.message : 'Failed to start transfer';
    await saveJob(job);
  }
  return job;
}

function requireServerSettings(
  storage: Awaited<ReturnType<typeof loadStorageSettings>>,
): void {
  if (!storage.serverUrl) throw new Error('Configure a WebDAV folder URL in Settings first.');
  if (!storage.username || !storage.password) {
    throw new Error('Configure WebDAV credentials in Settings first.');
  }
}

export async function cancelDownload(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;
  if (job.downloadId != null && (job.state === 'downloading' || job.state === 'queued')) {
    try {
      await chrome.downloads.cancel(job.downloadId);
    } catch {
      // already finished
    }
  }
  job.state = 'canceled';
  await saveJob(job);
}

/** Register chrome.downloads listeners. Call once at service-worker startup. */
export function registerDownloadListeners(): void {
  chrome.downloads.onChanged.addListener((delta) => {
    void onDownloadChanged(delta);
  });
}

async function onDownloadChanged(
  delta: chrome.downloads.DownloadDelta,
): Promise<void> {
  const job = await findJobByDownloadId(delta.id);
  if (!job) return;

  if (delta.state?.current) {
    job.state = mapState(delta.state.current);
  }
  if (delta.error?.current) {
    job.error = delta.error.current;
  }
  await saveJob(job);
  // Pull authoritative byte counts / final size from the item.
  await refreshFromItem(delta.id);

  // For assembled streams the saved file came from an OPFS scratch + object
  // URL; once the save terminates, free those resources.
  const fresh = await getJob(job.jobId);
  if (
    fresh &&
    fresh.engine !== 'native' &&
    (fresh.state === 'complete' ||
      fresh.state === 'interrupted' ||
      fresh.state === 'canceled')
  ) {
    await onAssembleDownloadDone(delta.id);
  }
}

async function refreshFromItem(downloadId: number): Promise<void> {
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) return;
  const job = await findJobByDownloadId(downloadId);
  if (!job) return;
  job.receivedBytes = item.bytesReceived;
  job.totalBytes = item.totalBytes > 0 ? item.totalBytes : job.totalBytes;
  // A user cancel is terminal; don't let a late item update revive it.
  if (job.state !== 'canceled') {
    job.state = mapState(item.state, job.state);
  }
  await saveJob(job);
}

function mapState(
  state: chrome.downloads.DownloadState | string,
  fallback: DownloadState = 'downloading',
): DownloadState {
  switch (state) {
    case 'in_progress':
      return 'downloading';
    case 'complete':
      return 'complete';
    case 'interrupted':
      return 'interrupted';
    default:
      return fallback;
  }
}
