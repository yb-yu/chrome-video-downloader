// AES-128 decryption for HLS segments (#EXT-X-KEY:METHOD=AES-128).

export async function importAes128Key(raw: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
}

export async function decryptAes128Cbc(
  data: ArrayBuffer,
  key: CryptoKey,
  iv: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
}

/**
 * Default HLS IV when none is given in #EXT-X-KEY: the segment's media
 * sequence number as a 16-byte big-endian value.
 */
export function ivFromSequence(seq: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  let n = BigInt(seq);
  for (let i = 15; i >= 0 && n > 0n; i--) {
    iv[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return iv;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/^0x/i, '');
  const out = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
