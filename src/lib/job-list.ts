import type { DownloadJob, DownloadState } from './types';

const ACTIVE_STATES = new Set<DownloadState>([
  'queued',
  'transferring',
  'assembling',
  'muxing',
  'uploading',
  'downloading',
]);

export function isActiveJob(job: DownloadJob): boolean {
  return ACTIVE_STATES.has(job.state);
}

export function canRetryJob(job: DownloadJob): boolean {
  return job.state === 'interrupted';
}

/** Keep every active job, but show repeated terminal attempts only once. */
export function collapseDuplicateJobs(jobs: DownloadJob[]): DownloadJob[] {
  const seenTerminal = new Set<string>();
  return jobs
    .slice()
    .sort((a, b) => b.startedAt - a.startedAt)
    .filter((job) => {
      if (isActiveJob(job)) return true;
      const key = [job.filename, job.mediaType, job.engine, job.state, job.error ?? ''].join('\n');
      if (seenTerminal.has(key)) return false;
      seenTerminal.add(key);
      return true;
    });
}
