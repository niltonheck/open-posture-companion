/**
 * Shared device context (Phase 2.1): a single UprightGoDevice instance
 * app-wide, plus the UI-flow half of the connection state machine
 * (permissions, scanning, device list) composed with the device-owned half
 * (docs/architecture.html).
 *
 * Nothing here touches BLE at mount — instantiating BleManager triggers the
 * iOS permission prompt (see src/device/manager.ts), so every manager access
 * sits behind a user action.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  destroyBleManager,
  getBleManager,
  onAdapterStateChange,
  requestBlePermissions,
} from '@/device/manager';
import { scanForDevices, type ScanHandle } from '@/device/scan';
import type {
  AdapterState,
  ConnectionState,
  DeviceConnectionState,
  DiscoveredDevice,
  Unsubscribe,
} from '@/device/types';
import { UprightGoDevice } from '@/device/UprightGoDevice';

/**
 * Scan lifecycle, kept separate from ConnectionState so screens can tell
 * "never scanned" apart from "scan finished empty" (needed by the selection
 * screen's empty/timeout states).
 */
export type ScanStatus = 'idle' | 'scanning' | 'timed_out' | 'error';

export interface DeviceContextValue {
  /** Composed connection state machine from docs/architecture.html. */
  connectionState: ConnectionState;
  scanStatus: ScanStatus;
  /** Devices found by the current/most recent scan, in discovery order. */
  devices: DiscoveredDevice[];
  /** The shared device instance; null until the first connect attempt. */
  device: UprightGoDevice | null;
  /**
   * True while the Bluetooth adapter is known to be off. Only meaningful
   * after the first scan attempt — the adapter watch starts lazily with the
   * manager (iOS permission-prompt constraint), so screens shown before any
   * scan see false regardless of the real adapter state.
   */
  bluetoothOff: boolean;
  startScan: () => void;
  stopScan: () => void;
  connect: (target: DiscoveredDevice) => Promise<void>;
  disconnect: () => Promise<void>;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

/**
 * Compose the device-owned lifecycle states with the hook-owned UI-flow
 * states into the documented machine. Pure; priority order matters: a live
 * or in-progress connection outranks everything, then permissions, then the
 * scan flow. 'action_success'/'action_error' are never produced here:
 * Phase 3 wired action feedback as screen-local state instead (recorded in
 * notes/phase-3.md); the union members remain because they are part of the
 * documented machine (docs/architecture.html) and Phase 4.1's error
 * handling may still adopt them.
 */
function deriveConnectionState(
  deviceState: DeviceConnectionState | null,
  permissionDenied: boolean,
  adapterState: AdapterState,
  scanStatus: ScanStatus,
  deviceCount: number,
): ConnectionState {
  if (
    deviceState === 'connecting' ||
    deviceState === 'connected' ||
    deviceState === 'calibrating' ||
    deviceState === 'reconnecting'
  ) {
    return deviceState;
  }
  if (permissionDenied || adapterState === 'unauthorized') {
    return 'permission_needed';
  }
  if (scanStatus === 'scanning') {
    return deviceCount > 0 ? 'device_found' : 'scanning';
  }
  if (deviceState === 'disconnected') {
    return 'disconnected';
  }
  return deviceCount > 0 ? 'device_found' : 'idle';
}

export function DeviceProvider({ children }: { children: React.ReactNode }) {
  const [deviceState, setDeviceState] = useState<DeviceConnectionState | null>(
    null,
  );
  const [adapterState, setAdapterState] = useState<AdapterState>('unknown');
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);
  const [device, setDevice] = useState<UprightGoDevice | null>(null);

  const deviceRef = useRef<UprightGoDevice | null>(null);
  const scanRef = useRef<ScanHandle | null>(null);
  // Bumped on every start/stop so a startScan suspended on the permission
  // prompt can tell it was superseded (its scan handle doesn't exist yet,
  // so stopScan alone can't reach it).
  const scanSessionRef = useRef(0);
  const adapterUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const deviceUnsubscribeRef = useRef<Unsubscribe | null>(null);

