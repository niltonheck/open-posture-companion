/**
 * BleManager singleton lifecycle, adapter state, and runtime permissions.
 *
 * The manager is created lazily: instantiating BleManager on iOS triggers the
 * Bluetooth permission prompt, so nothing here runs at import time.
 */

import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, State } from 'react-native-ble-plx';

import type { AdapterState, Unsubscribe } from './types';

let manager: BleManager | null = null;

export function getBleManager(): BleManager {
  if (!manager) {
    manager = new BleManager();
  }
  return manager;
}

export function destroyBleManager(): void {
  manager?.destroy();
  manager = null;
}

/**
 * Request the runtime permissions BLE needs, returning whether they were
 * granted. Call right before the first scan, not at startup.
 *
 * iOS has no runtime-request API — the OS prompts on first BLE use with the
 * usage string from app.json, so this always returns true there; a denial
 * surfaces as adapter state 'unauthorized' via onAdapterStateChange, which
 * callers must treat as the permission signal. Android 12+ needs
 * BLUETOOTH_SCAN/BLUETOOTH_CONNECT; Android ≤11 needs fine location for
 * scanning despite `neverForLocation` (ADR-004 consequence).
 */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') {
    return true;
  }
  if (Number(Platform.Version) >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(results).every(
      (status) => status === PermissionsAndroid.RESULTS.GRANTED,
    );
  }
  const status = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return status === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Subscribe to adapter state changes. Emits the current state immediately,
 * so callers can gate on `poweredOn` without a separate read.
 */
export function onAdapterStateChange(
  callback: (state: AdapterState) => void,
): Unsubscribe {
  const subscription = getBleManager().onStateChange(
    (state) => callback(toAdapterState(state)),
    true,
  );
  return () => subscription.remove();
}

function toAdapterState(state: State): AdapterState {
  switch (state) {
    case State.PoweredOn:
      return 'poweredOn';
    case State.PoweredOff:
      return 'poweredOff';
    case State.Unauthorized:
      return 'unauthorized';
    case State.Unsupported:
      return 'unsupported';
    case State.Resetting:
      return 'resetting';
    default:
      return 'unknown';
  }
}
