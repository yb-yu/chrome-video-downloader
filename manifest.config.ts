import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Chrome Video Downloader',
  version: pkg.version,
  description: pkg.description,
  icons: {
    128: 'icons/128x128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_icon: 'icons/128x128.png',
  },
  // ffmpeg.wasm runs in the offscreen document; WebAssembly compilation needs
  // 'wasm-unsafe-eval' under MV3's extension-page CSP.
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  permissions: [
    'activeTab',
    'storage',
    'downloads',
    'scripting',
    'offscreen',
    // Observe network requests in real time so streams an embedded player
    // fetches by XHR (e.g. hls.js in an iframe) are detected as they load.
    'webRequest',
    // Inject the page Referer on extension-initiated media requests so
    // hotlink-protected CDNs don't return 403.
    'declarativeNetRequestWithHostAccess',
  ],
  // Real-time detection needs to see requests across all hosts up front, so
  // host access is required rather than optional.
  host_permissions: ['http://*/*', 'https://*/*'],
});
