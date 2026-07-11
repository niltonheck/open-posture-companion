/**
 * A fake BleTransport impersonating an Upright GO 1 for App Store review
 * and screenshot sessions (no hardware, no radio). It emits real protocol
 * bytes on the real characteristics, so the entire UprightGoDevice decode /
 * state-machine / stats pipeline runs unchanged on top of it — exactly the
 * mockability ADR-002 designed the transport seam for.
 *
 * The simulated wearer: connects already calibrated (aab2 = 0x02) at the
 * hardware-typical ~20° upright baseline — a demo device carrying 30 days
 * of history can't coherently present as first-boot, and posture must
 * read "Upright" on arrival with no onboarding detour. It then streams
 * mostly-upright tilt with one ~10 s slouch per minute — long enough to
 * beat the slouch-event dwell, so live status, haptics, and day stats all
 * move while a reviewer watches. The calibrate flow stays demoable via
 * the Calibrate button (recalibration re-baselines like real hardware).
 */

import { State } from 'react-native-ble-plx';
import type {
  Characteristic as GattCharacteristic,
  Device,
  Service,
  Subscription,
} from 'react-native-ble-plx';

import {
  CalibrationState,
  Characteristic,
  Command,
  DEVICE_NAME,
  SERVICE_BY_CHARACTERISTIC,
  Telemetry,
} from './characteristics';
import { base64ToBytes, bytesToBase64 } from './encoding';
import type { DiscoveredDevice } from './types';
import type { BleTransport } from './UprightGoDevice';

/** Constant, so it can never collide with a real CoreBluetooth UUID. */
export const DEMO_DEVICE_ID = 'demo-upright-go-1';

/**
 * Production builds (the reviewer's) label the device honestly; dev builds
 * (where marketing screenshots are captured) use the plain hardware name so
 * "(Demo)" never appears in a store shot.
 */
export const DEMO_DEVICE_NAME = __DEV__ ? DEVICE_NAME : `${DEVICE_NAME} (Demo)`;

export const DEMO_DISCOVERED_DEVICE: DiscoveredDevice = {
  id: DEMO_DEVICE_ID,
  name: DEMO_DEVICE_NAME,
  rssi: -55,
  signal: 'strong',
};

/** Simulated GATT latencies, so connect/write flows feel real on screen. */
const CONNECT_DELAY_MS = 300;
const DISCOVERY_DELAY_MS = 50;
const READ_DELAY_MS = 30;
const WRITE_DELAY_MS = 120;

const TILT_INTERVAL_MS = 200;
const TELEMETRY_FIRST_TICK_MS = 30_000;
const TELEMETRY_INTERVAL_MS = 60_000;

/**
 * The simulated wearer's upright tilt and default calibration baseline —
 * ~20°, matching real hardware (aaca idles ~200 deci-degrees worn upright,
 * docs/protocol.html). NOT a larger "looks slouchy" angle: the slouch
 * threshold is baseline + 12°, so the baseline must sit at honest upright.
 */
const UPRIGHT_TILT_DECIDEGREES = 205;
/**
 * The device convention (characteristics.ts, aab3): vibration threshold =
 * baseline + 120. The demo's slouch excursion clears it comfortably.
 */
const SLOUCH_THRESHOLD_OFFSET_DECIDEGREES = 120;
const SLOUCH_EXCURSION_DECIDEGREES = 170;

/**
 * Post-calibration behavior cycle, in seconds: upright for 40, ~3 s ramp
 * into a 9 s held slouch (beats the 5 s dwell → one slouch event per
 * cycle), ~3 s recovery, upright until the minute closes.
 */
const CYCLE_MS = 60_000;
const SLOUCH_RAMP_START_S = 40;
const SLOUCH_HOLD_START_S = 43;
const SLOUCH_HOLD_END_S = 52;
const SLOUCH_RAMP_END_S = 55;

/** 3955 mV, uint16 LE — decodes to 76% on the LiPo curve. */
const BATTERY_BYTES = Uint8Array.of(0x73, 0x0f);
/** aae1: [42 connections][2472 lifetime minutes], both uint16 LE. */
const ODOMETER_BYTES = Uint8Array.of(42, 0, 2472 & 0xff, 2472 >> 8);
/** aac5: uint32 LE deciseconds — "on for" about 2 h 42 min. */
const UPTIME_DECISECONDS = 97_200;

export type DemoPostureOverride = 'slouch' | 'upright' | null;

type MonitorListener = Parameters<
  BleTransport['monitorCharacteristicForDevice']
>[3];

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

class DemoDeviceScript {
  private connected = false;
  private calibrated = true;
  private baselineDecidegrees = UPRIGHT_TILT_DECIDEGREES;
  private calibratedAtMs = 0;
  private paused = false;
  private override: DemoPostureOverride = null;
  private tiltTimer: ReturnType<typeof setInterval> | null = null;
  private telemetryDelayTimer: ReturnType<typeof setTimeout> | null = null;
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly monitors = new Map<string, Set<MonitorListener>>();

