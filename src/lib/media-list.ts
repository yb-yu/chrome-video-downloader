import type { MediaItem } from './types';
import type { StreamSummary } from './variants';
import { isSegmentUrl } from './media';

/**
 * Hide non-downloadable blob markers once a real media URL is known, and hide
 * HLS child playlists already represented by a detected master playlist.
 */
export function collapseRelatedMedia(
  items: MediaItem[],
  summaries: ReadonlyMap<string, StreamSummary>,
): MediaItem[] {
  const candidates = items.filter((item) => !isSegmentUrl(item.url));
  const hasDownloadable = candidates.some((item) => item.type !== 'blob');
  const childUrls = new Set<string>();

  for (const item of items) {
    const summary = summaries.get(item.id);
    for (const url of summary?.relatedUrls ?? []) {
      childUrls.add(canonicalUrl(url));
    }
  }

  const hlsMasters = candidates.filter(
    (item) => item.type === 'hls' && summaries.get(item.id)?.playlistKind === 'master',
  );
  const hasAttachedProgressive = candidates.some(
    (item) => isProgressive(item) && item.pageAttached,
  );
  const duplicateProgressiveIds = findDuplicateProgressiveIds(candidates);
  const fallbackStreamIds = findFallbackStreamIds(candidates, summaries);
  const seenStreams = new Set<string>();
  const seenMasterStreams = new Set<string>();
  return candidates.filter((item) => {
    if (item.type === 'blob' && hasDownloadable) return false;
    if (isLowConfidenceProgressive(item, hasAttachedProgressive)) return false;
    if (duplicateProgressiveIds.has(item.id)) return false;
    if (
      (item.type === 'hls' || item.type === 'dash') &&
      !fallbackStreamIds.has(item.id) &&
      isUnresolvedStream(item, summaries)
    ) {
      return false;
    }
    const canonical = canonicalUrl(item.url);
    if (childUrls.has(canonical)) return false;
    if (
      item.type === 'hls' &&
      summaries.get(item.id)?.playlistKind === 'media' &&
      hlsMasters.some((master) => representsSameHls(master, item, summaries))
    ) {
      return false;
    }
    if (item.type === 'hls' || item.type === 'dash') {
      if (seenStreams.has(canonical)) return false;
      seenStreams.add(canonical);
    }
    // Some sites expose the same master playlist through several entry URLs
    // (alias paths, rotating auth tokens). Once parsed, collapse masters that
    // resolve to the same set of variant playlists into one. Different variant
    // sets mean genuinely different streams, so they are kept.
    const masterSummary = summaries.get(item.id);
    if (item.type === 'hls' && masterSummary?.playlistKind === 'master') {
      const signature = (masterSummary.relatedUrls ?? [])
        .map(canonicalUrl)
        .sort()
        .join('\n');
      if (signature) {
        if (seenMasterStreams.has(signature)) return false;
        seenMasterStreams.add(signature);
      }
    }
    return true;
  });
}

function findFallbackStreamIds(
  items: MediaItem[],
  summaries: ReadonlyMap<string, StreamSummary>,
): Set<string> {
  const keepers = new Map<string, MediaItem>();
  for (const item of items) {
    if (!isUnresolvedStream(item, summaries)) continue;
    const key = [item.type, item.pageUrl ?? '', hostOf(item.url)].join('\n');
    const current = keepers.get(key);
    if (!current || (item.pageAttached && !current.pageAttached)) {
      keepers.set(key, item);
    }
  }
  return new Set(Array.from(keepers.values(), (item) => item.id));
}

function isUnresolvedStream(
  item: MediaItem,
  summaries: ReadonlyMap<string, StreamSummary>,
): boolean {
  if (item.type !== 'hls' && item.type !== 'dash') return false;
  const summary = summaries.get(item.id);
  return summary == null || summary.error != null;
}

