// Resolve a possibly-relative URI against a manifest's base URL.
export function resolveUrl(uri: string, baseUrl: string): string {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
}

/** Parse an ISO 8601 duration (e.g. "PT1H2M3.5S") into seconds. */
export function parseISODuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/.exec(value.trim());
  if (!m) return undefined;
  const [, d, h, min, s] = m;
  const days = d ? Number(d) : 0;
  const hours = h ? Number(h) : 0;
  const mins = min ? Number(min) : 0;
  const secs = s ? Number(s) : 0;
  const total = days * 86400 + hours * 3600 + mins * 60 + secs;
  return Number.isFinite(total) ? total : undefined;
}