  const stopScan = useCallback(() => {
    scanSessionRef.current += 1;
    scanRef.current?.stop();
    scanRef.current = null;
    setScanStatus((status) => (status === 'scanning' ? 'idle' : status));
  }, []);

  const startScan = useCallback(() => {
    const session = (scanSessionRef.current += 1);
    // Clear synchronously — the previous scan's entries must not stay
    // rendered (and tappable) while the permission request below is
    // pending; a stale entry may no longer be reachable.
    setDevices([]);
    void (async () => {
      const granted = await requestBlePermissions();
      setPermissionDenied(!granted);
      if (!granted || scanSessionRef.current !== session) {
        return;
      }
      // iOS never reports a permission denial from requestBlePermissions; it
      // shows up as adapter state 'unauthorized' instead, so this watch is
      // the real permission signal there. Started on first scan, not mount.
      adapterUnsubscribeRef.current ??= onAdapterStateChange((state) => {
        setAdapterState(state);
        if (state === 'poweredOff') {
          // Entries found before the radio went off may be gone when it
          // returns — never leave them rendered and tappable.
          setDevices([]);
        }
      });
      scanRef.current?.stop();
      setScanStatus('scanning');
      scanRef.current = scanForDevices({
        onDevice: (found) =>
          setDevices((previous) => {
            const index = previous.findIndex((d) => d.id === found.id);
            if (index === -1) {
              return [...previous, found];
            }
            if (previous[index].signal === found.signal) {
              // RSSI jitter within the same displayed bucket — advertisements
              // repeat several times a second; don't churn every consumer.
              return previous;
            }
            const next = [...previous];
            next[index] = found;
            return next;
          }),
        onTimeout: () => setScanStatus('timed_out'),
        onError: () => setScanStatus('error'),
      });
    })();
  }, []);

  const connect = useCallback(
    async (target: DiscoveredDevice) => {
      stopScan();
      let instance = deviceRef.current;
      if (!instance || instance.id !== target.id) {
        // Release the previous device first — a connected Upright GO stops
        // advertising, so a leaked link could never be found by a rescan.
        await deviceRef.current?.disconnect();
        instance = new UprightGoDevice(getBleManager(), target.id, target.name);
        deviceRef.current = instance;
        setDevice(instance);
        deviceUnsubscribeRef.current?.();
        deviceUnsubscribeRef.current =
          instance.onConnectionStateChange(setDeviceState);
      }
      await instance.connect();
      // The selection list is consumed by a successful connect; keeping it
      // would resurrect 'device_found' after a later disconnect.
      setDevices([]);
    },
    [stopScan],
  );

  const disconnect = useCallback(async () => {
    await deviceRef.current?.disconnect();
  }, []);

  useEffect(
    () => () => {
      scanRef.current?.stop();
      adapterUnsubscribeRef.current?.();
      deviceUnsubscribeRef.current?.();
      // Tear the device down before its transport — teardown() runs
      // synchronously in disconnect(), so monitors and state are cleaned
      // before the manager is destroyed out from under them.
      void deviceRef.current?.disconnect();
      destroyBleManager();
    },
    [],
  );

  const connectionState = deriveConnectionState(
    deviceState,
    permissionDenied,
    adapterState,
    scanStatus,
    devices.length,
  );

  const bluetoothOff = adapterState === 'poweredOff';

  const value = useMemo<DeviceContextValue>(
    () => ({
      connectionState,
      scanStatus,
      devices,
      device,
      bluetoothOff,
      startScan,
      stopScan,
      connect,
      disconnect,
    }),
    [
      connectionState,
      scanStatus,
      devices,
      device,
      bluetoothOff,
      startScan,
      stopScan,
      connect,
      disconnect,
    ],
  );

  return (
    <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>
  );
}

export function useDevice(): DeviceContextValue {
  const context = useContext(DeviceContext);
  if (!context) {
    throw new Error('useDevice must be used within <DeviceProvider>');
  }
  return context;
}
