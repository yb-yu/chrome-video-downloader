// Popup UI for detected media, quality selection, downloads, and storage
// settings.

import { labelForType } from '../lib/media';
import { parseHls } from '../lib/hls';
import { parseDash } from '../lib/dash';
import { sanitizeFilename } from '../lib/filename';
import { collapseRelatedMedia, mediaSizeBytes } from '../lib/media-list';
import { canRetryJob, collapseDuplicateJobs, isActiveJob } from '../lib/job-list';
import {
  loadStorageSettings,
  saveStorageSettings,
  type StorageDestination,
} from '../lib/storage-settings';
import { basicAuthHeader, normalizeWebDavUrl } from '../lib/webdav';
import {
  describeHls,
  describeDash,
  formatDuration,
  type DisplayVariant,
  type StreamSummary,
} from '../lib/variants';
import type {
  AssembleRequest,
  DownloadJob,
  DownloadRequest,
  ListResponse,
  MediaItem,
  RuntimeMessage,
} from '../lib/types';

const listEl = document.getElementById('list') as HTMLUListElement;
const emptyEl = document.getElementById('empty') as HTMLParagraphElement;
const clearEl = document.getElementById('clear') as HTMLButtonElement;
const jobsEl = document.getElementById('jobs') as HTMLElement;
const joblistEl = document.getElementById('joblist') as HTMLUListElement;
const settingsToggleEl = document.getElementById('settings-toggle') as HTMLButtonElement;
const settingsEl = document.getElementById('settings') as HTMLElement;
const destinationEl = document.getElementById('storage-destination') as HTMLSelectElement;
const subfolderEl = document.getElementById('local-subfolder') as HTMLInputElement;
const serverSettingsEl = document.getElementById('server-settings') as HTMLElement;
const serverUrlEl = document.getElementById('server-url') as HTMLInputElement;
const serverUsernameEl = document.getElementById('server-username') as HTMLInputElement;
const serverPasswordEl = document.getElementById('server-password') as HTMLInputElement;
const serverTestEl = document.getElementById('server-test') as HTMLButtonElement;
const settingsSaveEl = document.getElementById('settings-save') as HTMLButtonElement;
const settingsStatusEl = document.getElementById('settings-status') as HTMLParagraphElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

/** Cache of parsed stream summaries + the user's selection, keyed by item id. */
const summaries = new Map<string, StreamSummary>();
const selection = new Map<string, string>(); // itemId -> variant.key
const expanded = new Set<string>();
let currentItems: MediaItem[] = [];
// URLs with an in-progress job; hidden from the detection list so a download
// in progress isn't also offered as a fresh target.
let activeJobUrls = new Set<string>();
let loadGeneration = 0;

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  const tabId = await activeTabId();
  if (tabId == null) return;
  await hydrateSummaries();
  const msg: RuntimeMessage = { kind: 'popup/list', tabId };
  const res = (await chrome.runtime.sendMessage(msg)) as ListResponse | undefined;
  const items = res?.items ?? [];
  if (generation !== loadGeneration) return;
  currentItems = collapseRelatedMedia(items, summaries);
  render(currentItems);
  void enrichSummaries(items, generation);
}

// Pre-parse detected stream manifests so estimated sizes show and master/
// variant duplicates collapse without the user expanding each row. Needs host
// access (so it can't run on a clean install before the first download) and
// reuses loadSummary's per-item cache, so each manifest is fetched only once.
async function enrichSummaries(items: MediaItem[], generation: number): Promise<void> {
  const pending = items.filter(
    (item) => (item.type === 'hls' || item.type === 'dash') && !summaries.has(item.id),
  );
  if (pending.length === 0 || !(await hasHostAccess())) return;
  await Promise.all(pending.map((item) => loadSummary(item)));
  if (generation !== loadGeneration) return;
  currentItems = collapseRelatedMedia(items, summaries);
  render(currentItems);
}

