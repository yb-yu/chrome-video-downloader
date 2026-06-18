// HLS (.m3u8) parser.
//
// Handles the two playlist kinds:
//   * Master playlist  -> a set of variant streams (#EXT-X-STREAM-INF) plus
//     alternate renditions (#EXT-X-MEDIA, e.g. separate audio tracks).
//   * Media playlist   -> an ordered list of media segments (#EXTINF) with
//     optional AES-128 encryption (#EXT-X-KEY) and byte ranges.
//
// Pure functions only: no fetch and no DOM.

import { resolveUrl } from './url';

export interface HlsKey {
  method: 'AES-128' | 'SAMPLE-AES' | 'NONE';
  uri?: string; // absolute
  iv?: string; // hex string, "0x..." normalized to lowercase hex without prefix
}

export interface HlsSegment {
  uri: string; // absolute
  durationSec: number;
  /** Byte range as [length, offset] when #EXT-X-BYTERANGE is present. */
  byteRange?: { length: number; offset: number };
  key?: HlsKey;
}

export interface HlsVariant {
  uri: string; // absolute, points at a media playlist
  bandwidth?: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroup?: string;
}

export interface HlsRendition {
  type: 'AUDIO' | 'SUBTITLES' | 'VIDEO' | 'CLOSED-CAPTIONS';
  groupId: string;
  name: string;
  uri?: string; // absolute
  isDefault: boolean;
  language?: string;
}

export interface HlsMasterPlaylist {
  kind: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface HlsMediaPlaylist {
  kind: 'media';
  segments: HlsSegment[];
  targetDurationSec?: number;
  totalDurationSec: number;
  isLive: boolean;
  /** First segment's media sequence number (#EXT-X-MEDIA-SEQUENCE, default 0). */
  mediaSequence: number;
  /** Initialization segment (#EXT-X-MAP) for fMP4 variants, if present. */
  map?: { uri: string; byteRange?: { length: number; offset: number } };
}

export type HlsPlaylist = HlsMasterPlaylist | HlsMediaPlaylist;

export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text);
}

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  return isMasterPlaylist(text)
    ? parseMaster(text, baseUrl)
    : parseMedia(text, baseUrl);
}

export function parseMaster(text: string, baseUrl: string): HlsMasterPlaylist {
  const lines = splitLines(text);
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      renditions.push({
        type: (a.TYPE as HlsRendition['type']) ?? 'AUDIO',
        groupId: a['GROUP-ID'] ?? '',
        name: a.NAME ?? '',
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
        isDefault: a.DEFAULT === 'YES',
        language: a.LANGUAGE,
      });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      const uriLine = nextUri(lines, i);
      if (!uriLine) continue;
      const [w, h] = (a.RESOLUTION ?? '').split('x');
      variants.push({
        uri: resolveUrl(uriLine, baseUrl),
        bandwidth: numAttr(a.BANDWIDTH),
        averageBandwidth: numAttr(a['AVERAGE-BANDWIDTH']),
        width: numAttr(w),
        height: numAttr(h),
        codecs: a.CODECS,
        frameRate: numAttr(a['FRAME-RATE']),
        audioGroup: a.AUDIO,
      });
    }
  }

  // Sort by bandwidth descending (best quality first).
  variants.sort((x, y) => (y.bandwidth ?? 0) - (x.bandwidth ?? 0));
  return { kind: 'master', variants, renditions };
}

export function parseMedia(text: string, baseUrl: string): HlsMediaPlaylist {
  const lines = splitLines(text);
  const segments: HlsSegment[] = [];
  let targetDurationSec: number | undefined;
  let isLive = true; // until we see #EXT-X-ENDLIST
  let mediaSequence = 0;
  let map: HlsMediaPlaylist['map'];
  let pendingDuration = 0;
  let pendingByteRange: HlsSegment['byteRange'] | undefined;
  let currentKey: HlsKey | undefined;
  let lastByteRangeEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDurationSec = numAttr(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = numAttr(line.split(':')[1]) ?? 0;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      map = {
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : '',
        byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined,
      };
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      isLive = false;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      currentKey = parseKey(line.slice('#EXT-X-KEY:'.length), baseUrl);
    } else if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = parseByteRange(
        line.slice('#EXT-X-BYTERANGE:'.length),
        lastByteRangeEnd,
      );
    } else if (line && !line.startsWith('#')) {
      const seg: HlsSegment = {
        uri: resolveUrl(line, baseUrl),
        durationSec: pendingDuration,
        byteRange: pendingByteRange,
        key: currentKey && currentKey.method !== 'NONE' ? currentKey : undefined,
      };
      segments.push(seg);
      if (pendingByteRange) {
        lastByteRangeEnd = pendingByteRange.offset + pendingByteRange.length;
      }
      pendingDuration = 0;
      pendingByteRange = undefined;
    }
  }

  const totalDurationSec = segments.reduce((acc, s) => acc + s.durationSec, 0);
  return {
    kind: 'media',
    segments,
    targetDurationSec,
    totalDurationSec,
    isLive,
    mediaSequence,
    map,
  };
}

// --- helpers ----------------------------------------------------------------

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim());
}

function nextUri(lines: string[], from: number): string | undefined {
  for (let j = from + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l && !l.startsWith('#')) return l;
  }
  return undefined;
}

function parseKey(attrStr: string, baseUrl: string): HlsKey {
  const a = parseAttributes(attrStr);
  const method = (a.METHOD as HlsKey['method']) ?? 'NONE';
  return {
    method,
    uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
    iv: a.IV ? a.IV.replace(/^0x/i, '').toLowerCase() : undefined,
  };
}

function parseByteRange(value: string, prevEnd: number): { length: number; offset: number } {
  // Format: <length>[@<offset>]
  const [lenStr, offStr] = value.split('@');
  const length = Number(lenStr) || 0;
  const offset = offStr !== undefined ? Number(offStr) || 0 : prevEnd;
  return { length, offset };
}

function numAttr(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse an HLS attribute list: comma-separated KEY=VALUE pairs where VALUE may
 * be a quoted string (which can itself contain commas).
 */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const n = input.length;
  while (i < n) {
    // key
    let key = '';
    while (i < n && input[i] !== '=') key += input[i++];
    if (i >= n) break;
    i++; // skip '='
    let value = '';
    if (input[i] === '"') {
      i++; // opening quote
      while (i < n && input[i] !== '"') value += input[i++];
      i++; // closing quote
    } else {
      while (i < n && input[i] !== ',') value += input[i++];
    }
    out[key.trim()] = value;
    // skip comma + whitespace
    while (i < n && (input[i] === ',' || input[i] === ' ')) i++;
  }
  return out;
}
