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
import { AppState } from 'react-native';

import {
  createDemoTransport,
  DEMO_DEVICE_ID,
  DEMO_DISCOVERED_DEVICE,
} from '@/device/demoTransport';
import {
  destroyBleManager,
  getBleManager,
  onAdapterStateChange,
  requestBlePermissions,
  waitForAdapterPoweredOn,
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
import { isDemoMode } from '@/storage/demoMode';
import {
  forgetRememberedDevice,
  getRememberedDevice,
  rememberDevice,
  type RememberedDevice,
} from '@/storage/rememberedDevice';

/**
 * Scan lifecycle, kept separate from ConnectionState so screens can tell
 * "never scanned" apart from "scan finished empty" (needed by the selection
 * screen's empty/timeout states).
 */
export type ScanStatus = 'idle' | 'scanning' | 'timed_out' | 'error';

/**
 * How long the launch reconnect waits for the adapter to leave iOS's
 * post-creation 'unknown' state. Normally settles in well under a second;
 * a radio that's actually off resolves immediately as a definitive state.
 */
const ADAPTER_WAIT_MS = 5_000;

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
  /**
   * The last successfully connected device, persisted across launches
   * (Phase 9.1); null until one connect succeeds or after forgetDevice().
   */
  rememberedDevice: RememberedDevice | null;
  startScan: () => void;
  stopScan: () => void;
  /**
   * Only id/name matter for connecting; scan metadata is display-only.
   * Resolves with the connected instance so the caller can make immediate
   * post-connect decisions (onboarding gate) without racing the context's
   * next render.
   */
  connect: (
    target: Pick<DiscoveredDevice, 'id' | 'name'>,
  ) => Promise<UprightGoDevice>;
  disconnect: () => Promise<void>;
  /**
   * Direct connect to the remembered device, skipping the scan flow.
   * 'failed' covers nothing-remembered, missing permission, and connect
   * errors — callers fall back to the normal scan flow. 'cancelled' means
   * cancelReconnectToRemembered() (or a new scan) superseded the attempt,
   * including its pre-connect await window — callers stay quiet.
   */
  reconnectToRemembered: () => Promise<'connected' | 'failed' | 'cancelled'>;
  /** Abandon an in-flight reconnectToRemembered (pair with disconnect()). */
  cancelReconnectToRemembered: () => void;
  /** Drop the persisted device; does not touch a live connection. */
  forgetDevice: () => void;
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
  // Lazy initializer: one sync kv-store read at provider mount (no BLE).
  const [remembered, setRemembered] = useState<RememberedDevice | null>(
    getRememberedDevice,
  );

  const deviceRef = useRef<UprightGoDevice | null>(null);
  // Mirrors `remembered` for callbacks — one in-memory source of truth so
  // connect()/reconnectToRemembered() neither re-read storage nor churn
  // their useCallback identities on every remembered change.
  const rememberedRef = useRef<RememberedDevice | null>(remembered);
  // Bumped to abandon an in-flight reconnectToRemembered across its await
  // points (before connect() exists there is no device to disconnect).
  const reconnectSessionRef = useRef(0);
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

  // iOS never reports a permission denial from requestBlePermissions; it
  // shows up as adapter state 'unauthorized' instead, so this watch is the
  // real permission signal there. Started on the first BLE-touching action
  // (scan or launch reconnect), never at mount.
  const ensureAdapterWatch = useCallback(() => {
    adapterUnsubscribeRef.current ??= onAdapterStateChange((state) => {
      setAdapterState(state);
      if (state === 'poweredOff') {
        // Entries found before the radio went off may be gone when it
        // returns — never leave them rendered and tappable.
        setDevices([]);
      }
    });
  }, []);

  const startScan = useCallback(() => {
    // A user-initiated scan supersedes any in-flight launch reconnect,
    // whatever path started the scan.
    reconnectSessionRef.current += 1;
    const session = (scanSessionRef.current += 1);
    // Clear synchronously — the previous scan's entries must not stay
    // rendered (and tappable) while the permission request below is
    // pending; a stale entry may no longer be reachable.
    setDevices([]);
    // Demo mode (App Store review / screenshots): surface the simulated
    // device alongside any real results. Injected before the permission
    // request on purpose — connecting to it never touches the radio, so it
    // must stay reachable when permission is denied or the scan errors.
    if (isDemoMode()) {
      setDevices([DEMO_DISCOVERED_DEVICE]);
    }
    // 'scanning' from the moment of the user action: the permission-prompt
    // window is part of the scan from the UI's point of view, and screens
    // must never present an in-progress scan as finished ("Scan again").
    setScanStatus('scanning');
    void (async () => {
      const granted = await requestBlePermissions();
      setPermissionDenied(!granted);
      if (!granted || scanSessionRef.current !== session) {
        // Only unwind our own status — a superseding session owns it now.
        if (scanSessionRef.current === session) {
          setScanStatus('idle');
        }
        return;
      }
      ensureAdapterWatch();
      scanRef.current?.stop();
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
  }, [ensureAdapterWatch]);

  const connect = useCallback(
    async (target: Pick<DiscoveredDevice, 'id' | 'name'>) => {
      stopScan();
      let instance = deviceRef.current;
      if (!instance || instance.id !== target.id) {
        // Release the previous device first — a connected Upright GO stops
        // advertising, so a leaked link could never be found by a rescan.
        await deviceRef.current?.disconnect();
        // The demo device runs the same UprightGoDevice pipeline over a
        // fake transport (ADR-002 seam) — no radio involved.
        instance = new UprightGoDevice(
          target.id === DEMO_DEVICE_ID ? createDemoTransport() : getBleManager(),
          target.id,
          target.name,
        );
        // Stamp the tier before any link work: the AppState effect below
        // only runs after React commits this render, and a connect that
        // starts while backgrounded (state-restoration relaunch, launch
        // reconnect with the phone locked) must come up degraded, not
        // start the chatty tilt monitor and have the effect kill it later.
        instance.setBackgrounded(AppState.currentState === 'background');
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
      // Remember for the next launch's direct reconnect (Phase 9.1) —
      // skipped when unchanged (every launch reconnect comes through here).
      // The demo device is never remembered: it must not clobber a real
      // user's remembered device, and the launch reconnect path stays free
      // of demo branches (a reviewer just re-scans after a relaunch).
      const previous = rememberedRef.current;
      if (
        target.id !== DEMO_DEVICE_ID &&
        (previous?.id !== target.id || previous.name !== target.name)
      ) {
        const entry = { id: target.id, name: target.name };
        rememberDevice(entry);
        rememberedRef.current = entry;
        setRemembered(entry);
      }
      return instance;
    },
    [stopScan],
  );

  const disconnect = useCallback(async () => {
    await deviceRef.current?.disconnect();
  }, []);

  const cancelReconnectToRemembered = useCallback(() => {
    reconnectSessionRef.current += 1;
  }, []);

  const reconnectToRemembered = useCallback(async (): Promise<
    'connected' | 'failed' | 'cancelled'
  > => {
    const session = (reconnectSessionRef.current += 1);
    const target = rememberedRef.current;
    if (!target) {
      return 'failed';
    }
    // Same permission gate as scanning: a no-op when already granted, and
    // the graceful path when Android permissions were revoked since the
    // device was remembered. (Remembering implies a past grant, so no
    // first-run prompt appears here.)
    const granted = await requestBlePermissions();
    setPermissionDenied(!granted);
    if (!granted) {
      return 'failed';
    }
    // Cancelled while suspended above — there was no device instance yet,
    // so the caller's disconnect() had nothing to abort; bail here instead
    // of starting a connect the user has moved on from.
    if (reconnectSessionRef.current !== session) {
      return 'cancelled';
    }
    ensureAdapterWatch();
    // Cold launch means a freshly created BleManager, and iOS reports
    // adapter state 'unknown' for a moment after creation (Phase 1 —
    // "BluetoothLE is in unknown state" on any immediate call). The scan
    // path has its own gate inside scanForDevices; this direct-connect
    // path must wait the same way.
    const adapterReady = await waitForAdapterPoweredOn(ADAPTER_WAIT_MS);
    if (reconnectSessionRef.current !== session) {
      return 'cancelled';
    }
    if (!adapterReady) {
      return 'failed';
    }
    try {
      await connect(target);
      if (reconnectSessionRef.current !== session) {
        // Cancel landed while connecting but the attempt still won the
        // race — release the link (a connected device stops advertising
        // and the user is off scanning for it).
        await deviceRef.current?.disconnect();
        return 'cancelled';
      }
      return 'connected';
    } catch (error) {
      if (reconnectSessionRef.current !== session) {
        return 'cancelled';
      }
      console.log('[useDevice] launch reconnect failed:', error);
      return 'failed';
    }
  }, [connect, ensureAdapterWatch]);

  const forgetDevice = useCallback(() => {
    forgetRememberedDevice();
    rememberedRef.current = null;
    setRemembered(null);
  }, []);

  // Tiered background fidelity (Phase 10.2, ADR-008): the device drops its
  // chatty tilt stream while the app is backgrounded and restarts it on
  // foreground. Only the two settled AppState values flip the tier —
  // 'inactive' is a transient iOS state (app switcher, system sheets,
  // incoming call) and reacting to it would churn a BLE subscription for a
  // moment's peek at the notification shade.
  useEffect(() => {
    if (!device) {
      return;
    }
    device.setBackgrounded(AppState.currentState === 'background');
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'active') {
        device.setBackgrounded(state === 'background');
      }
    });
    return () => subscription.remove();
  }, [device]);

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
      rememberedDevice: remembered,
      startScan,
      stopScan,
      connect,
      disconnect,
      reconnectToRemembered,
      cancelReconnectToRemembered,
      forgetDevice,
    }),
    [
      connectionState,
      scanStatus,
      devices,
      device,
      bluetoothOff,
      remembered,
      startScan,
      stopScan,
      connect,
      disconnect,
      reconnectToRemembered,
      cancelReconnectToRemembered,
      forgetDevice,
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
