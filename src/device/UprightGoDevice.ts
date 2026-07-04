/**
 * Device abstraction layer for the Upright GO 1 (ADR-002).
 *
 * All GATT communication happens here, against a transport that is
 * structurally a BleManager — inject a mock for hardware-free tests.
 * Only the whitelisted characteristics in characteristics.ts are ever
 * touched (ADR-006).
 */

import { State } from 'react-native-ble-plx';
import type { BleManager, Subscription } from 'react-native-ble-plx';

import {
  CalibrationState,
  Characteristic,
  Command,
  SERVICE_BY_CHARACTERISTIC,
} from './characteristics';
import { base64ToBytes, bytesToBase64, bytesToHex } from './encoding';
import type {
  DeviceConnectionState,
  DeviceVitals,
  PostureStatus,
  Unsubscribe,
} from './types';

/** The slice of BleManager the device layer uses; mockable per ADR-002. */
export type BleTransport = Pick<
  BleManager,
  | 'connectToDevice'
  | 'cancelDeviceConnection'
  | 'discoverAllServicesAndCharacteristicsForDevice'
  | 'servicesForDevice'
  | 'characteristicsForDevice'
  | 'writeCharacteristicWithResponseForDevice'
  | 'readCharacteristicForDevice'
  | 'monitorCharacteristicForDevice'
  | 'onDeviceDisconnected'
  | 'state'
  | 'onStateChange'
>;

const TAG = '[UprightGoDevice]';

/**
 * Slouch threshold relative to the calibration baseline, in tenths of a
 * degree. Matches the device's own training mode exactly: the stored aab3
 * record always reads threshold = baseline + 120 (hardware-decoded
 * 2026-07-03, two calibrations at different baselines), so the app's
 * status line flips at the same tilt where the device starts vibrating.
 */
const SLOUCH_OFFSET_DECIDEGREES = 120;

/** Duration of the testVibration() pulse (matches the Phase 1 harness). */
const VIBRATION_PULSE_MS = 400;

/**
 * Bound on any single connectToDevice call — without it iOS pends
 * indefinitely and a Connect tap on a device that just left range would
 * show "Connecting…" forever.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Backoff schedule for auto-reconnect after an unexpected drop. Exhausting
 * it lands on 'disconnected' (the UI's cue to give up and go home).
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];

/**
 * The tilt stream can die on a transient GATT error without the link
 * dropping; a frozen stream means the status line stays 'unknown' and
 * calibrate can never capture a reference until the user reconnects.
 * Bounded restarts per connection recover the transient case.
 */
const TILT_MONITOR_MAX_RESTARTS = 2;
const TILT_MONITOR_RESTART_DELAY_MS = 1_000;

/**
 * LiPo open-circuit voltage → remaining-charge curve (single 4.2 V cell,
 * which the observed aad2 range matches: ~4120 mV on charger, ~3600 mV
 * low). Piecewise-linear between well-known LiPo rest points; coarse by
 * nature — the UI should present it as an estimate, not a gauge.
 */
const BATTERY_CURVE_MV_TO_PERCENT: readonly (readonly [number, number])[] = [
  [4150, 100],
  [4050, 90],
  [3950, 75],
  [3850, 55],
  [3750, 35],
  [3650, 15],
  [3550, 5],
  [3450, 0],
];

const EMPTY_VITALS: DeviceVitals = {
  batteryPercent: null,
  charging: null,
  worn: null,
  paused: null,
};

export function batteryPercentFromMillivolts(millivolts: number): number {
  const curve = BATTERY_CURVE_MV_TO_PERCENT;
  if (millivolts >= curve[0][0]) {
    return 100;
  }
  for (let i = 1; i < curve.length; i += 1) {
    const [highMv, highPct] = curve[i - 1];
    const [lowMv, lowPct] = curve[i];
    if (millivolts >= lowMv) {
      const ratio = (millivolts - lowMv) / (highMv - lowMv);
      return Math.round(lowPct + ratio * (highPct - lowPct));
    }
  }
  return 0;
}

