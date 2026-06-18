// Shared types across background / popup / content scripts.

export type MediaType = 'hls' | 'dash' | 'mp4' | 'webm' | 'blob';

/** A single detected media resource, scoped to the tab it was found in. */
export interface MediaItem {
  /** Stable id derived from url (+ tab). */
  id: string;
  tabId: number;
  url: string;
  type: MediaType;
  /** Response Content-Type when known (from response headers). */
  contentType?: string;
  /** Content-Length in bytes when known (progressive files). */
  sizeBytes?: number;
  /** Playback duration reported by the page or parsed from a manifest. */
  durationSec?: number;
  /** True when the URL is currently attached to a page <video>/<source>. */
  pageAttached?: boolean;
  /** URL of the page the media was detected on. */
  pageUrl?: string;
  /** Title of the page, for nicer file naming / display. */
  pageTitle?: string;
  /** How we found it. */
  source: 'active-tab';
  detectedAt: number;
}

// ---- Messaging contract -----------------------------------------------------

export type RuntimeMessage =
  | { kind: 'popup/list'; tabId: number }
  | { kind: 'popup/clear'; tabId: number }
  | { kind: 'download/start'; req: DownloadRequest }
  | { kind: 'download/retry'; jobId: string }
  | { kind: 'download/cancel'; jobId: string }
  | { kind: 'assemble/start'; req: AssembleRequest }
  // offscreen <-> service worker
  | { kind: 'offscreen/assemble'; job: AssembleJobSpec }
  | { kind: 'offscreen/progressive'; job: ProgressiveJobSpec }
  | { kind: 'offscreen/cancel'; jobId: string }
  | { kind: 'offscreen/assembled'; jobId: string; blobUrl: string; ext: string }
  | { kind: 'offscreen/cleanup'; jobId: string }
  // The offscreen document has no chrome.storage access, so it reports job
  // progress to the worker, which owns persistence.
  | { kind: 'offscreen/update'; jobId: string; patch: DownloadJobPatch };

/** Fields the offscreen engine may update on a job. */
export type DownloadJobPatch = Partial<
  Pick<
    DownloadJob,
    | 'state'
    | 'filename'
    | 'segmentsDone'
    | 'segmentsTotal'
    | 'receivedBytes'
    | 'totalBytes'
    | 'muxPercent'
    | 'error'
  >
>;

/** A request to download a single media URL. */
export interface DownloadRequest {
  url: string;
  filename: string;
  mediaType: MediaType;
}

/** A request to assemble a segmented stream (HLS/DASH) into one file. */
export interface AssembleRequest {
  /** The detected stream URL (HLS master or media playlist). */
  url: string;
  filename: string;
  mediaType: MediaType;
  /** Media-playlist URL of the chosen quality (HLS master variants). */
  variantUri?: string;
  /** Chosen video representation id (DASH). */
  repId?: string;
}

/** What the offscreen document needs to run an assembly job. */
export interface AssembleJobSpec {
  jobId: string;
  url: string;
  filename: string;
  mediaType: MediaType;
  concurrency: number;
  storage: import('./storage-settings').StorageSettings;
  variantUri?: string;
  repId?: string;
}

export interface ProgressiveJobSpec {
  jobId: string;
  url: string;
  filename: string;
  mediaType: 'mp4' | 'webm';
  storage: import('./storage-settings').StorageSettings;
}

export type DownloadState =
  | 'queued'
  | 'transferring'
  | 'assembling'
  | 'muxing'
  | 'uploading'
  | 'downloading'
  | 'complete'
  | 'interrupted'
  | 'canceled';

/** How the bytes reach disk: native chrome.downloads, or our assembler. */
export type DownloadEngine = 'native' | 'assemble' | 'transfer';

/** Tracked state of a download, persisted in chrome.storage.session. */
export interface DownloadJob {
  jobId: string;
  url: string;
  filename: string;
  mediaType: MediaType;
  /** Selected HLS variant URL, kept so failed jobs can be retried directly. */
  variantUri?: string;
  /** Selected DASH representation id, kept so failed jobs can be retried directly. */
  repId?: string;
  engine: DownloadEngine;
  state: DownloadState;
  receivedBytes: number;
  totalBytes?: number;
  /** Assembly progress (segmented streams). */
  segmentsDone?: number;
  segmentsTotal?: number;
  /** Muxing progress 0..100 (ffmpeg step). */
  muxPercent?: number;
  error?: string;
  /** chrome.downloads item id, once the final save has begun. */
  downloadId?: number;
  startedAt: number;
  updatedAt: number;
}

export interface ListResponse {
  items: MediaItem[];
}
