// Build a safe download filename from a page title / URL + media type.

import type { MediaType } from './types';

const EXT_FOR_TYPE: Partial<Record<MediaType, string>> = {
  mp4: 'mp4',
  webm: 'webm',
  hls: 'mp4',
  dash: 'mp4',
};

const ILLEGAL = new RegExp('[<>:"/\\\\|?*\\x00-\\x1f]', 'g');

export function sanitizeFilename(
  title: string | undefined,
  url: string,
  mediaType: MediaType,
): string {
  const ext = extensionFor(url, mediaType);
  let base = (title || filenameFromUrl(url) || 'video').trim();

  // Drop an existing matching extension so we don't double it up.
  base = base.replace(new RegExp(`\\.${ext}$`, 'i'), '');
  base = base
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .trim();

  if (!base) base = 'video';
  if (base.length > 120) base = base.slice(0, 120).trim();

  return `${base}.${ext}`;
}

function extensionFor(url: string, mediaType: MediaType): string {
  const fromType = EXT_FOR_TYPE[mediaType];
  if (fromType) return fromType;
  const m = /\.(mp4|m4v|mov|webm)(\?|#|$)/i.exec(url);
  if (m) {
    const e = m[1].toLowerCase();
    return e === 'm4v' || e === 'mov' ? 'mp4' : e;
  }
  return 'mp4';
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last).replace(/\.[a-z0-9]{1,5}$/i, '');
  } catch {
    return '';
  }
}
