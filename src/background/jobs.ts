// Download job persistence (chrome.storage.session), so progress survives
// service-worker restarts and is visible whenever the popup is opened.

import type { DownloadJob, DownloadJobPatch } from '../lib/types';

const PREFIX = 'job:';
const keyFor = (jobId: string) => `${PREFIX}${jobId}`;

export async function saveJob(job: DownloadJob): Promise<void> {
  job.updatedAt = Date.now();
  await chrome.storage.session.set({ [keyFor(job.jobId)]: job });
}

export async function getJob(jobId: string): Promise<DownloadJob | undefined> {
  const key = keyFor(jobId);
  const got = await chrome.storage.session.get(key);
  return got[key] as DownloadJob | undefined;
}

export async function getAllJobs(): Promise<DownloadJob[]> {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PREFIX))
    .map(([, v]) => v as DownloadJob);
}

export async function findJobByDownloadId(
  downloadId: number,
): Promise<DownloadJob | undefined> {
  const jobs = await getAllJobs();
  return jobs.find((j) => j.downloadId === downloadId);
}

export async function removeJob(jobId: string): Promise<void> {
  await chrome.storage.session.remove(keyFor(jobId));
}

/** Merge a patch reported by the offscreen engine. A canceled job is terminal. */
export async function applyJobPatch(jobId: string, patch: DownloadJobPatch): Promise<void> {
  const job = await getJob(jobId);
  if (!job || job.state === 'canceled') return;
  await saveJob(Object.assign(job, patch));
}
