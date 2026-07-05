/**
 * Shared JSON read/write over expo-sqlite's key-value store. One place for
 * the storage policy: sync access (no async loading flashes), and failures
 * are logged and swallowed — persistence is a convenience layer and a
 * broken disk must never break the feature on top of it.
 */

import Storage from 'expo-sqlite/kv-store';

export function readJson<T>(
  key: string,
  validate: (value: unknown) => T | null,
): T | null {
  try {
    const raw = Storage.getItemSync(key);
    if (raw) {
      return validate(JSON.parse(raw));
    }
  } catch (error) {
    console.log(`[storage] read failed for ${key}:`, error);
  }
  return null;
}

export function writeJson(key: string, value: unknown): void {
  try {
    Storage.setItemSync(key, JSON.stringify(value));
  } catch (error) {
    console.log(`[storage] write failed for ${key}:`, error);
  }
}

export function removeKey(key: string): void {
  try {
    Storage.removeItemSync(key);
  } catch (error) {
    console.log(`[storage] remove failed for ${key}:`, error);
  }
}