  isConnected(): boolean {
    return this.connected;
  }

  setOverride(mode: DemoPostureOverride): void {
    this.override = mode;
  }

  start(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    // Cycle phase anchors to connect time: the reviewer's first 40 s are
    // upright, so the screen never opens mid-slouch.
    this.calibratedAtMs = Date.now();
    this.tiltTimer = setInterval(() => {
      this.notify(
        Characteristic.posture,
        this.readValue(Characteristic.posture),
      );
    }, TILT_INTERVAL_MS);
    this.telemetryDelayTimer = setTimeout(() => {
      this.emitTelemetry();
      this.telemetryTimer = setInterval(
        () => this.emitTelemetry(),
        TELEMETRY_INTERVAL_MS,
      );
    }, TELEMETRY_FIRST_TICK_MS);
  }

  stop(): void {
    this.connected = false;
    if (this.tiltTimer !== null) {
      clearInterval(this.tiltTimer);
      this.tiltTimer = null;
    }
    if (this.telemetryDelayTimer !== null) {
      clearTimeout(this.telemetryDelayTimer);
      this.telemetryDelayTimer = null;
    }
    if (this.telemetryTimer !== null) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    this.monitors.clear();
  }

  addMonitor(uuid: string, listener: MonitorListener): Subscription {
    let listeners = this.monitors.get(uuid);
    if (!listeners) {
      listeners = new Set();
      this.monitors.set(uuid, listeners);
    }
    listeners.add(listener);
    return { remove: () => void listeners.delete(listener) };
  }

  readValue(uuid: string): Uint8Array {
    switch (uuid) {
      case Characteristic.batteryVoltage:
        return BATTERY_BYTES;
      case Characteristic.charging:
        return Uint8Array.of(Command.off);
      case Characteristic.worn:
        return Uint8Array.of(Command.on);
      case Characteristic.button:
        return Uint8Array.of(Command.off);
      case Characteristic.pauseMode:
        return Uint8Array.of(this.paused ? Command.on : Command.off);
      case Characteristic.calibrationState:
        return Uint8Array.of(
          this.calibrated ? CalibrationState.calibrated : CalibrationState.none,
        );
      case Characteristic.calibrationRecord: {
        // Big-endian [baseline][threshold], threshold = baseline + 120 —
        // mirrors the real flash record (note the endianness flip vs aaca).
        const baseline = this.baselineDecidegrees;
        const threshold = baseline + SLOUCH_THRESHOLD_OFFSET_DECIDEGREES;
        return Uint8Array.of(
          baseline >> 8,
          baseline & 0xff,
          threshold >> 8,
          threshold & 0xff,
        );
      }
      case Characteristic.posture: {
        const tilt = this.tiltDecidegrees(Date.now());
        return Uint8Array.of(tilt & 0xff, tilt >> 8);
      }
      case Characteristic.telemetry:
        return Uint8Array.of(this.telemetryByte());
      case Characteristic.odometer:
        return ODOMETER_BYTES;
      case Characteristic.uptime:
        return Uint8Array.of(
          UPTIME_DECISECONDS & 0xff,
          (UPTIME_DECISECONDS >> 8) & 0xff,
          (UPTIME_DECISECONDS >> 16) & 0xff,
          (UPTIME_DECISECONDS >> 24) & 0xff,
        );
      default:
        return Uint8Array.of();
    }
  }

  handleWrite(uuid: string, byte: number): void {
    if (uuid === Characteristic.calibrate && byte === Command.calibrate) {
      // Baseline captured at ack time — the simulated wearer "holds their
      // ideal posture" through calibration, like the real flow assumes.
      this.baselineDecidegrees = this.tiltDecidegrees(Date.now());
      this.calibrated = true;
      this.calibratedAtMs = Date.now();
      return;
    }
    if (uuid === Characteristic.pauseMode) {
      this.paused = byte === Command.on;
    }
    // Vibration and LED writes are accepted and ignored — no motor to run.
  }

  private tiltDecidegrees(nowMs: number): number {
    // Slow sine wander stands in for sensor noise; deterministic, so the
    // pre-calibration guard (a non-null tilt) is satisfied within a second.
    const wiggle = Math.sin(nowMs / 2_500) * 8;
    if (!this.calibrated) {
      // Unreachable today (the demo connects calibrated) — kept so the
      // script stays honest if a future fixture resets the flag.
      return Math.round(UPRIGHT_TILT_DECIDEGREES + wiggle);
    }
    const base = this.baselineDecidegrees;
    if (this.override === 'slouch') {
      return Math.round(base + SLOUCH_EXCURSION_DECIDEGREES + wiggle * 0.4);
    }
    if (this.override === 'upright') {
      return Math.round(base + wiggle);
    }
    const t = ((nowMs - this.calibratedAtMs) % CYCLE_MS) / 1_000;
    if (t < SLOUCH_RAMP_START_S || t >= SLOUCH_RAMP_END_S) {
      return Math.round(base + wiggle);
    }
    if (t < SLOUCH_HOLD_START_S) {
      const ramp = (t - SLOUCH_RAMP_START_S) /
        (SLOUCH_HOLD_START_S - SLOUCH_RAMP_START_S);
      return Math.round(base + ramp * SLOUCH_EXCURSION_DECIDEGREES);
    }
    if (t < SLOUCH_HOLD_END_S) {
      return Math.round(base + SLOUCH_EXCURSION_DECIDEGREES + wiggle * 0.4);
    }
    const ramp = (SLOUCH_RAMP_END_S - t) /
      (SLOUCH_RAMP_END_S - SLOUCH_HOLD_END_S);
    return Math.round(base + ramp * SLOUCH_EXCURSION_DECIDEGREES);
  }

