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

/**
 * CoreBluetooth state-restoration key (Phase 10.3, ADR-008). With
 * bluetooth-central background mode on, iOS keeps a connection alive for an
 * app it evicted and relaunches the app into the background on BLE events —
 * but only hands the session back to a central manager created with the
 * same restoration identifier. Must never change between releases.
 * iOS-only; Android ignores it.
 */
const RESTORE_STATE_IDENTIFIER = 'open-posture-companion-ble';

export function getBleManager(): BleManager {
  if (!manager) {
    manager = new BleManager({
      restoreStateIdentifier: RESTORE_STATE_IDENTIFIER,
      // ble-plx only activates restoration when both options are present.
      // The callback itself is informational: reconciliation happens in
      // the device layer, which checks isDeviceConnected before dialing,
      // so a restored live link is adopted wherever the connect comes from.
      restoreStateFunction: (restoredState) => {
        if (__DEV__) {
          const ids =
            restoredState?.connectedPeripherals.map((device) => device.id) ??
            [];
          console.log('[manager] CoreBluetooth state restored:', ids);
        }
      },
    });
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

/**
 * Resolve true once the adapter reaches 'poweredOn'. iOS always reports
 * 'unknown' for a moment after BleManager creation (hardware-observed,
 * Phase 1), so any BLE call made straight after a cold start must wait on
 * this first — scanForDevices has its own equivalent gate. Resolves false
 * on a terminal state (off/unauthorized/unsupported) or on timeout;
 * transient 'unknown'/'resetting' keep waiting.
 */
export function waitForAdapterPoweredOn(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: Unsubscribe | null = null;
    const settle = (ready: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(ready);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    unsubscribe = onAdapterStateChange((state) => {
      if (state === 'poweredOn') {
        settle(true);
      } else if (
        state === 'poweredOff' ||
        state === 'unauthorized' ||
        state === 'unsupported'
      ) {
        settle(false);
      }
    });
    // The registration emits the current state immediately; if that
    // emission settled us synchronously, the unsubscribe above ran while
    // still null — release the subscription now.
    if (settled) {
      unsubscribe();
    }
  });
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