const SMALL_BACKGROUND_VIDEO_BYTES = 256 * 1024;
const TRACKING_URL_RE =
  /(?:analytics|telemetry|tracking|tracker|beacon|pixel|collect|metrics)/i;

function isLowConfidenceProgressive(
  item: MediaItem,
  hasAttachedProgressive: boolean,
): boolean {
  if (!isProgressive(item)) return false;
  if (item.durationSec != null && item.durationSec <= 2) return true;
  if (item.pageAttached) return false;
  if (item.sizeBytes != null && item.sizeBytes < SMALL_BACKGROUND_VIDEO_BYTES) return true;
  if (TRACKING_URL_RE.test(item.url)) return true;
  // When the page exposes its real <video>/<source>, an unrelated network-only
  // MP4/WebM with no useful metadata is usually a preload, probe, or tracker.
  return hasAttachedProgressive && item.sizeBytes == null && item.durationSec == null;
}

function isProgressive(item: MediaItem): boolean {
  return item.type === 'mp4' || item.type === 'webm';
}

function findDuplicateProgressiveIds(items: MediaItem[]): Set<string> {
  const hidden = new Set<string>();
  const groups: MediaItem[][] = [];

  for (const item of items) {
    if (
      !isProgressive(item) ||
      item.sizeBytes == null ||
      item.sizeBytes <= 0 ||
      item.durationSec == null ||
      item.durationSec <= 0
    ) {
      continue;
    }
    const group = groups.find((entries) => sameProgressiveMedia(entries[0], item));
    if (group) group.push(item);
    else groups.push([item]);
  }

  for (const group of groups) {
    if (group.length < 2) continue;
    const keep = group
      .slice()
      .sort(
        (a, b) =>
          Number(Boolean(b.pageAttached)) - Number(Boolean(a.pageAttached)) ||
          (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0) ||
          a.detectedAt - b.detectedAt,
      )[0];
    for (const item of group) {
      if (item.id !== keep.id) hidden.add(item.id);
    }
  }
  return hidden;
}

function sameProgressiveMedia(a: MediaItem, b: MediaItem): boolean {
  if (a.type !== b.type || (a.pageUrl ?? '') !== (b.pageUrl ?? '')) return false;
  const durationDiff = Math.abs((a.durationSec ?? 0) - (b.durationSec ?? 0));
  const largerSize = Math.max(a.sizeBytes ?? 0, b.sizeBytes ?? 0);
  const sizeDiff = Math.abs((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  return durationDiff <= 1 && largerSize > 0 && sizeDiff / largerSize <= 0.01;
}

function representsSameHls(
  master: MediaItem,
  media: MediaItem,
  summaries: ReadonlyMap<string, StreamSummary>,
): boolean {
  if (master.pageUrl && media.pageUrl && master.pageUrl !== media.pageUrl) return false;
  if (hostOf(master.url) !== hostOf(media.url)) return false;
  const masterDuration = summaries.get(master.id)?.durationSec;
  const mediaDuration = summaries.get(media.id)?.durationSec;
  return (
    masterDuration != null &&
    mediaDuration != null &&
    Math.abs(masterDuration - mediaDuration) <= 2
  );
}

/** Best known final output size, used to put the most useful item first. */
export function mediaSizeBytes(
  item: MediaItem,
  summary: StreamSummary | undefined,
  variantKey?: string,
): number {
  if (item.type === 'mp4' || item.type === 'webm') return item.sizeBytes ?? 0;
  if (item.type !== 'hls' && item.type !== 'dash') return 0;
  const selected = variantKey
    ? summary?.variants.find((variant) => variant.key === variantKey)
    : undefined;
  return (
    selected?.estimatedSizeBytes ??
    Math.max(0, ...(summary?.variants.map((variant) => variant.estimatedSizeBytes ?? 0) ?? []))
  );
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    // HLS/DASH CDNs often append rotating authorization/cache parameters to
    // the same manifest URL. They should still collapse into one stream.
    parsed.search = '';
    return parsed.href;
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}
