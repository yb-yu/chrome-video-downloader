// Media classification and display helpers.

import type { MediaType } from './types';

/**
 * Segment files that belong to a stream — we deliberately ignore these as
 * standalone items so the popup isn't flooded with thousands of .ts/.m4s rows.
 */
const SEGMENT_RE = /\.(ts|m4s|aac|m4a)(\?|#|$)/i;
const MP4_FRAGMENT_RE =
  /(?:^|\/)(?:init(?:ialization)?|fileSequence0|segment[-_]?\d+)[^/]*\.mp4(\?|#|$)/i;

export function isSegmentUrl(url: string): boolean {
  const normalized = stripQueryNoise(url);
  return SEGMENT_RE.test(normalized) || MP4_FRAGMENT_RE.test(normalized);
}

/**
 * Classify a network URL into a downloadable media type, or undefined if it
 * isn't one we surface. Mirrors the inline classifier in rescan's page scan
 * (minus blob:, which never reaches the network layer), and is used by the
 * real-time webRequest sniffer.
 */
export function classifyMediaUrl(url: string): MediaType | undefined {
  if (!/^https?:/i.test(url)) return undefined;
  if (isSegmentUrl(url)) return undefined;
  if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  if (/\.(mp4|m4v|mov)(\?|#|$)/i.test(url)) return 'mp4';
  if (/\.webm(\?|#|$)/i.test(url)) return 'webm';
  return undefined;
}

/** Some CDNs append cache-busting query noise; keep it readable for matching. */
function stripQueryNoise(url: string): string {
  return url;
}

/** Short stable id for a media url within a tab. */
export function mediaId(tabId: number, url: string): string {
  // Hash-free: tab + url is unique enough and keeps things debuggable.
  return `${tabId}::${url}`;
}

/** Best-effort human label for a media item. */
export function labelForType(type: MediaType): string {
  switch (type) {
    case 'hls':
      return 'HLS stream (.m3u8)';
    case 'dash':
      return 'DASH stream (.mpd)';
    case 'mp4':
      return 'MP4 video';
    case 'webm':
      return 'WebM video';
    case 'blob':
      return 'Blob / MSE video';
  }
}
