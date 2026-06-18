// Normalize HLS/DASH parse results into a common, display-friendly model that
// the popup renders for quality selection.

import type { HlsPlaylist } from './hls';
import type { DashManifest, DashRepresentation } from './dash';

export interface DisplayVariant {
  /** Unique within an item; used as the selection key. */
  key: string;
  /** Primary label, e.g. "1080p" or "Source". */
  label: string;
  /** Secondary detail, e.g. "5.0 Mbps · avc1.640028". */
  detail: string;
  kind: 'video' | 'audio' | 'muxed';
  height?: number;
  bandwidth?: number;
  averageBandwidth?: number;
  /** Rough total bytes from advertised bitrate and duration. */
  estimatedSizeBytes?: number;
  /** HLS: absolute media-playlist URL. DASH: undefined. */
  uri?: string;
  /** DASH: representation id (selection is by representation). */
  repId?: string;
}

export interface StreamSummary {
  variants: DisplayVariant[];
  durationSec?: number;
  /** Whether an HLS summary represents a master or media playlist. */
  playlistKind?: 'master' | 'media';
  /** Child playlist URLs represented by this master entry. */
  relatedUrls?: string[];
  /** Set when the manifest could not be fetched/parsed. */
  error?: string;
}

export function describeHls(playlist: HlsPlaylist): StreamSummary {
  if (playlist.kind === 'media') {
    return {
      durationSec: playlist.totalDurationSec || undefined,
      playlistKind: 'media',
      variants: [
        {
          key: 'source',
          label: 'Source',
          detail: playlist.isLive ? 'live stream' : `${playlist.segments.length} segments`,
          kind: 'muxed',
        },
      ],
    };
  }

  const variants = playlist.variants.map((v, i): DisplayVariant => ({
    key: v.uri || `var-${i}`,
    label: v.height ? `${v.height}p` : v.bandwidth ? formatBitrate(v.bandwidth) : `Variant ${i + 1}`,
    detail: [
      v.bandwidth ? formatBitrate(v.bandwidth) : undefined,
      v.width && v.height ? `${v.width}×${v.height}` : undefined,
      shortCodec(v.codecs),
    ]
      .filter(Boolean)
      .join(' · '),
    kind: v.audioGroup ? 'video' : 'muxed',
    height: v.height,
    bandwidth: v.bandwidth,
    averageBandwidth: v.averageBandwidth,
    uri: v.uri,
  }));

  return {
    variants,
    playlistKind: 'master',
    relatedUrls: [
      ...playlist.variants.map((variant) => variant.uri),
      ...playlist.renditions.flatMap((rendition) => (rendition.uri ? [rendition.uri] : [])),
    ],
  };
}

export function describeDash(manifest: DashManifest): StreamSummary {
  const video = manifest.representations.filter((r) => r.type === 'video');
  const audio = manifest.representations.filter((r) => r.type === 'audio');
  const hasSeparateAudio = video.length > 0 && audio.length > 0;
  // Add the best audio bitrate when estimating size for a video-only rep.
  const audioBps = audio[0]?.bandwidth ?? 0;

  // If there's no dedicated video track (audio-only stream), fall back to audio.
  const primary = video.length > 0 ? video : audio;
  const variants = primary.map((r, i): DisplayVariant => {
    const totalBps = (r.bandwidth ?? 0) + (r.type === 'video' && hasSeparateAudio ? audioBps : 0);
    const sizeBytes = estimateBytes(totalBps, manifest.durationSec);
    return {
      key: r.id || `rep-${i}`,
      label: r.height ? `${r.height}p` : r.bandwidth ? formatBitrate(r.bandwidth) : `Rep ${i + 1}`,
      detail: dashDetail(r, hasSeparateAudio, totalBps, manifest.durationSec),
      kind: r.type === 'audio' ? 'audio' : 'video',
      height: r.height,
      bandwidth: r.bandwidth,
      estimatedSizeBytes: sizeBytes,
      repId: r.id,
    };
  });

  return {
    variants,
    durationSec: manifest.durationSec,
  };
}

function dashDetail(
  r: DashRepresentation,
  hasSeparateAudio: boolean,
  totalBps: number,
  durationSec: number | undefined,
): string {
  return [
    r.bandwidth ? formatBitrate(r.bandwidth) : undefined,
    r.width && r.height ? `${r.width}×${r.height}` : undefined,
    shortCodec(r.codecs),
    r.type === 'video' && hasSeparateAudio ? '+ audio' : undefined,
    estimatedSize(totalBps, durationSec),
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Rough download size from bitrate × duration (streams rarely advertise one). */
export function estimatedSize(bps: number, durationSec: number | undefined): string | undefined {
  const bytes = estimateBytes(bps, durationSec);
  return bytes ? `~${formatBytes(bytes)}` : undefined;
}

function estimateBytes(bps: number, durationSec: number | undefined): number | undefined {
  if (!bps || !durationSec) return undefined;
  return (bps / 8) * durationSec;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatBitrate(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} Mbps`;
  if (bps >= 1_000) return `${Math.round(bps / 1_000)} kbps`;
  return `${bps} bps`;
}

export function formatDuration(sec: number | undefined): string | undefined {
  if (!sec || !Number.isFinite(sec)) return undefined;
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

function shortCodec(codecs?: string): string | undefined {
  if (!codecs) return undefined;
  // Keep just the first codec's family for compactness.
  return codecs.split(',')[0].trim().split('.')[0];
}