  private telemetryByte(): number {
    const slouchedNow =
      this.calibrated &&
      this.tiltDecidegrees(Date.now()) >=
        this.baselineDecidegrees + SLOUCH_THRESHOLD_OFFSET_DECIDEGREES;
    // Excursion bits stay 0: on hardware that counter is Training-mode-only
    // and the app deliberately ignores it (see characteristics.ts).
    return (
      (slouchedNow ? Telemetry.slouchedBit : 0) |
      (this.paused ? Telemetry.pausedBit : 0)
    );
  }

  private emitTelemetry(): void {
    this.notify(
      Characteristic.telemetry,
      Uint8Array.of(this.telemetryByte()),
    );
  }

  private notify(uuid: string, bytes: Uint8Array): void {
    const listeners = this.monitors.get(uuid);
    if (!listeners || listeners.size === 0) {
      return;
    }
    const characteristic = {
      uuid,
      value: bytesToBase64(bytes),
    } as unknown as GattCharacteristic;
    for (const listener of [...listeners]) {
      listener(null, characteristic);
    }
  }
}

/** The script behind the most recent demo connection (screenshot steering). */
let activeScript: DemoDeviceScript | null = null;

/**
 * Dev-only steering for screenshots: pin the simulated wearer to a posture
 * instead of the 60 s auto-cycle. No-op when no demo device is connected.
 */
export function setDemoPostureOverride(mode: DemoPostureOverride): void {
  activeScript?.setOverride(mode);
}

const DEMO_SERVICES = [...new Set(Object.values(SERVICE_BY_CHARACTERISTIC))];

/**
 * One transport per connect (fresh timers/state). Object literals are cast
 * through unknown to ble-plx's class types — safe: UprightGoDevice only
 * reads uuid/value/capability flags off them.
 */
export function createDemoTransport(): BleTransport {
  const script = new DemoDeviceScript();
  activeScript = script;
  const demoDevice = (id: string) =>
    ({ id, name: DEMO_DEVICE_NAME }) as unknown as Device;
  return {
    connectToDevice: async (id) => {
      await delay(CONNECT_DELAY_MS);
      script.start();
      return demoDevice(id);
    },
    isDeviceConnected: () => Promise.resolve(script.isConnected()),
    cancelDeviceConnection: async (id) => {
      script.stop();
      return demoDevice(id);
    },
    discoverAllServicesAndCharacteristicsForDevice: async (id) => {
      await delay(DISCOVERY_DELAY_MS);
      return demoDevice(id);
    },
    servicesForDevice: () =>
      Promise.resolve(
        DEMO_SERVICES.map((uuid) => ({ uuid }) as unknown as Service),
      ),
    characteristicsForDevice: (_id, serviceUuid) =>
      Promise.resolve(
        Object.entries(SERVICE_BY_CHARACTERISTIC)
          .filter(([, service]) => service === serviceUuid)
          .map(
            ([uuid]) =>
              ({
                uuid,
                isReadable: true,
                isWritableWithResponse: true,
                isWritableWithoutResponse: false,
                isNotifiable: true,
                isIndicatable: false,
              }) as unknown as GattCharacteristic,
          ),
      ),
    readCharacteristicForDevice: async (_id, _serviceUuid, uuid) => {
      await delay(READ_DELAY_MS);
      return {
        uuid,
        value: bytesToBase64(script.readValue(uuid)),
      } as unknown as GattCharacteristic;
    },
    writeCharacteristicWithResponseForDevice: async (
      _id,
      _serviceUuid,
      uuid,
      base64Value,
    ) => {
      await delay(WRITE_DELAY_MS);
      script.handleWrite(uuid, base64ToBytes(base64Value)[0] ?? 0);
      return { uuid, value: base64Value } as unknown as GattCharacteristic;
    },
    monitorCharacteristicForDevice: (_id, _serviceUuid, uuid, listener) =>
      script.addMonitor(uuid, listener),
    // The demo link never drops on its own; the handler is never invoked.
    onDeviceDisconnected: () => ({ remove: () => {} }),
    state: () => Promise.resolve(State.PoweredOn),
    onStateChange: (listener, emitCurrentState) => {
      if (emitCurrentState) {
        listener(State.PoweredOn);
      }
      return { remove: () => {} };
    },
  };
}
