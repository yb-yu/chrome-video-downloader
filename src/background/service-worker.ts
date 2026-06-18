// Background service worker for detection and job orchestration.
//
// Responsibilities:
//   * Scan the active tab when the popup is opened.
//   * Maintain a per-tab registry (in chrome.storage.session).
//   * Answer popup queries.
//
// Long-running downloads and muxing run in an offscreen document so they
// survive service worker suspension.

import type { DownloadJob, ListResponse, RuntimeMessage } from '../lib/types';
import { clearTab, getItems } from './registry';
import { cancelDownload, registerDownloadListeners, startDownload } from './downloads';
import { cancelAssemble, onAssembled, startAssemble } from './assemble';
import { applyJobPatch, getJob, removeJob } from './jobs';
import { rescanTab } from './rescan';
import { registerNetworkSniffer } from './sniffer';
import { prepareMediaReferrers } from './referrer';
import { restrictStorageSettingsAccess } from '../lib/storage-settings';

registerDownloadListeners();
registerNetworkSniffer();
void restrictStorageSettingsAccess();

// --- Messages from popup and offscreen document -----------------------------

chrome.runtime.onMessage.addListener(
  (msg: RuntimeMessage, _sender, sendResponse) => {
    if (msg.kind === 'popup/list') {
      // Don't clear here: the real-time sniffer accumulates detections while
      // the popup is closed, and the popup polls this every few seconds. The
      // sniffer drops stale media on top-level navigation instead.
      rescanTab(msg.tabId)
        .then(() => getItems(msg.tabId))
        .then(async (items) => {
          // Extension-page fetches don't inherit the tab's Referer; some CDNs
          // reject those with 403. Restore the page Referer before the popup
          // fetches manifests/segments. Needs host access (granted on download).
          await prepareMediaReferrers(items).catch(() => {
            console.warn('[cvd] failed to prepare media Referer rules');
          });
          const res: ListResponse = { items };
          sendResponse(res);
        });
      return true; // async response
    }

    if (msg.kind === 'popup/clear') {
      clearTab(msg.tabId).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.kind === 'download/start') {
      startDownload(msg.req).then((job) => sendResponse({ job }));
      return true;
    }

    if (msg.kind === 'download/retry') {
      retryJob(msg.jobId).then((job) => sendResponse({ job }));
      return true;
    }

    if (msg.kind === 'assemble/start') {
      startAssemble(msg.req).then((job) => sendResponse({ job }));
      return true;
    }

    if (msg.kind === 'download/cancel') {
      cancelJob(msg.jobId).then(() => sendResponse({ ok: true }));
      return true;
    }

    if (msg.kind === 'offscreen/assembled') {
      void onAssembled(msg.jobId, msg.blobUrl, msg.ext);
      return undefined;
    }

    if (msg.kind === 'offscreen/update') {
      applyJobPatch(msg.jobId, msg.patch).then(() => sendResponse({ ok: true }));
      return true;
    }

    return undefined;
  },
);

async function retryJob(jobId: string): Promise<DownloadJob | undefined> {
  const job = await getJob(jobId);
  if (!job || job.state !== 'interrupted') return job;

  const next =
    job.engine === 'assemble'
      ? await startAssemble({
          url: job.url,
          filename: job.filename,
          mediaType: job.mediaType,
          variantUri: job.variantUri,
          repId: job.repId,
        })
      : await startDownload({
          url: job.url,
          filename: job.filename,
          mediaType: job.mediaType,
        });
  await removeJob(jobId);
  return next;
}

async function cancelJob(jobId: string): Promise<void> {
  const job = await getJob(jobId);
  if (job && job.engine !== 'native') {
    await cancelAssemble(jobId);
  } else {
    await cancelDownload(jobId);
  }
}

// --- Lifecycle: clear stale detections --------------------------------------

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTab(tabId);
});
