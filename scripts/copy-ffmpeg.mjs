// Copy the ffmpeg.wasm core (js + wasm) into public/ffmpeg so Vite packages
// them into the extension. They're loaded at runtime via chrome.runtime.getURL
// (no CDN — extensions run offline and under a strict CSP). The ~30 MB wasm is
// not committed; this runs automatically before dev/build.
//
// @ffmpeg/ffmpeg creates its worker with `type: "module"`. Its initial
// importScripts(coreURL) call therefore fails by design and it falls back to a
// dynamic import, which requires the ESM core with a default export. Packaging
// the UMD build here makes FFmpeg.load() fail with
// "failed to import ffmpeg-core.js".
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const sources = resolveCore();
if (!sources) {
  console.error(
    '[copy-ffmpeg] Could not locate @ffmpeg/core. Try a clean reinstall:\n' +
      '    rm -rf node_modules package-lock.json && npm install',
  );
  process.exit(1);
}

const dest = join(root, 'public', 'ffmpeg');
mkdirSync(dest, { recursive: true });
copyFileSync(sources.js, join(dest, 'ffmpeg-core.js'));
console.log('public/ffmpeg/ffmpeg-core.js');
copyFileSync(sources.wasm, join(dest, 'ffmpeg-core.wasm'));
console.log('public/ffmpeg/ffmpeg-core.wasm');

/** @returns {{js: string, wasm: string} | undefined} */
function resolveCore() {
  // Use the package's resolved UMD entry only to locate its dist directory,
  // then deliberately select the ESM pair required by the module worker.
  try {
    const dist = dirname(dirname(require.resolve('@ffmpeg/core')));
    const js = join(dist, 'esm', 'ffmpeg-core.js');
    const wasm = join(dist, 'esm', 'ffmpeg-core.wasm');
    if (existsSync(js) && existsSync(wasm)) return { js, wasm };
  } catch {
    /* fall through to a manual scan */
  }

  const dir = join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm');
  const js = join(dir, 'ffmpeg-core.js');
  const wasm = join(dir, 'ffmpeg-core.wasm');
  return existsSync(js) && existsSync(wasm) ? { js, wasm } : undefined;
}
