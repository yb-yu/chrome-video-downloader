// Per-tab registry of detected media items.
//
// We use chrome.storage.session as the source of truth (not just in-memory
// state) because MV3 service workers are torn down after ~30s idle; session
// storage survives those restarts while still being cleared when the browser
// closes.

import type { MediaItem } from '../lib/types';
import { mediaId } from '../lib/media';

const keyForTab = (tabId: number) => `tab:${tabId}`;

export async function getItems(tabId: number): Promise<MediaItem[]> {
  const key = keyForTab(tabId);
  const got = await chrome.storage.session.get(key);
  return (got[key] as MediaItem[] | undefined) ?? [];
}

/**
 * Insert a media item for a tab, de-duplicating by url. Returns true if the
 * item was newly added (so callers can refresh the badge only when needed).
 */
export async function addItem(item: MediaItem): Promise<boolean> {
  const items = await getItems(item.tabId);
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    // Merge: keep earliest detectedAt, fill in any newly-known fields.
    const existing = items[idx];
    const merged = {
      ...existing,
      contentType: item.contentType ?? existing.contentType,
      sizeBytes: item.sizeBytes ?? existing.sizeBytes,
      durationSec: item.durationSec ?? existing.durationSec,
      pageAttached: item.pageAttached || existing.pageAttached,
      pageUrl: item.pageUrl ?? existing.pageUrl,
      pageTitle: item.pageTitle ?? existing.pageTitle,
    };
    if (
      merged.contentType === existing.contentType &&
      merged.sizeBytes === existing.sizeBytes &&
      merged.durationSec === existing.durationSec &&
      merged.pageAttached === existing.pageAttached &&
      merged.pageUrl === existing.pageUrl &&
      merged.pageTitle === existing.pageTitle
    ) {
      return false;
    }
    items[idx] = merged;
    await write(item.tabId, items);
    return false;
  }

  // Blob/MSE entries are only placeholders; the actual HLS/DASH/direct URL is
  // the useful download target. Avoid showing both once either side is known.
  if (item.type === 'blob' && items.some((existing) => existing.type !== 'blob')) {
    return false;
  }
  const nextItems =
    item.type === 'blob' ? items : items.filter((existing) => existing.type !== 'blob');
  nextItems.push(item);
  await write(item.tabId, nextItems);
  await updateBadge(item.tabId, nextItems.length);
  return true;
}

export async function clearTab(tabId: number): Promise<void> {
  await chrome.storage.session.remove(keyForTab(tabId));
  await updateBadge(tabId, 0);
}

async function write(tabId: number, items: MediaItem[]): Promise<void> {
  await chrome.storage.session.set({ [keyForTab(tabId)]: items });
}

export function newItem(
  tabId: number,
  url: string,
  partial: Omit<MediaItem, 'id' | 'tabId' | 'url' | 'detectedAt'>,
): MediaItem {
  return {
    id: mediaId(tabId, url),
    tabId,
    url,
    detectedAt: Date.now(),
    ...partial,
  };
}

async function updateBadge(tabId: number, count: number): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025', tabId });
    await chrome.action.setBadgeText({
      tabId,
      text: count > 0 ? String(Math.min(count, 99)) : '',
    });
  } catch {
    // Tab may be gone; ignore.
  }
}
