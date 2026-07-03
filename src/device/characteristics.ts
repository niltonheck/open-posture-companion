/**
 * GATT UUIDs and command bytes for the Upright GO 1.
 *
 * Source of truth: docs/protocol.html and
 * https://github.com/niltonheck/upright-go-1-reverse-engineering
 *
 * ADR-002: this file is the ONLY place UUIDs and byte literals may live,
 * and it must never be imported from outside src/device/.
 * ADR-006: firmware characteristics are out of scope — never add them here.
 */

import { fullUUID } from 'react-native-ble-plx';

/** BLE advertised name used to filter scan results. */
export const DEVICE_NAME = 'UprightGO';

export const Characteristic = {
  /** Write 0x01 to trigger calibration (hardware-confirmed; double-buzz ack). */
  calibrate: fullUUID('aab1'),
  /**
   * Read: calibration state — see CalibrationState below. 0x02 survives
   * BLE reconnects but resets to 0x00 on a device power cycle (training
   * mode dies with it). Decoded 2026-07-03.
   */
  calibrationState: fullUUID('aab2'),
  /**
   * Read: stored calibration record, NOT a live angle (GAP-01 resolved
   * 2026-07-03): two uint16 BIG-endian values in tenths of a degree,
   * [baseline][vibration threshold], threshold = baseline + 120 (+12°).
   * Persists in flash across power cycles — stale unless calibrationState
   * reads calibrated. Note: opposite endianness from the aaca stream.
   */
  calibrationRecord: fullUUID('aab3'),
  /** Notify/Read: physical button, toggles 0x01/0x00 on each press. */
  button: fullUUID('aac6'),
  /**
   * Notify/Read: continuous uint16 LE forward-tilt stream in tenths of a
   * degree, NOT the discrete status byte the original docs claimed (GAP-02).
   * Confirmed 2026-07-03 with correct mounting: ~200 upright → ~800
   * near-horizontal, monotonic; ~898 unworn/dangling. Absolute values
   * (pre-calibration at least). A "0x02 = slouching" status, if real,
   * likely belongs to another notify characteristic (aac4/aac9 — 5.2).
   */
  posture: fullUUID('aaca'),
  /** Write: vibration motor, 0x01 start / 0x00 stop. Hardware-confirmed. */
  vibration: fullUUID('aad3'),
  /** Write: red LED, 0x01 on / 0x00 off. Hardware-confirmed. */
  ledRed: fullUUID('aad4'),
  /**
   * Write: green LED, 0x01 on / 0x00 off. While on it BLINKS (firmware
   * pattern, not steady). Hardware-confirmed 2026-07-03. Old docs claimed a
   * blue LED on aad5, which does not exist.
   */
  ledGreen: fullUUID('aad6'),
} as const;

/**
 * GATT services, confirmed on hardware 2026-07-03 (GAP-03 closed).
 * Full discovered tree in docs/protocol.html. aaa0/aae0 purposes unknown;
 * 180a is standard Device Information. No standard battery service (180f).
 */
export const Service = {
  deviceInformation: fullUUID('180a'),
  aaa0: fullUUID('aaa0'),
  aab0: fullUUID('aab0'),
  aac0: fullUUID('aac0'),
  aad0: fullUUID('aad0'),
  aae0: fullUUID('aae0'),
} as const;

/** Which service owns each characteristic we use (from the confirmed tree). */
export const SERVICE_BY_CHARACTERISTIC: Readonly<Record<string, string>> = {
  [Characteristic.calibrate]: Service.aab0,
  [Characteristic.calibrationState]: Service.aab0,
  [Characteristic.calibrationRecord]: Service.aab0,
  [Characteristic.button]: Service.aac0,
  [Characteristic.posture]: Service.aac0,
  [Characteristic.vibration]: Service.aad0,
  [Characteristic.ledRed]: Service.aad0,
  [Characteristic.ledGreen]: Service.aad0,
};

// GAP-04 resolved 2026-07-03: aab1 calibrates (double-vibration ack); the
// repo sample's aaa6 does not exist in the GATT tree — it was a typo.

export const Command = {
  calibrate: 0x01,
  on: 0x01,
  off: 0x00,
} as const;

/** aab2 read values (observed on hardware 2026-07-03). */
export const CalibrationState = {
  none: 0x00,
  calibrated: 0x02,
} as const;

