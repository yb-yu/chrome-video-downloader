import type { MediaType } from '../lib/types';
import { addItem, newItem } from './registry';

interface ScannedMedia {
  url: string;
  type: MediaType;
  durationSec?: number;
  pageAttached?: boolean;
  /** URL of the frame the media was found in (top document or an iframe). */
  frameUrl?: string;
}

/**
 * Recover media already loaded before the extension/content scripts became
 * active. This is best-effort: browsers retain resource URLs in the
 * Performance timeline, but sites may clear that buffer.
 */
export async function rescanTab(tabId: number): Promise<void> {
  let results: chrome.scripting.InjectionResult<ScannedMedia[]>[];
  try {
    // allFrames so embedded players (hls.js/DASH in a cross-origin <iframe>)
    // are scanned too — those frames load the manifest the top document never
    // sees. activeTab grants access to every frame in the active tab.
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: scanPageMedia,
    });
  } catch {
    // Restricted pages such as chrome:// cannot be inspected.
    return;
  }

  let pageUrl: string | undefined;
  let pageTitle: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    pageUrl = tab.url;
    pageTitle = tab.title;
  } catch {
    return;
  }

  for (const media of results.flatMap(({ result }) => result ?? [])) {
    await addItem(
      newItem(tabId, media.url, {
        type: media.type,
        durationSec: media.durationSec,
        pageAttached: media.pageAttached,
        // Media from an iframe must use that frame's URL as Referer; the top
        // page URL would trip hotlink protection on many embedded players.
        pageUrl: media.frameUrl ?? pageUrl,
        pageTitle,
        source: 'active-tab',
      }),
    );
  }
}

/**
 * This function is serialized by chrome.scripting and runs without module
 * imports, so keep all classification logic self-contained.
 */
export function scanPageMedia(): ScannedMedia[] {
  const found = new Map<string, ScannedMedia>();
  const MAX_RESULTS = 100;
  const MAX_SCRIPT_TEXT = 2 * 1024 * 1024;
  const frameUrl = location.href;

  const classify = (url: string): MediaType | undefined => {
    if (url.startsWith('blob:')) return 'blob';
    if (!/^https?:/i.test(url)) return undefined;
    if (/\.(ts|m4s|aac|m4a)(\?|#|$)/i.test(url)) return undefined;
    if (
      /(?:^|\/)(?:init(?:ialization)?|fileSequence0|segment[-_]?\d+)[^/]*\.mp4(\?|#|$)/i.test(
        url,
      )
    ) {
      return undefined;
    }
    if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
    if (/\.(mp4|m4v|mov)(\?|#|$)/i.test(url)) return 'mp4';
    if (/\.webm(\?|#|$)/i.test(url)) return 'webm';
    return undefined;
  };

  const normalize = (raw: string): string => {
    let value = raw
      .trim()
      .replace(/^['"`]|['"`]$/g, '')
      .replace(/\\u002[fF]/g, '/')
      .replace(/\\u0026/g, '&')
      .replace(/\\\//g, '/')
      .replace(/\\x2[fF]/g, '/')
      .replace(/[),;\]}]+$/, '');
    if (!value) return '';
    try {
      if (value.startsWith('//')) value = `${location.protocol}${value}`;
      return new URL(value, document.baseURI || location.href).href;
    } catch {
      return '';
    }
  };

  const add = (raw: string, durationSec?: number, pageAttached = false) => {
    if (found.size >= MAX_RESULTS) return;
    const url = normalize(raw);
    if (!url) return;
    const type = classify(url);
    if (!type) return;
    const previous = found.get(url);
    found.set(url, {
      url,
      type,
      durationSec: durationSec ?? previous?.durationSec,
      pageAttached: Boolean(pageAttached || previous?.pageAttached),
      frameUrl,
    });
  };

  for (const video of Array.from(document.querySelectorAll('video'))) {
    const duration =
      Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
    add(video.currentSrc || video.src, duration, true);
    for (const source of Array.from(video.querySelectorAll('source'))) {
      add(source.src, duration, true);
    }
  }

  // Many lazy players keep the real URL in data-* attributes, preload links,
  // OpenGraph tags, or JSON configuration until the user presses play.
  for (const element of Array.from(document.querySelectorAll('*'))) {
    const attached =
      element instanceof HTMLVideoElement || element instanceof HTMLSourceElement;
    for (const attr of Array.from(element.attributes)) {
      if (/\.(m3u8|mpd|mp4|m4v|mov|webm)(?:[?#]|$)/i.test(attr.value)) {
        add(attr.value, undefined, attached);
      }
    }
  }

  let scriptBytes = 0;
  const scanQuotedValues = (text: string, pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      add(match[1]);
      if (found.size >= MAX_RESULTS) return;
    }
  };
  for (const script of Array.from(document.scripts)) {
    const text = script.textContent ?? '';
    if (!text || scriptBytes >= MAX_SCRIPT_TEXT) continue;
    const remaining = MAX_SCRIPT_TEXT - scriptBytes;
    const chunk = text.slice(0, remaining);
    scriptBytes += chunk.length;
    scanQuotedValues(chunk, /"((?:\\.|[^"\\]){1,2048})"/g);
    scanQuotedValues(chunk, /'((?:\\.|[^'\\]){1,2048})'/g);
    for (const match of chunk.matchAll(/(https?:\\?\/\\?\/[^\s"'<>]{1,2048})/gi)) {
      add(match[1]);
      if (found.size >= MAX_RESULTS) break;
    }
    if (found.size >= MAX_RESULTS) break;
  }

  for (const entry of performance.getEntriesByType('resource')) {
    add(entry.name);
  }

  return Array.from(found.values());
}