export class UprightGoDevice {
  private state: DeviceConnectionState = 'idle';
  private readonly stateListeners = new Set<
    (state: DeviceConnectionState) => void
  >();
  /** True once service discovery has completed on the live connection. */
  private gattReady = false;
  private disconnectSubscription: Subscription | null = null;
  private readonly monitorSubscriptions = new Set<Subscription>();
  private connectPromise: Promise<void> | null = null;
  /**
   * Bumped by teardown(), i.e. whenever the current link (or link attempt)
   * is invalidated. Async continuations capture it at start and abort when
   * it moved on — this is what stops a superseded connect attempt from
   * cancelling a newer link (the race accepted in notes/phase-1.md), and
   * stale reconnect/monitor-restart timers from firing into a new link.
   */
  private linkEpoch = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set while the reconnect loop is parked waiting for the adapter. */
  private adapterWaitSubscription: Subscription | null = null;
  private tiltMonitorRestarts = 0;
  /** Dev-only; the GATT tree can't change between links, log it once. */
  private gattTreeLogged = false;
  /**
   * Last vibration command sent. A drop mid-pulse strands the motor
   * buzzing (firmware runs it until an off command), so reconnect restores
   * silence when this is still true.
   */
  private motorOn = false;
  private readonly postureListeners = new Set<(status: PostureStatus) => void>();
  private lastEmittedPosture: PostureStatus | null = null;
  private vitals: DeviceVitals = EMPTY_VITALS;
  private readonly vitalsListeners = new Set<(vitals: DeviceVitals) => void>();
  /** Latest aaca reading; null while disconnected. */
  private lastTiltDecidegrees: number | null = null;
  private readonly tiltListeners = new Set<(decidegrees: number | null) => void>();
  /**
   * Tilt captured when calibrate() acked. The aaca stream is absolute
   * (calibration does not re-baseline it), so the reference stays valid
   * across reconnects of this instance.
   */
  private referenceTiltDecidegrees: number | null = null;

  constructor(
    private readonly transport: BleTransport,
    readonly id: string,
    readonly name: string,
  ) {}

  get connectionState(): DeviceConnectionState {
    return this.state;
  }

