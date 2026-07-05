/**
 * Persistence for the last successfully connected device (Phase 9.1).
 * Storage policy (sync, swallow failures) lives in kv.ts.
 */

import { readJson, removeKey, writeJson } from './kv';

const KEY = 'remembered-device.v1';

export interface RememberedDevice {
  id: string;
  name: string;
}

export function getRememberedDevice(): RememberedDevice | null {
  return readJson(KEY, (parsed) => {
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as RememberedDevice).id === 'string' &&
      typeof (parsed as RememberedDevice).name === 'string'
    ) {
      const { id, name } = parsed as RememberedDevice;
      return { id, name };
    }
    return null;
  });
}

export function rememberDevice(device: RememberedDevice): void {
  writeJson(KEY, device);
}

export function forgetRememberedDevice(): void {
  removeKey(KEY);
}
