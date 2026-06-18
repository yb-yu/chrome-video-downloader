// Real-time media detection via the webRequest API.
//
// The page scan (rescan.ts) only runs when the popup opens and relies on the
// Performance timeline / DOM, so streams that an embedded player fetches by
// XHR (e.g. hls.js loading a playlist.m3u8 inside a cross-origin <iframe>)
// are easily missed. This listener observes every request as it happens and
// records HLS/DASH/progressive media the moment it flies by.
//
// Requires the `webRequest` permission plus host access for the observed URLs
// (granted via host_permissions in the manifest). It must be registered
// synchronously at service-worker startup so it survives MV3 suspension.

import { classifyMediaUrl } from '../lib/media';
import { addItem, clearTab, newItem } from './registry';

export function registerNetworkSniffer(): void {
  if (!chrome.webRequest?.onBeforeRequest) return;
  chrome.webRequest.onBeforeRequest.addListener(handleRequest, {
    urls: ['http://*/*', 'https://*/*'],
  });
}

function handleRequest(details: chrome.webRequest.WebRequestBodyDetails): void {
  const { tabId, url, type } = details;
  if (tabId < 0) return; // requests not attached to a tab (e.g. the SW itself)

  // A top-level navigation starts a new page; drop the previous page's media so
  // the popup doesn't show stale detections from before the navigation.
  if (type === 'main_frame') {
    void clearTab(tabId);
    return;
  }

  const mediaType = classifyMediaUrl(url);
  if (!mediaType) return;
  void recordMedia(tabId, url, mediaType, details);
}

async function recordMedia(
  tabId: number,
  url: string,
  type: ReturnType<typeof classifyMediaUrl> & string,
  details: chrome.webRequest.WebRequestBodyDetails,
): Promise<void> {
  // The frame that issued the request is the correct Referer for hotlink-
  // protected CDNs; the tab title gives a nicer default filename.
  let pageUrl: string | undefined = details.initiator;
  let pageTitle: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    pageTitle = tab.title;
    if (!pageUrl) pageUrl = tab.url;
  } catch {
    // Tab may have closed between the request and this lookup; keep going.
  }

  await addItem(
    newItem(tabId, url, {
      type,
      pageUrl,
      pageTitle,
      source: 'active-tab',
    }),
  );
}
