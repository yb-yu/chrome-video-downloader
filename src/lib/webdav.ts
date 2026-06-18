export function normalizeWebDavUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('WebDAV URL must use http or https.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href.replace(/\/$/, '');
}

export function webDavFileUrl(folderUrl: string, filename: string): string {
  const base = normalizeWebDavUrl(folderUrl);
  return `${base}/${encodeURIComponent(filename)}`;
}

export function webDavTempUrl(
  folderUrl: string,
  filename: string,
  jobId: string,
): string {
  return webDavFileUrl(folderUrl, `.${filename}.${jobId}.part`);
}

export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}
