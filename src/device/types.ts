/**
 * Domain types for the device layer. Screens and hooks consume these —
 * never raw bytes or UUIDs (ADR-002).
 */

/**
 * Derived app-side from the aaca tilt stream, relative to a reference tilt
 * captured at calibration (see UprightGoDevice.onPostureChange). 'unknown'
 * until the user calibrates or while disconnected.
 */
export type PostureStatus = 'upright' | 'slouching' | 'unknown';

/**
 * Full connection state machine from docs/architecture.html, for the hook
 * layer (Phase 2): it composes the device-owned lifecycle states below with
 * the UI-flow states around scanning, permissions, and action feedback.
 */
export type ConnectionState =
  | 'idle'
  | 'permission_needed'
  | 'scanning'
  | 'device_found'
  | 'connecting'
  | 'connected'
  | 'calibrating'
  | 'action_success'
  | 'action_error'
  | 'reconnecting'
  | 'disconnected';

/**
 * The subset of the machine UprightGoDevice owns and emits. Keeping the
 * device's states separate means hook-layer states (e.g. 'action_success')
 * can never be clobbered by a device emission.
 */
export type DeviceConnectionState = Extract<
  ConnectionState,
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'calibrating'
  | 'reconnecting'
  | 'disconnected'
>;

// AngleReading was removed 2026-07-03: GAP-01 resolved — aab3 is a stored
// calibration record, not a live angle (see characteristics.ts). Nothing
// ever consumed the opaque type.

/** Bluetooth adapter state, mapped from the transport library's states. */
export type AdapterState =
  | 'poweredOn'
  | 'poweredOff'
  | 'unauthorized'
  | 'unsupported'
  | 'resetting'
  | 'unknown';

export type SignalStrength = 'strong' | 'medium' | 'weak';

/** A device found during scanning, ready to display and connect to. */
export interface DiscoveredDevice {
  id: string;
  name: string;
  rssi: number | null;
  signal: SignalStrength;
}

/**
 * Live device health/state, decoded from the aaa2/aac3/aac7/aad2 notify
 * characteristics (docs/protocol.html, 2026-07-03). Fields are null until
 * the first reading arrives and while disconnected.
 */
export interface DeviceVitals {
  /** 0–100, derived from battery millivolts via a LiPo discharge curve. */
  batteryPercent: number | null;
  charging: boolean | null;
  worn: boolean | null;
  /** Button-toggled pause: device senses but does not vibrate. */
  paused: boolean | null;
}

/**
 * One decoded aac9 tick — the device's per-minute telemetry summary,
 * emitted every ~60 s while connected (docs/protocol.html, TODO 5.8).
 * An event, not state: there is no "current" tick to replay to a late
 * subscriber.
 */
export interface TelemetryTick {
  /** Wearer was past the slouch threshold at tick time. */
  slouched: boolean;
  /** Tracking (pause) mode was active at tick time. */
  paused: boolean;
  /** Slouch excursions during the preceding interval (counts while paused too). */
  excursions: number;
  /**
   * Worn state (aac3) at tick time, stamped by the device layer so every
   * consumer gates on one definition of a countable minute; null before
   * the priming read lands.
   */
  worn: boolean | null;
}

/**
 * Lifetime counters read from the device on demand (Phase 9.3). Decodes
 * are single-session/probable (docs/protocol.html) — present as estimates
 * until the hardware confirmation walk. Fields are null when the source
 * characteristic couldn't be read or was shorter than expected.
 */
export interface DeviceOdometer {
  /** aae1[0..1]: connections since manufacture (probable). */
  connectionCount: number | null;
  /** aae1[2..3]: lifetime powered-on minutes (probable). */
  lifetimeMinutes: number | null;
  /** aac5: seconds since the last power-on (probable; stored as deciseconds). */
  uptimeSeconds: number | null;
}

export type Unsubscribe = () => void;
