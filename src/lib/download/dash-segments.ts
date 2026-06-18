// Enumerate the segment URLs for a chosen DASH representation.
//
// Supports the common addressing modes:
//   * SegmentTemplate + SegmentTimeline   (variable-duration segments)
//   * SegmentTemplate + @duration         (fixed-duration segments)
//   * SegmentList                          (explicit SegmentURL list)
//   * SegmentBase / plain BaseURL          (single self-contained file)
//
// SegmentTemplate/SegmentList may be declared on the AdaptationSet and
// inherited by the Representation. Relies on a DOMParser; popup and offscreen
// documents both provide one.

import { parseISODuration, resolveUrl } from '../url';
import type { ByteRange } from './hls-assembler';

export interface SegmentRef {
  url: string;
  byteRange?: ByteRange;
}

export interface DashSegments {
  init?: SegmentRef;
  media: SegmentRef[];
}

export function buildDashSegments(
  xmlText: string,
  baseUrl: string,
  representationId: string,
): DashSegments {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const rep = findRepresentation(doc, representationId);
  if (!rep) throw new Error(`Representation "${representationId}" not found.`);

  const aset = rep.parentElement;
  const period = aset?.parentElement;
  const mpd = doc.querySelector('MPD');

  // Resolve the BaseURL chain MPD > Period > AdaptationSet > Representation.
  let base = baseUrl;
  for (const el of [mpd, period, aset, rep]) {
    if (el) base = childBase(el, base);
  }

  const bandwidth = rep.getAttribute('bandwidth') ?? '';
  const periodDurationSec =
    parseISODuration(period?.getAttribute('duration')) ??
    parseISODuration(mpd?.getAttribute('mediaPresentationDuration')) ??
    0;

  const template = childOf(rep, 'SegmentTemplate') ?? childOf(aset, 'SegmentTemplate');
  if (template) {
    return fromTemplate(template, base, representationId, bandwidth, periodDurationSec);
  }

  const list = childOf(rep, 'SegmentList') ?? childOf(aset, 'SegmentList');
  if (list) {
    return fromSegmentList(list, base);
  }

  // SegmentBase or a bare BaseURL: the representation is a single file.
  return { media: [{ url: base }] };
}

// --- SegmentTemplate --------------------------------------------------------

function fromTemplate(
  template: Element,
  base: string,
  repId: string,
  bandwidth: string,
  periodDurationSec: number,
): DashSegments {
  const media = template.getAttribute('media') ?? '';
  const initTpl = template.getAttribute('initialization');
  const timescale = num(template.getAttribute('timescale')) ?? 1;
  const startNumber = num(template.getAttribute('startNumber')) ?? 1;
  const durationAttr = num(template.getAttribute('duration'));

  const init = initTpl
    ? { url: resolveUrl(fill(initTpl, { repId, bandwidth }), base) }
    : undefined;

  const timeline = childOf(template, 'SegmentTimeline');
  const segs: SegmentRef[] = [];

  if (timeline) {
    let number = startNumber;
    let time = 0;
    for (const s of Array.from(timeline.children).filter((c) => c.tagName === 'S')) {
      const t = num(s.getAttribute('t'));
      const d = num(s.getAttribute('d')) ?? 0;
      let r = num(s.getAttribute('r')) ?? 0;
      if (t !== undefined) time = t;
      if (r < 0) {
        // Repeat until the end of the period.
        const end = periodDurationSec * timescale;
        r = d > 0 ? Math.max(0, Math.ceil((end - time) / d) - 1) : 0;
      }
      for (let k = 0; k <= r; k++) {
        segs.push({ url: resolveUrl(fill(media, { repId, bandwidth, number, time }), base) });
        time += d;
        number++;
      }
    }
  } else if (durationAttr && durationAttr > 0) {
    const count = Math.ceil((periodDurationSec * timescale) / durationAttr);
    for (let i = 0; i < count; i++) {
      const number = startNumber + i;
      const time = i * durationAttr;
      segs.push({ url: resolveUrl(fill(media, { repId, bandwidth, number, time }), base) });
    }
  }

  return { init, media: segs };
}

// --- SegmentList ------------------------------------------------------------

function fromSegmentList(list: Element, base: string): DashSegments {
  const initEl = childOf(list, 'Initialization');
  const initSource = initEl?.getAttribute('sourceURL');
  const init = initSource
    ? { url: resolveUrl(initSource, base), byteRange: parseRange(initEl?.getAttribute('range')) }
    : undefined;

  const media: SegmentRef[] = [];
  for (const su of Array.from(list.children).filter((c) => c.tagName === 'SegmentURL')) {
    const url = su.getAttribute('media');
    if (!url) continue;
    media.push({ url: resolveUrl(url, base), byteRange: parseRange(su.getAttribute('mediaRange')) });
  }
  return { init, media };
}

// --- template substitution --------------------------------------------------

interface TemplateVars {
  repId: string;
  bandwidth: string;
  number?: number;
  time?: number;
}

const TOKEN = /\$(\$|RepresentationID|Bandwidth|Number|Time)(%0\d+[diouxX])?\$/g;

function fill(tpl: string, vars: TemplateVars): string {
  return tpl.replace(TOKEN, (match, name: string, fmt?: string) => {
    if (name === '$') return '$';
    const value =
      name === 'RepresentationID'
        ? vars.repId
        : name === 'Bandwidth'
          ? vars.bandwidth
          : name === 'Number'
            ? vars.number
            : vars.time;
    if (value === undefined || value === '') return match;
    if (fmt) {
      const width = parseInt(fmt.slice(2), 10);
      return String(value).padStart(width, '0');
    }
    return String(value);
  });
}

// --- helpers ----------------------------------------------------------------

function findRepresentation(doc: Document, id: string): Element | null {
  for (const rep of Array.from(doc.querySelectorAll('Representation'))) {
    if (rep.getAttribute('id') === id) return rep;
  }
  return null;
}

function childOf(el: Element | null | undefined, tag: string): Element | null {
  if (!el) return null;
  for (const c of Array.from(el.children)) {
    if (c.tagName === tag) return c;
  }
  return null;
}

function childBase(el: Element, parentBase: string): string {
  const b = childOf(el, 'BaseURL');
  return b?.textContent ? resolveUrl(b.textContent.trim(), parentBase) : parentBase;
}

function parseRange(range: string | null | undefined): ByteRange | undefined {
  if (!range) return undefined;
  const [a, b] = range.split('-').map((n) => parseInt(n, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return { offset: a, length: b - a + 1 };
}

function num(v: string | null | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
