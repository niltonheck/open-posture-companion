/**
 * Persistence for the demo-mode flag: a hidden About-screen gesture enables
 * a simulated device for App Store review and screenshot sessions (no
 * hardware required). Persisted — not in-memory — so the flag survives the
 * reviewer backgrounding or relaunching the app mid-review.
 * Storage policy (sync, swallow failures) lives in kv.ts.
 */

import { readJson, removeKey, writeJson } from './kv';

const KEY = 'demo-mode.v1';

let cached: boolean | null = null;

export function isDemoMode(): boolean {
  cached ??=
    readJson(KEY, (parsed) => (parsed === true ? true : null)) ?? false;
  return cached;
}

export function setDemoMode(enabled: boolean): void {
  if (enabled) {
    writeJson(KEY, true);
  } else {
    removeKey(KEY);
  }
  cached = enabled;
}
