// Assembly orchestration: drive the offscreen engine for segmented streams,
// then deliver the finished file to local storage and/or a WebDAV home server.

import type { AssembleRequest, DownloadJob, RuntimeMessage } from '../lib/types';
import { findJobByDownloadId, getJob, saveJob } from './jobs';
import { ensureOffscreen } from './offscreen';
import { loadStorageSettings, localDownloadPath } from '../lib/storage-settings';

// Keep segment traffic modest. Higher values are faster, but make CDN rate
// limits and automated-traffic detection substantially more likely.
const CONCURRENCY = 3;

export async function startAssemble(req: AssembleRequest): Promise<DownloadJob> {
  const jobId = crypto.randomUUID();
  const now = Date.now();
  const job: DownloadJob = {
    jobId,
    url: req.url,
    filename: req.filename,
    mediaType: req.mediaType,
    variantUri: req.variantUri,
    repId: req.repId,
    engine: 'assemble',
    state: 'queued',
    receivedBytes: 0,
    startedAt: now,
    updatedAt: now,
  };
  await saveJob(job);

  try {
    const storage = await loadStorageSettings();
    requireServerSettings(storage);
    console.log('[cvd] start assemble', jobId, req.mediaType);
    await ensureOffscreen();
    job.state = 'assembling';
    await saveJob(job);
    console.log('[cvd] offscreen ready, dispatching job', jobId);
    const msg: RuntimeMessage = {
      kind: 'offscreen/assemble',
      job: {
        jobId,
        url: req.url,
        filename: req.filename,
        mediaType: req.mediaType,
        concurrency: CONCURRENCY,
        storage,
        variantUri: req.variantUri,
        repId: req.repId,
      },
    };
    await chrome.runtime.sendMessage(msg);
  } catch (err) {
    job.state = 'interrupted';
    job.error = err instanceof Error ? err.message : 'Failed to start assembly';
    await saveJob(job);
  }
  return job;
}

function requireServerSettings(
  storage: Awaited<ReturnType<typeof loadStorageSettings>>,
): void {
  if (storage.destination === 'local') return;
  if (!storage.serverUrl) {
    throw new Error('Configure a WebDAV folder URL in Settings first.');
  }
  if (!storage.username || !storage.password) {
    throw new Error('Configure WebDAV credentials in Settings first.');
  }
}

export async function cancelAssemble(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  if (job.state === 'downloading' && job.downloadId != null) {
    try {
      await chrome.downloads.cancel(job.downloadId);
    } catch {
      /* already done */
    }
  } else {
    const msg: RuntimeMessage = { kind: 'offscreen/cancel', jobId };
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
  job.state = 'canceled';
  await saveJob(job);
}

/**
 * The offscreen document finished assembling and produced an object URL for
 * the completed (disk-backed) file. Save it to the user's chosen location.
 */
export async function onAssembled(
  jobId: string,
  blobUrl: string,
  ext: string,
): Promise<void> {
  const job = await getJob(jobId);
  if (!job || job.state === 'canceled') {
    cleanup(jobId);
    return;
  }
  try {
    job.filename = swapExtension(job.filename, ext);
    const { subfolder } = await loadStorageSettings();
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: localDownloadPath(subfolder, job.filename),
      saveAs: false,
    });
    job.downloadId = downloadId;
    job.state = 'downloading';
    await saveJob(job);
  } catch (err) {
    job.state = 'interrupted';
    job.error = err instanceof Error ? err.message : 'Failed to save file';
    await saveJob(job);
    cleanup(jobId);
  }
}

/** Replace the filename's extension with the actual produced one. */
function swapExtension(filename: string, ext: string): string {
  return `${filename.replace(/\.[a-z0-9]{1,5}$/i, '')}.${ext}`;
}

/** Free the object URL + OPFS scratch once the save terminates. */
function cleanup(jobId: string): void {
  const msg: RuntimeMessage = { kind: 'offscreen/cleanup', jobId };
  chrome.runtime.sendMessage(msg).catch(() => {});
}

/** Called from the chrome.downloads.onChanged handler for assemble jobs. */
export async function onAssembleDownloadDone(downloadId: number): Promise<void> {
  const job = await findJobByDownloadId(downloadId);
  if (job && job.engine !== 'native') cleanup(job.jobId);
}