// Parsed summaries live only for the lifetime of one popup document, so each
// reopen would re-parse and briefly show the un-collapsed list. Cache them in
// session storage (cleared when the browser closes) so a reopen renders the
// collapsed list immediately. Only successful parses are cached, so a manifest
// that failed once is retried next time.
const SUMMARY_CACHE_KEY = 'streamSummaries';
let summariesHydrated = false;

async function hydrateSummaries(): Promise<void> {
  if (summariesHydrated) return;
  summariesHydrated = true;
  const got = await chrome.storage.session.get(SUMMARY_CACHE_KEY);
  const cached = got[SUMMARY_CACHE_KEY] as Record<string, StreamSummary> | undefined;
  if (!cached) return;
  for (const [id, summary] of Object.entries(cached)) {
    if (!summaries.has(id)) summaries.set(id, summary);
  }
}

function persistSummaries(): void {
  void chrome.storage.session.set({
    [SUMMARY_CACHE_KEY]: Object.fromEntries(summaries),
  });
}

function render(items: MediaItem[]): void {
  const targets = items.filter((item) => !activeJobUrls.has(item.url));
  listEl.replaceChildren();
  emptyEl.classList.toggle('hidden', targets.length > 0);
  targets
    .slice()
    .sort((a, b) => {
      const sizeDiff =
        mediaSizeBytes(b, summaries.get(b.id), selection.get(b.id)) -
        mediaSizeBytes(a, summaries.get(a.id), selection.get(a.id));
      // detectedAt is regenerated on every rescan (popup/list clears the tab
      // and re-scans), so it shuffles the list between refreshes. Fall back to
      // the URL for a stable, deterministic order instead.
      return sizeDiff || a.url.localeCompare(b.url);
    })
    .forEach((item) => listEl.appendChild(renderItem(item)));
}

function renderItem(item: MediaItem): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'item';

  const row = document.createElement('div');
  row.className = 'row';

  const meta = document.createElement('div');
  meta.className = 'meta';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.pageTitle || filenameFromUrl(item.url) || labelForType(item.type);
  title.title = item.url;

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = subtitle(item);
  sub.title = item.url;

  meta.append(title, sub);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = item.type;

  row.append(meta, badge);

  const isStream = item.type === 'hls' || item.type === 'dash';
  if (isStream) {
    const toggle = document.createElement('button');
    toggle.className = 'ghost toggle';
    toggle.textContent = expanded.has(item.id) ? '▾' : '▸';
    toggle.title = 'Show qualities';
    toggle.addEventListener('click', () => void toggleExpand(item, li));
    row.append(toggle);
  }

  row.append(makeDownloadButton(item));

  li.append(row);

  if (isStream && expanded.has(item.id)) {
    li.append(renderVariants(item));
  }
  return li;
}

function makeDownloadButton(item: MediaItem): HTMLButtonElement {
  const dl = document.createElement('button');
  dl.textContent = 'Download';

  if (item.type === 'mp4' || item.type === 'webm') {
    dl.addEventListener('click', () => void requestDownload(item));
  } else if (item.type === 'hls' || item.type === 'dash') {
    dl.addEventListener('click', () => void requestAssemble(item));
  } else {
    // blob — the underlying stream is detected separately as HLS/DASH.
    dl.disabled = true;
    dl.title = 'Blob streams: download via the detected HLS/DASH entry';
  }
  return dl;
}

async function requestAssemble(item: MediaItem): Promise<void> {
  // Assembling fetches the manifest, every segment, keys, and (for server
  // destinations) uploads — all from hosts we can't enumerate up front, so a
  // single broad grant is required before we start.
  if (!(await ensureHostAccess())) return;

  if (!summaries.has(item.id) || summaries.get(item.id)?.error) {
    summaries.delete(item.id);
    await loadSummary(item);
    render(currentItems);
  }
  const summary = summaries.get(item.id);
  if (summary?.error) {
    statusEl.textContent = `Could not read manifest: ${summary.error}`;
    return;
  }

  // The engine plans tracks (video + optional separate audio) from the
  // detected manifest; we pass the chosen quality (HLS variant URL or DASH
  // representation id) so it picks the right one. Output is muxed to .mp4.
  const sel = selectedVariant(item);
  const req: AssembleRequest = {
    url: item.url,
    filename: sanitizeFilename(item.pageTitle, item.url, item.type),
    mediaType: item.type,
    variantUri: sel?.uri,
    repId: sel?.repId,
  };
  const msg: RuntimeMessage = { kind: 'assemble/start', req };
  await chrome.runtime.sendMessage(msg);
  await refreshJobs();
}