  onConnectionStateChange(
    callback: (state: DeviceConnectionState) => void,
  ): Unsubscribe {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  /** Idempotent: concurrent callers await the same in-flight attempt. */
  connect(): Promise<void> {
    // 'calibrating' is also a live link — re-running establishConnection on
    // it would clobber the state and register a duplicate tilt monitor.
    if (this.state === 'connected' || this.state === 'calibrating') {
      return Promise.resolve();
    }
    // A manual connect supersedes any scheduled auto-retry. (A connect()
    // racing an *in-flight* reconnect attempt is unreachable from the V0
    // screens — only the selection screen calls connect(), and it is never
    // shown while 'reconnecting'.)
    this.cancelReconnect();
    if (!this.connectPromise) {
      const attempt = this.establishConnection().finally(() => {
        // Only clear our own registration — a superseded attempt settling
        // late must not wipe a newer connect()'s shared promise.
        if (this.connectPromise === attempt) {
          this.connectPromise = null;
        }
      });
      this.connectPromise = attempt;
    }
    return this.connectPromise;
  }

  private async establishConnection(): Promise<void> {
    const epoch = this.linkEpoch;
    this.setState('connecting');
    try {
      await this.establishLink(epoch);
      this.setState('connected');
    } catch (error) {
      // If the epoch moved on, a deliberate disconnect() (or the drop
      // handler) superseded this attempt and already owns cleanup, the
      // native connection, and the machine state — touch none of them.
      if (epoch === this.linkEpoch) {
        this.teardown();
        // The link may have been established before the failure — release
        // it, or the device stops advertising and rescans can't find it.
        try {
          await this.transport.cancelDeviceConnection(this.id);
        } catch {
          // No connection to cancel.
        }
        // A deliberate disconnect() mid-connect already set 'idle'; keep it.
        if (this.connectionState === 'connecting') {
          this.setState('disconnected');
        }
      }
      throw error;
    }
  }

  /**
   * Shared by first connect and reconnect attempts: native connect,
   * drop handler, service discovery, tilt monitor. No state transitions —
   * callers own those. Throws if superseded (epoch moved) mid-flight.
   */
  private async establishLink(epoch: number): Promise<void> {
    await this.transport.connectToDevice(this.id, {
      timeout: CONNECT_TIMEOUT_MS,
    });
    this.assertCurrent(epoch);
    this.disconnectSubscription = this.transport.onDeviceDisconnected(
      this.id,
      (error) => {
        console.log(`${TAG} unexpected disconnect`, error ?? '');
        // Only a drop from an established link starts auto-reconnect; a
        // drop mid-attempt surfaces as that attempt's rejection instead
        // ('reconnecting' must survive it so the backoff schedule, not this
        // handler, decides when to give up).
        const wasLive =
          this.state === 'connected' || this.state === 'calibrating';
        this.teardown();
        if (wasLive) {
          this.scheduleReconnect(0);
        } else if (this.state !== 'reconnecting') {
          this.setState('disconnected');
        }
      },
    );
    await this.transport.discoverAllServicesAndCharacteristicsForDevice(
      this.id,
    );
    this.assertCurrent(epoch);
    if (__DEV__ && !this.gattTreeLogged) {
      await this.logGattTree();
      this.gattTreeLogged = true;
      this.assertCurrent(epoch);
    }
    this.gattReady = true;
    this.tiltMonitorRestarts = 0;
    this.startTiltMonitor();
    this.startVitalsMonitors();
    // Fire-and-forget so the extra GATT reads never delay 'connected':
    // adopt the stored calibration (aab2/aab3) and prime the vitals with
    // initial reads (their notifies only fire on change).
    void this.adoptDeviceCalibration(epoch);
    void this.primeVitals(epoch);
    if (this.motorOn) {
      // Best-effort: silence a motor stranded by a drop mid-pulse. On
      // failure the flag stays set and the next link retries.
      void this.write(Characteristic.vibration, Command.off)
        .then(() => {
          this.motorOn = false;
        })
        .catch(() => {});
    }
  }

  private assertCurrent(epoch: number): void {
    if (epoch !== this.linkEpoch) {
      throw new Error('Connection attempt superseded');
    }
  }

  /**
   * Auto-reconnect after an unexpected drop (docs/architecture.html):
   * 'reconnecting' while the backoff schedule runs, 'connected' on success
   * (monitors are re-created, the calibration reference survives — aaca is
   * absolute), 'disconnected' once the schedule is exhausted.
   */
  private scheduleReconnect(attempt: number): void {
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      this.setState('disconnected');
      return;
    }
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect(attempt);
    }, RECONNECT_DELAYS_MS[attempt]);
  }

  private async attemptReconnect(attempt: number): Promise<void> {
    // Between attempts there is no live link, so the only possible epoch
    // bump during the awaits below is a superseding disconnect()/connect()
    // teardown. That closes the window where disconnect() runs its
    // cancelReconnect() while we are suspended and a park subscription
    // registered afterwards would escape it. (The state check alone can't:
    // disconnect() sets 'idle' only after its own await.)
    const epoch = this.linkEpoch;
    // With the radio off every attempt fails instantly and the schedule
    // would burn out in seconds — while the UI tells the user to turn
    // Bluetooth back on. Park the loop until the adapter returns instead;
    // Disconnect stays available as the user's escape hatch.
    let adapterPoweredOn = true;
    try {
      adapterPoweredOn = (await this.transport.state()) === State.PoweredOn;
    } catch {
      // Can't read adapter state — just try the attempt.
    }
    if (this.state !== 'reconnecting' || epoch !== this.linkEpoch) {
      return;
    }
    if (!adapterPoweredOn) {
      // emitCurrentState=true closes the race where the adapter came back
      // between the state() read above and this registration.
      const subscription = this.transport.onStateChange((next) => {
        if (next !== State.PoweredOn) {
          return;
        }
        subscription.remove();
        if (this.adapterWaitSubscription === subscription) {
          this.adapterWaitSubscription = null;
        }
        if (this.state === 'reconnecting' && epoch === this.linkEpoch) {
          // Fresh schedule: the radio just came back, so earlier failures
          // say nothing about the device being in range.
          this.scheduleReconnect(0);
        }
      }, true);
      this.adapterWaitSubscription = subscription;
      return;
    }
    try {
      await this.establishLink(this.linkEpoch);
      this.setState('connected');
    } catch {
      if (this.state !== 'reconnecting') {
        return; // Superseded by disconnect()/connect(); they own the state.
      }
      this.teardown();
      try {
        await this.transport.cancelDeviceConnection(this.id);
      } catch {
        // Nothing to release.
      }
      // disconnect() may have landed during the await above; never clobber
      // its 'idle' with another 'reconnecting'.
      if (this.state === 'reconnecting') {
        this.scheduleReconnect(attempt + 1);
      }
    }
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.adapterWaitSubscription?.remove();
    this.adapterWaitSubscription = null;
  }

  /** Deliberate disconnect; returns the machine to idle. */
  async disconnect(): Promise<void> {
    // Abandon any in-flight connect so a later connect() starts fresh
    // instead of awaiting the attempt this call is about to cancel.
    this.connectPromise = null;
    this.cancelReconnect();
    this.teardown();
    try {
      await this.transport.cancelDeviceConnection(this.id);
    } catch {
      // Already disconnected — fine, we only care about the end state.
    }
    this.setState('idle');
  }

  /**
   * Trigger device calibration (equivalent to the physical button).
   * GAP-04: aab1 is unverified on hardware; if it does nothing, see
   * CALIBRATE_FALLBACK_UUID in characteristics.ts.
   */
  async calibrate(): Promise<void> {
    if (this.state !== 'connected') {
      throw new Error(`Cannot calibrate while ${this.state}`);
    }
    // Without a tilt reading there is nothing to capture as the posture
    // reference — calibrating anyway would leave posture 'unknown' forever
    // with no signal. Failing loud lets the UI say "try again". The stream
    // starts right after connect, so this is a startup-edge only.
    const tiltAtStart = this.lastTiltDecidegrees;
    if (tiltAtStart === null) {
      throw new Error('Cannot calibrate before the first tilt reading arrives');
    }
    const epoch = this.linkEpoch;
    this.setState('calibrating');
    try {
      await this.write(Characteristic.calibrate, Command.calibrate);
      // The wearer holds their ideal posture through calibration, so the
      // tilt at ack time becomes the reference the app-side slouch
      // threshold is measured against. Fall back to the guard-time reading
      // if the stream died mid-write — never null a valid reference.
      this.referenceTiltDecidegrees = this.lastTiltDecidegrees ?? tiltAtStart;
      this.emitPosture();
      // Then refine from the device's own stored record — the exact
      // baseline the vibration threshold is measured against. Best-effort;
      // the ack-time reference above already stands if the reads fail.
      await this.adoptDeviceCalibration(epoch);
    } finally {
      // A disconnect can land mid-write; never overwrite that.
      if (this.connectionState === 'calibrating') {
        this.setState('connected');
      }
    }
  }

  async setVibration(on: boolean): Promise<void> {
    await this.write(Characteristic.vibration, on ? Command.on : Command.off);
    this.motorOn = on;
  }

  /**
   * One short buzz for "Test vibration". The motor runs continuously from
   * the on command until the off command, so the pulse is shaped here —
   * that's hardware knowledge, and every caller would otherwise have to
   * copy the never-leave-it-buzzing cleanup.
   */
  async testVibration(): Promise<void> {
    try {
      await this.setVibration(true);
      await new Promise((resolve) =>
        setTimeout(resolve, VIBRATION_PULSE_MS),
      );
      await this.setVibration(false);
    } catch (error) {
      // If the on command landed but the off command failed, one
      // best-effort retry before surfacing the failure.
      try {
        await this.setVibration(false);
      } catch {
        // Link is gone; the disconnect path owns cleanup from here.
      }
      throw error;
    }
  }

  /**
   * Pause/resume the device's slouch-vibration reminders — same effect as
   * a physical button press (aac7, write verified 2026-07-03). The device
   * keeps sensing while paused. The firmware does not notify the writer,
   * so the confirmed state is reflected into vitals locally.
   */
  async setPaused(on: boolean): Promise<void> {
    await this.write(Characteristic.pauseMode, on ? Command.on : Command.off);
    this.setVitals({ paused: on });
  }

  /** The green LED blinks while on (firmware pattern); red is steady. */
  async setLED(color: 'red' | 'green', on: boolean): Promise<void> {
    const characteristic =
      color === 'red' ? Characteristic.ledRed : Characteristic.ledGreen;
    await this.write(characteristic, on ? Command.on : Command.off);
  }

  /**
   * Subscribe to posture status derived from the aaca tilt stream — a
   * continuous uint16 LE value in tenths of a degree (~200 upright → ~800
   * near-horizontal, hardware-confirmed 2026-07-03; docs/protocol.html).
   * The stream is absolute, so there is no meaningful threshold until a
   * calibration reference exists — captured when the user calibrates, or
   * adopted from the device's stored record when it connects already
   * calibrated (aab2/aab3). 'unknown' before either (and while
   * disconnected), then 'slouching' whenever tilt exceeds the reference by
   * SLOUCH_OFFSET_DECIDEGREES — the same +120 the device's own vibration
   * uses. Emits the current status immediately, then only on change.
   * Listeners survive reconnects — the underlying BLE monitor is
   * re-created by the device on each connection.
   */
  onPostureChange(callback: (status: PostureStatus) => void): Unsubscribe {
    this.postureListeners.add(callback);
    callback(this.postureStatus());
    return () => this.postureListeners.delete(callback);
  }

  /** Started per connection; feeds all posture listeners from one monitor. */
  private startTiltMonitor(): void {
    const epoch = this.linkEpoch;
    this.monitor(
      Characteristic.posture,
      (bytes) => {
        if (bytes.length < 2) {
          return;
        }
        const tilt = bytes[0] | (bytes[1] << 8);
        if (__DEV__) {
          console.log(`${TAG} aaca payload: ${bytesToHex(bytes)} (tilt=${tilt})`);
        }
        this.setTilt(tilt);
      },
      () => {
        // A monitor from a previous link (torn down while its error
        // callback was still queued on the bridge) must not null the new
        // link's live tilt or restart into it — teardown() already reset
        // the old link's state when the epoch moved.
        if (epoch !== this.linkEpoch) {
          return;
        }
        // The stream can die without a link drop (transient GATT error) —
        // never keep reporting a frozen tilt as live posture.
        this.setTilt(null);
        this.maybeRestartTiltMonitor();
      },
    );
  }

  /**
   * Bounded recovery for a tilt stream that died while the link stayed up.
   * If the link actually dropped, gattReady is false (or the epoch has
   * moved) by the time the timer fires and this is a no-op — the
   * disconnect/reconnect path owns recovery there.
   */
  private maybeRestartTiltMonitor(): void {
    if (this.tiltMonitorRestarts >= TILT_MONITOR_MAX_RESTARTS) {
      return;
    }
    this.tiltMonitorRestarts += 1;
    const epoch = this.linkEpoch;
    setTimeout(() => {
      if (epoch !== this.linkEpoch || !this.gattReady) {
        return;
      }
      console.log(`${TAG} restarting tilt monitor (attempt ${this.tiltMonitorRestarts})`);
      this.startTiltMonitor();
    }, TILT_MONITOR_RESTART_DELAY_MS);
  }

  /**
   * Adopt the device's stored calibration as the posture reference. aab2
   * tells whether training mode is armed (0x02; resets on power cycle);
   * only then is the flash record in aab3 current rather than stale, and
   * its big-endian baseline is exactly what the device's own vibration
   * threshold (+120) is measured against. Failures are logged and ignored
   * — an app-side calibration can still establish a reference.
   */
  private async adoptDeviceCalibration(epoch: number): Promise<void> {
    try {
      const state = await this.read(Characteristic.calibrationState);
      this.assertCurrent(epoch);
      if (state[0] !== CalibrationState.calibrated) {
        return;
      }
      const record = await this.read(Characteristic.calibrationRecord);
      this.assertCurrent(epoch);
      if (record.length < 2) {
        return;
      }
      this.referenceTiltDecidegrees = (record[0] << 8) | record[1];
      if (__DEV__) {
        console.log(
          `${TAG} adopted device calibration: baseline=${this.referenceTiltDecidegrees}`,
        );
      }
      this.emitPosture();
    } catch (error) {
      console.log(`${TAG} calibration adoption skipped:`, error);
    }
  }

  /**
   * Live device vitals (battery, charging, worn, paused) from the notify
   * characteristics decoded 2026-07-03. Emits the current value
   * immediately, then on every change; all-null while disconnected or
   * before the first readings land. Listeners survive reconnects.
   */
  onVitalsChange(callback: (vitals: DeviceVitals) => void): Unsubscribe {
    this.vitalsListeners.add(callback);
    callback(this.vitals);
    return () => this.vitalsListeners.delete(callback);
  }

  private setVitals(partial: Partial<DeviceVitals>): void {
    this.vitals = { ...this.vitals, ...partial };
    for (const listener of this.vitalsListeners) {
      listener(this.vitals);
    }
  }

  /** Started per connection, like the tilt monitor. */
  private startVitalsMonitors(): void {
    this.monitor(Characteristic.batteryVoltage, (bytes) =>
      this.setVitals(decodeBattery(bytes)),
    );
    this.monitor(Characteristic.charging, (bytes) =>
      this.setVitals({ charging: bytes[0] === Command.on }),
    );
    this.monitor(Characteristic.worn, (bytes) =>
      this.setVitals({ worn: bytes[0] === Command.on }),
    );
    this.monitor(Characteristic.pauseMode, (bytes) =>
      this.setVitals({ paused: bytes[0] === Command.on }),
    );
  }

  /** Initial values — the notifies above only fire on change. */
  private async primeVitals(epoch: number): Promise<void> {
    const initialReads: [string, (bytes: Uint8Array) => Partial<DeviceVitals>][] = [
      [Characteristic.batteryVoltage, decodeBattery],
      [Characteristic.charging, (bytes) => ({ charging: bytes[0] === Command.on })],
      [Characteristic.worn, (bytes) => ({ worn: bytes[0] === Command.on })],
      [Characteristic.pauseMode, (bytes) => ({ paused: bytes[0] === Command.on })],
    ];
    for (const [characteristic, decode] of initialReads) {
      try {
        const bytes = await this.read(characteristic);
        this.assertCurrent(epoch);
        if (bytes.length > 0) {
          this.setVitals(decode(bytes));
        }
      } catch (error) {
        // A failed priming read just leaves that field null until its
        // notify fires; never abort the remaining reads for it.
        if (epoch !== this.linkEpoch) {
          return;
        }
        console.log(`${TAG} vitals priming read failed:`, error);
      }
    }
  }

  /**
   * Live forward-tilt angle in tenths of a degree; null while disconnected
   * or before the first reading. Emits the current value immediately, then
   * on change; listeners survive reconnects. Stream semantics are
   * documented on onPostureChange above.
   */
  onTiltChange(callback: (decidegrees: number | null) => void): Unsubscribe {
    this.tiltListeners.add(callback);
    callback(this.lastTiltDecidegrees);
    return () => this.tiltListeners.delete(callback);
  }

  /** Single writer for the tilt value; fans out to tilt + posture listeners. */
  private setTilt(decidegrees: number | null): void {
    if (this.lastTiltDecidegrees === decidegrees) {
      return;
    }
    this.lastTiltDecidegrees = decidegrees;
    for (const listener of this.tiltListeners) {
      listener(decidegrees);
    }
    this.emitPosture();
  }

  private postureStatus(): PostureStatus {
    if (
      this.lastTiltDecidegrees === null ||
      this.referenceTiltDecidegrees === null
    ) {
      return 'unknown';
    }
    return this.lastTiltDecidegrees >=
      this.referenceTiltDecidegrees + SLOUCH_OFFSET_DECIDEGREES
      ? 'slouching'
      : 'upright';
  }

  private emitPosture(): void {
    const status = this.postureStatus();
    if (status === this.lastEmittedPosture) {
      return;
    }
    this.lastEmittedPosture = status;
    for (const listener of this.postureListeners) {
      listener(status);
    }
  }

  /** Subscribe to the physical button (aac6, toggles 0x01/0x00 per press). */
  onButtonPress(callback: (pressed: boolean) => void): Unsubscribe {
    return this.monitor(Characteristic.button, (bytes) => {
      if (__DEV__) {
        console.log(`${TAG} aac6 payload: ${bytesToHex(bytes)}`);
      }
      callback(bytes[0] === Command.on);
    });
  }

  private setState(next: DeviceConnectionState): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    console.log(`${TAG} state: ${next}`);
    for (const listener of this.stateListeners) {
      listener(next);
    }
  }

  /**
   * Dev-only: log the discovered GATT tree and warn if any characteristic
   * we depend on is absent — this is how the aad5-doesn't-exist discrepancy
   * was caught. The authoritative service map is hardcoded (GAP-03 closed).
   */
  private async logGattTree(): Promise<void> {
    const lines: string[] = [];
    const present = new Set<string>();
    const services = await this.transport.servicesForDevice(this.id);
    for (const service of services) {
      lines.push(`service ${service.uuid}`);
      const characteristics = await this.transport.characteristicsForDevice(
        this.id,
        service.uuid,
      );
      for (const characteristic of characteristics) {
        present.add(characteristic.uuid.toLowerCase());
        const flags = [
          characteristic.isReadable && 'read',
          characteristic.isWritableWithResponse && 'write',
          characteristic.isWritableWithoutResponse && 'writeNoResp',
          characteristic.isNotifiable && 'notify',
          characteristic.isIndicatable && 'indicate',
        ]
          .filter(Boolean)
          .join(',');
        lines.push(`  characteristic ${characteristic.uuid} [${flags}]`);
      }
    }
    console.log(`${TAG} GATT tree:\n${lines.join('\n')}`);
    for (const uuid of Object.keys(SERVICE_BY_CHARACTERISTIC)) {
      if (!present.has(uuid)) {
        console.warn(`${TAG} expected characteristic missing on hardware: ${uuid}`);
      }
    }
  }

  private serviceFor(characteristicUuid: string): string {
    if (!this.gattReady) {
      throw new Error(
        `Characteristic ${characteristicUuid} not available — device not connected`,
      );
    }
    const serviceUuid = SERVICE_BY_CHARACTERISTIC[characteristicUuid];
    if (!serviceUuid) {
      throw new Error(`No service mapped for characteristic ${characteristicUuid}`);
    }
    return serviceUuid;
  }

  private async read(characteristicUuid: string): Promise<Uint8Array> {
    const characteristic = await this.transport.readCharacteristicForDevice(
      this.id,
      this.serviceFor(characteristicUuid),
      characteristicUuid,
    );
    return characteristic.value
      ? base64ToBytes(characteristic.value)
      : Uint8Array.of();
  }

  private async write(characteristicUuid: string, byte: number): Promise<void> {
    await this.transport.writeCharacteristicWithResponseForDevice(
      this.id,
      this.serviceFor(characteristicUuid),
      characteristicUuid,
      bytesToBase64(Uint8Array.of(byte)),
    );
  }

  private monitor(
    characteristicUuid: string,
    onBytes: (bytes: Uint8Array) => void,
    onEnded?: () => void,
  ): Unsubscribe {
    const subscription = this.transport.monitorCharacteristicForDevice(
      this.id,
      this.serviceFor(characteristicUuid),
      characteristicUuid,
      (error, characteristic) => {
        if (error) {
          // Expected when the connection drops; onDeviceDisconnected handles state.
          console.log(`${TAG} monitor ${characteristicUuid} ended:`, error.message);
          // A dead monitor won't fire again — don't hold it until teardown.
          this.monitorSubscriptions.delete(subscription);
          onEnded?.();
          return;
        }
        if (characteristic?.value) {
          onBytes(base64ToBytes(characteristic.value));
        }
      },
    );
    this.monitorSubscriptions.add(subscription);
    return () => {
      subscription.remove();
      this.monitorSubscriptions.delete(subscription);
    };
  }

  private teardown(): void {
    this.linkEpoch += 1;
    this.disconnectSubscription?.remove();
    this.disconnectSubscription = null;
    for (const subscription of this.monitorSubscriptions) {
      subscription.remove();
    }
    this.monitorSubscriptions.clear();
    this.gattReady = false;
    // No live tilt while disconnected; posture listeners hear 'unknown'.
    this.setTilt(null);
    // Same for vitals — stale battery/worn readings must not present as live.
    this.setVitals(EMPTY_VITALS);
  }
}

function decodeBattery(bytes: Uint8Array): Partial<DeviceVitals> {
  if (bytes.length < 2) {
    return {};
  }
  const millivolts = bytes[0] | (bytes[1] << 8);
  return { batteryPercent: batteryPercentFromMillivolts(millivolts) };
}
