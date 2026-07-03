/**
 * Scanning for Upright GO devices, filtered by advertised name.
 */

import { DEVICE_NAME } from './characteristics';
import { getBleManager, onAdapterStateChange } from './manager';
import type { DiscoveredDevice, SignalStrength } from './types';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ScanOptions {
  /** Called for each matching advertisement; repeats per device as RSSI updates. */
  onDevice: (device: DiscoveredDevice) => void;
  /** Called once if the timeout elapses. The scan is already stopped. */
  onTimeout?: () => void;
  /** Called once on scan failure. The scan is already stopped. */
  onError?: (error: Error) => void;
  timeoutMs?: number;
}

export interface ScanHandle {
  stop: () => void;
}

export function scanForDevices(options: ScanOptions): ScanHandle {
  const manager = getBleManager();
  let stopped = false;
  let scanning = false;
  let unsubscribeAdapter: () => void = () => {};

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(timer);
    unsubscribeAdapter();
    if (scanning) {
      manager.stopDeviceScan();
    }
  };

  const timer = setTimeout(() => {
    stop();
    options.onTimeout?.();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const fail = (error: Error) => {
    stop();
    options.onError?.(error);
  };

  const startScan = () => {
    scanning = true;
    manager
      .startDeviceScan(null, null, (error, device) => {
        if (stopped) {
          return; // Late callbacks after stop()/timeout must not re-emit.
        }
        if (error) {
          fail(error);
          return;
        }
        // The OS-cached GAP name and the advertised local name can differ;
        // accept a match on either.
        if (
          !device ||
          (device.name !== DEVICE_NAME && device.localName !== DEVICE_NAME)
        ) {
          return;
        }
        options.onDevice({
          id: device.id,
          name: DEVICE_NAME,
          rssi: device.rssi,
          signal: signalFromRssi(device.rssi),
        });
      })
      .catch((error: unknown) => {
        // The scan call itself can reject without ever invoking the listener.
        if (!stopped) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
  };

  // Scanning before the adapter reaches 'poweredOn' fails — on iOS the
  // central always starts in 'unknown' for a moment after creation. Start
  // on the poweredOn edge; 'poweredOff'/'resetting'/'unknown' just wait
  // (the user may still enable Bluetooth) until the timeout reports.
  unsubscribeAdapter = onAdapterStateChange((state) => {
    if (stopped || scanning) {
      return;
    }
    if (state === 'unsupported' || state === 'unauthorized') {
      fail(new Error(`Bluetooth is ${state}`));
      return;
    }
    if (state === 'poweredOn') {
      startScan();
    }
  });

  return { stop };
}

export function signalFromRssi(rssi: number | null): SignalStrength {
  if (rssi === null) {
    return 'weak';
  }
  if (rssi >= -60) {
    return 'strong';
  }
  if (rssi >= -80) {
    return 'medium';
  }
  return 'weak';
}