/** The DisplayVariant the user selected for this item, if it was expanded. */
function selectedVariant(item: MediaItem): DisplayVariant | undefined {
  const summary = summaries.get(item.id);
  const key = selection.get(item.id);
  if (!summary || !key) return undefined;
  return summary.variants.find((v) => v.key === key);
}

async function requestDownload(item: MediaItem): Promise<void> {
  const storage = await loadStorageSettings();
  if (storage.destination !== 'local') {
    // Local downloads go through chrome.downloads (no host permission needed);
    // a server upload fetches the media and PUTs it, so it needs host access.
    if (!(await ensureHostAccess())) return;
  }
  const req: DownloadRequest = {
    url: item.url,
    filename: sanitizeFilename(item.pageTitle, item.url, item.type),
    mediaType: item.type,
  };
  const msg: RuntimeMessage = { kind: 'download/start', req };
  await chrome.runtime.sendMessage(msg);
  await refreshJobs();
}

async function toggleExpand(item: MediaItem, li: HTMLLIElement): Promise<void> {
  if (expanded.has(item.id)) {
    expanded.delete(item.id);
  } else {
    if (!(await ensureHostAccess())) return;
    expanded.add(item.id);
    if (!summaries.has(item.id)) await loadSummary(item);
  }
  // Re-render just this row.
  const fresh = renderItem(item);
  li.replaceWith(fresh);
}

async function loadSummary(item: MediaItem): Promise<void> {
  if (summaries.has(item.id)) return;
  try {
    // Omit cookies: media CDNs send `Access-Control-Allow-Origin: *`, which the
    // browser rejects for credentialed requests. These streams use token URLs.
    const res = await fetch(item.url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let summary: StreamSummary;
    if (item.type === 'hls') {
      const playlist = parseHls(text, item.url);
      summary = describeHls(playlist);
      if (playlist.kind === 'master' && playlist.variants[0]) {
        const variantUrl = playlist.variants[0].uri;
        if (await hasHostAccess()) {
          const variantRes = await fetch(variantUrl, {
            credentials: 'omit',
            cache: 'no-store',
          });
          if (variantRes.ok) {
            const media = parseHls(await variantRes.text(), variantUrl);
            if (media.kind === 'media' && media.totalDurationSec > 0) {
              summary.durationSec = media.totalDurationSec;
              summary.variants = summary.variants.map((variant) => ({
                ...variant,
                estimatedSizeBytes:
                  (variant.averageBandwidth ?? variant.bandwidth) != null
                    ? ((variant.averageBandwidth ?? variant.bandwidth)! / 8) *
                      media.totalDurationSec
                    : undefined,
              }));
            }
          }
        }
      }
    } else {
      summary = describeDash(parseDash(text, item.url));
    }
    summaries.set(item.id, summary);
    // Default selection: first (best) variant.
    if (summary.variants[0]) selection.set(item.id, summary.variants[0].key);
    persistSummaries();
  } catch (err) {
    summaries.set(item.id, {
      variants: [],
      error: err instanceof Error ? err.message : 'Failed to load manifest',
    });
  }
}

function renderVariants(item: MediaItem): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'variants';

  const summary = summaries.get(item.id);
  if (!summary) {
    wrap.textContent = 'Loading…';
    return wrap;
  }
  if (summary.error) {
    wrap.classList.add('error');
    wrap.textContent = `Couldn't read manifest: ${summary.error}`;
    return wrap;
  }
  if (summary.variants.length === 0) {
    wrap.textContent = 'No selectable tracks found.';
    return wrap;
  }

  if (summary.durationSec) {
    const dur = document.createElement('div');
    dur.className = 'duration';
    dur.textContent = `Duration ${formatDuration(summary.durationSec)}`;
    wrap.append(dur);
  }

  summary.variants.forEach((v) => wrap.append(renderVariantRow(item.id, v)));
  return wrap;
}

