/**
 * Base64 helpers for ble-plx characteristic values, which are exchanged as
 * base64 strings. Deliberately pure TS instead of Hermes' btoa/atob: these
 * are unit-verifiable off-device, and payload corruption here would be
 * indistinguishable from a protocol bug during hardware sessions.
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const CHAR_TO_VALUE = new Map(
  [...ALPHABET].map((char, index) => [char, index]),
);

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let bitCount = 0;
  let index = 0;
  for (const char of clean) {
    const value = CHAR_TO_VALUE.get(char);
    if (value === undefined) {
      throw new Error(`Invalid base64 character: ${char}`);
    }
    bits = (bits << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[index++] = (bits >> bitCount) & 0xff;
    }
  }
  return bytes;
}

/** Hex dump for logging raw payloads, e.g. "02 00 1a". */
export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
