// DASH (.mpd) parser.
//
// Parses selectable representations and presentation duration. Segment URL
// expansion lives in download/dash-segments.ts.
//
// Relies on a DOMParser being available; popup and offscreen documents both
// provide one.

import { parseISODuration, resolveUrl } from './url';

export type DashTrackType = 'video' | 'audio' | 'text' | 'unknown';

export interface DashRepresentation {
  id: string;
  type: DashTrackType;
  mimeType?: string;
  codecs?: string;
  bandwidth?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  /** Audio sampling rate (Hz) for audio tracks. */
  audioSamplingRate?: number;
  language?: string;
  /** Base URL resolved for this representation. */
  baseUrl: string;
}

export interface DashManifest {
  representations: DashRepresentation[];
  durationSec?: number;
}

export function parseDash(xmlText: string, baseUrl: string): DashManifest {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const mpd = doc.querySelector('MPD');
  if (!mpd) return { representations: [] };

  const durationSec =
    parseISODuration(mpd.getAttribute('mediaPresentationDuration')) ??
    parseISODuration(mpd.getAttribute('maxSegmentDuration'));

  // Resolve nested BaseURL elements: MPD > Period > AdaptationSet > Representation.
  const mpdBase = resolveChildBase(mpd, baseUrl);

  const representations: DashRepresentation[] = [];

  mpd.querySelectorAll('Period').forEach((period) => {
    const periodBase = resolveChildBase(period, mpdBase);
    period.querySelectorAll('AdaptationSet').forEach((aset) => {
      const asetBase = resolveChildBase(aset, periodBase);
      const asetType = trackType(
        aset.getAttribute('contentType'),
        aset.getAttribute('mimeType'),
      );
      const asetLang = aset.getAttribute('lang') ?? undefined;

      aset.querySelectorAll('Representation').forEach((rep) => {
        const repBase = resolveChildBase(rep, asetBase);
        const mimeType =
          rep.getAttribute('mimeType') ?? aset.getAttribute('mimeType') ?? undefined;
        const type = asetType !== 'unknown' ? asetType : trackType(null, mimeType);
        representations.push({
          id: rep.getAttribute('id') ?? '',
          type,
          mimeType,
          codecs: rep.getAttribute('codecs') ?? aset.getAttribute('codecs') ?? undefined,
          bandwidth: numAttr(rep.getAttribute('bandwidth')),
          width: numAttr(rep.getAttribute('width') ?? aset.getAttribute('width')),
          height: numAttr(rep.getAttribute('height') ?? aset.getAttribute('height')),
          frameRate: frameRate(
            rep.getAttribute('frameRate') ?? aset.getAttribute('frameRate'),
          ),
          audioSamplingRate: numAttr(
            rep.getAttribute('audioSamplingRate') ??
              aset.getAttribute('audioSamplingRate'),
          ),
          language: asetLang,
          baseUrl: repBase,
        });
      });
    });
  });

  // Best video first, then audio.
  representations.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'video' ? -1 : 1;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });

  return { representations, durationSec };
}

// --- helpers ----------------------------------------------------------------

function resolveChildBase(el: Element, parentBase: string): string {
  // Only consider a direct-child <BaseURL>, not descendants.
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'BaseURL' && child.textContent) {
      return resolveUrl(child.textContent.trim(), parentBase);
    }
  }
  return parentBase;
}

function trackType(contentType: string | null, mimeType?: string | null): DashTrackType {
  const v = (contentType ?? '').toLowerCase();
  if (v === 'video' || v === 'audio' || v === 'text') return v;
  const m = (mimeType ?? '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/') || m.includes('vtt') || m.includes('ttml')) return 'text';
  return 'unknown';
}

function numAttr(v: string | null | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function frameRate(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  if (v.includes('/')) {
    const [a, b] = v.split('/').map(Number);
    return b ? a / b : undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