function renderVariantRow(itemId: string, v: DisplayVariant): HTMLElement {
  const label = document.createElement('label');
  label.className = 'variant';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = `variant-${itemId}`;
  radio.checked = selection.get(itemId) === v.key;
  radio.addEventListener('change', () => {
    selection.set(itemId, v.key);
    render(currentItems);
  });

  const text = document.createElement('span');
  text.className = 'vlabel';
  text.textContent = v.label;

  const detail = document.createElement('span');
  detail.className = 'vdetail';
  detail.textContent = v.detail;

  label.append(radio, text, detail);
  return label;
}

function subtitle(item: MediaItem): string {
  const summary = summaries.get(item.id);
  const selected = selectedVariant(item) ?? summary?.variants[0];
  const estimatedBytes = selected?.estimatedSizeBytes;
  const duration = item.durationSec ?? summary?.durationSec;
  const parts: string[] = [];
  if ((item.type === 'mp4' || item.type === 'webm') && item.sizeBytes) {
    parts.push(formatBytes(item.sizeBytes));
  } else if (estimatedBytes) {
    parts.push(`~${formatBytes(estimatedBytes)}`);
  }
  const formattedDuration = formatDuration(duration);
  if (formattedDuration) parts.push(formattedDuration);
  parts.push(labelForType(item.type));
  parts.push(hostOf(item.url));
  return parts.join(' · ');
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).pop() ?? u.hostname;
  } catch {
    return '';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// --- Downloads panel --------------------------------------------------------

async function refreshJobs(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const jobs = Object.entries(all)
    .filter(([k]) => k.startsWith('job:'))
    .map(([, v]) => v as DownloadJob);

  // For active downloads, read live byte counts straight from chrome.downloads
  // (onChanged doesn't fire on every byte, so we poll while the popup is open).
  await Promise.all(
    jobs.map(async (j) => {
      if (j.downloadId != null && j.state === 'downloading') {
        const [it] = await chrome.downloads.search({ id: j.downloadId });
        if (it) {
          j.receivedBytes = it.bytesReceived;
          if (it.totalBytes > 0) j.totalBytes = it.totalBytes;
        }
      }
    }),
  );

  const nextActive = new Set(jobs.filter(isActiveJob).map((j) => j.url));
  if (!sameUrlSet(nextActive, activeJobUrls)) {
    activeJobUrls = nextActive;
    render(currentItems);
  }
  renderJobs(jobs);
}

function sameUrlSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const url of a) if (!b.has(url)) return false;
  return true;
}

function renderJobs(jobs: DownloadJob[]): void {
  const visibleJobs = collapseDuplicateJobs(jobs);
  jobsEl.classList.toggle('hidden', visibleJobs.length === 0);
  joblistEl.replaceChildren();
  visibleJobs.forEach((j) => joblistEl.appendChild(renderJob(j)));
}

function renderJob(job: DownloadJob): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'job';

  const top = document.createElement('div');
  top.className = 'job-top';

  const name = document.createElement('span');
  name.className = 'job-name';
  name.textContent = job.filename;
  name.title = job.filename;

  const active = isActiveJob(job);
  const actions = document.createElement('div');
  actions.className = 'job-actions';
  if (active) {
    actions.append(jobButton('Cancel', () => void cancelJob(job)));
  } else {
    if (canRetryJob(job)) {
      actions.append(jobButton('Retry', () => void retryJob(job)));
    }
    actions.append(jobButton('Dismiss', () => void dismissJob(job)));
  }

  top.append(name, actions);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const fill = document.createElement('div');
  fill.className = 'fill';
  const pct = jobPercent(job);
  fill.style.width = `${pct}%`;
  fill.classList.add(`state-${job.state}`);
  bar.append(fill);

  const status = document.createElement('div');
  status.className = 'job-status';
  status.textContent = jobStatusText(job, pct);

  li.append(top, bar, status);
  return li;
}

function jobButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'ghost';
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

async function cancelJob(job: DownloadJob): Promise<void> {
  const msg: RuntimeMessage = { kind: 'download/cancel', jobId: job.jobId };
  await chrome.runtime.sendMessage(msg);
  await refreshJobs();
}

async function retryJob(job: DownloadJob): Promise<void> {
  const msg: RuntimeMessage = { kind: 'download/retry', jobId: job.jobId };
  await chrome.runtime.sendMessage(msg);
  await refreshJobs();
}

async function dismissJob(job: DownloadJob): Promise<void> {
  await chrome.storage.session.remove(`job:${job.jobId}`);
  await refreshJobs();
}

function jobPercent(job: DownloadJob): number {
  if (job.state === 'complete') return 100;
  if (job.state === 'muxing') return job.muxPercent ?? 0;
  if (job.segmentsTotal) {
    return Math.min(100, Math.round(((job.segmentsDone ?? 0) / job.segmentsTotal) * 100));
  }
  if (job.totalBytes) {
    return Math.min(100, Math.round((job.receivedBytes / job.totalBytes) * 100));
  }
  return 0;
}

function jobStatusText(job: DownloadJob, pct: number): string {
  switch (job.state) {
    case 'complete':
      return `Done · ${formatBytes(job.receivedBytes)}`;
    case 'canceled':
      return 'Canceled';
    case 'interrupted':
      return `Failed${job.error ? ` · ${job.error}` : ''}`;
    case 'queued':
      return 'Starting…';
    case 'transferring':
      return `Fetching source · ${formatBytes(job.receivedBytes)}`;
    case 'assembling': {
      const seg =
        job.segmentsTotal != null
          ? `${job.segmentsDone ?? 0}/${job.segmentsTotal} segments`
          : 'preparing';
      return `Assembling · ${seg} · ${formatBytes(job.receivedBytes)}`;
    }
    case 'muxing':
      return `Muxing to MP4 · ${job.muxPercent ?? 0}%`;
    case 'uploading':
      return `Uploading to home server · ${formatBytes(job.receivedBytes)}`;
    default: {
      if (job.engine === 'assemble') return `Saving… · ${formatBytes(job.receivedBytes)}`;
      const got = formatBytes(job.receivedBytes);
      return job.totalBytes
        ? `${pct}% · ${got} / ${formatBytes(job.totalBytes)}`
        : `${got} downloaded`;
    }
  }
}

settingsToggleEl.addEventListener('click', () => {
  settingsEl.classList.toggle('hidden');
});

destinationEl.addEventListener('change', updateSettingsVisibility);

settingsSaveEl.addEventListener('click', async () => {
  try {
    const settings = settingsFromInputs();
    await saveStorageSettings(settings);
    showSettingsStatus('Saved.', 'success');
  } catch (err) {
    showSettingsStatus(err instanceof Error ? err.message : 'Failed to save settings.', 'error');
  }
});

