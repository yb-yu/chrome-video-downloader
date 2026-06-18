import type { MediaItem } from '../lib/types';

const RULE_ID_BASE = 100_000;
const RULE_ID_RANGE = 900_000;

/**
 * Extension-page fetches do not inherit the tab's Referer. Some media CDNs
 * reject those requests, so restore the page Referer for the detected host.
 */
export async function prepareMediaReferrers(items: MediaItem[]): Promise<void> {
  const byHost = new Map<string, { host: string; pageUrl: string }>();

  for (const item of items) {
    if ((item.type !== 'hls' && item.type !== 'dash') || !item.pageUrl) continue;
    const host = hostname(item.url);
    const pageUrl = referrerUrl(item.pageUrl);
    if (host && pageUrl) byHost.set(host, { host, pageUrl });
  }

  // Two hosts can hash to the same rule id; addRules rejects duplicate ids, so
  // collapse by id (last write wins) before applying.
  const byId = new Map<number, chrome.declarativeNetRequest.Rule>();
  for (const entry of byHost.values()) {
    const rule = buildRule(entry);
    byId.set(rule.id, rule);
  }
  const rules = [...byId.values()];
  if (rules.length === 0) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: rules.map((rule) => rule.id),
    addRules: rules,
  });
}

function buildRule(entry: { host: string; pageUrl: string }): chrome.declarativeNetRequest.Rule {
  return {
    id: ruleIdForHost(entry.host),
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
      requestHeaders: [
        {
          header: 'Referer',
          operation: chrome.declarativeNetRequest.HeaderOperation.SET,
          value: entry.pageUrl,
        },
      ],
    },
    condition: {
      initiatorDomains: [chrome.runtime.id],
      requestDomains: [entry.host],
      resourceTypes: [
        chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST,
        chrome.declarativeNetRequest.ResourceType.MEDIA,
        chrome.declarativeNetRequest.ResourceType.OTHER,
      ],
    },
  };
}

function ruleIdForHost(host: string): number {
  let hash = 2166136261;
  for (const char of host) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return RULE_ID_BASE + ((hash >>> 0) % RULE_ID_RANGE);
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function referrerUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}