serverTestEl.addEventListener('click', async () => {
  serverTestEl.disabled = true;
  showSettingsStatus('Connecting…');
  try {
    const settings = settingsFromInputs();
    if (settings.destination === 'local') {
      throw new Error('Choose Home Server or Local + Home Server first.');
    }
    const url = settings.serverUrl;
    if (!(await ensureHostAccess())) return;
    const res = await fetch(url, {
      method: 'PROPFIND',
      headers: {
        Authorization: basicAuthHeader(settings.username, settings.password),
        Depth: '0',
      },
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('WebDAV rejected the username or password.');
    }
    if (!res.ok) throw new Error(`WebDAV server returned HTTP ${res.status}.`);
    serverUrlEl.value = url;
    showSettingsStatus('Connection successful.', 'success');
  } catch (err) {
    showSettingsStatus(
      err instanceof Error ? err.message : 'Could not connect to the WebDAV server.',
      'error',
    );
  } finally {
    serverTestEl.disabled = false;
  }
});

function settingsFromInputs(): {
  destination: StorageDestination;
  subfolder: string;
  serverUrl: string;
  username: string;
  password: string;
} {
  const destination = destinationEl.value as StorageDestination;
  // Stored value is sanitized (slashes, '.'/'..' stripped) by normalizeStorageSettings.
  const subfolder = subfolderEl.value.trim();
  const serverUrl =
    destination === 'local'
      ? serverUrlEl.value.trim()
      : normalizeWebDavUrl(serverUrlEl.value);
  const username = serverUsernameEl.value.trim();
  const password = serverPasswordEl.value;
  if (destination !== 'local' && !username) throw new Error('Enter a WebDAV username.');
  if (destination !== 'local' && !password) throw new Error('Enter a WebDAV password.');
  return { destination, subfolder, serverUrl, username, password };
}

function updateSettingsVisibility(): void {
  const localOnly = destinationEl.value === 'local';
  serverSettingsEl.classList.toggle('hidden', localOnly);
  serverTestEl.classList.toggle('hidden', localOnly);
}

function showSettingsStatus(
  message: string,
  kind?: 'success' | 'error',
): void {
  settingsStatusEl.textContent = message;
  settingsStatusEl.classList.toggle('success', kind === 'success');
  settingsStatusEl.classList.toggle('error', kind === 'error');
}

// The extension holds no host permissions at install time. A single stream
// can pull its manifest, segments, keys, and upload target from several
// different hosts, and MV3 only allows requesting optional host permissions
// from a user gesture — so we request all-URLs access once on the first
// download rather than prompting per host.
const ALL_URLS = ['http://*/*', 'https://*/*'];

async function hasHostAccess(): Promise<boolean> {
  return chrome.permissions.contains({ origins: ALL_URLS });
}

async function ensureHostAccess(): Promise<boolean> {
  if (await hasHostAccess()) return true;
  const granted = await chrome.permissions.request({ origins: ALL_URLS });
  statusEl.textContent = granted
    ? 'Media host access granted'
    : 'Access to media hosts is required to download.';
  return granted;
}

async function loadSettingsUi(): Promise<void> {
  const settings = await loadStorageSettings();
  destinationEl.value = settings.destination;
  subfolderEl.value = settings.subfolder;
  serverUrlEl.value = settings.serverUrl;
  serverUsernameEl.value = settings.username;
  serverPasswordEl.value = settings.password;
  updateSettingsVisibility();
}

clearEl.addEventListener('click', async () => {
  const tabId = await activeTabId();
  if (tabId == null) return;
  const msg: RuntimeMessage = { kind: 'popup/clear', tabId };
  await chrome.runtime.sendMessage(msg);
  summaries.clear();
  selection.clear();
  expanded.clear();
  currentItems = [];
  void chrome.storage.session.remove(SUMMARY_CACHE_KEY);
  const all = await chrome.storage.session.get(null);
  const terminalJobKeys = Object.entries(all)
    .filter(([key, value]) => key.startsWith('job:') && !isActiveJob(value as DownloadJob))
    .map(([key]) => key);
  if (terminalJobKeys.length > 0) await chrome.storage.session.remove(terminalJobKeys);
  render([]);
  await refreshJobs();
});

// Live refresh while the popup is open (detections + job state may change).
chrome.storage.session.onChanged.addListener((changes) => {
  void changes;
  void refreshJobs();
});

// Poll active downloads for live byte progress (onChanged isn't per-byte).
const pollTimer = window.setInterval(() => void refreshJobs(), 1000);
const scanTimer = window.setInterval(() => void load(), 2500);
window.addEventListener('unload', () => {
  window.clearInterval(pollTimer);
  window.clearInterval(scanTimer);
});

void load();
void refreshJobs();
void loadSettingsUi();
