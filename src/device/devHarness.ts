/**
 * Dev-only harness for hardware sessions (Phase 1 tasks 1.4/1.5; Phase 5
 * probes). Log output only — no UI beyond dev-gated trigger buttons.
 */

import {
  Characteristic,
  Command,
  SERVICE_BY_CHARACTERISTIC,
} from './characteristics';
import { base64ToBytes, bytesToBase64, bytesToHex } from './encoding';
import { getBleManager, onAdapterStateChange, requestBlePermissions } from './manager';
import { scanForDevices } from './scan';
import type { DiscoveredDevice } from './types';
import { UprightGoDevice } from './UprightGoDevice';

const TAG = '[harness]';

let started = false;

/**
 * Pass `calibrate = true` to trigger calibration 10s after connect
 * (GAP-04 check) — sit or stand in your ideal posture before the countdown
 * ends. Runs at most once per app session, so Fast Refresh remounts don't
 * spawn overlapping BLE sessions.
 */
export function runPhase1Harness(calibrate = false): void {
  if (started) {
    return;
  }
  started = true;
  run(calibrate).catch((error) => console.log(`${TAG} FAILED:`, error));
}

async function run(calibrate: boolean): Promise<void> {
  console.log(`${TAG} --- Phase 1 hardware session ---`);

  const granted = await requestBlePermissions();
  console.log(`${TAG} permissions granted: ${granted}`);
  if (!granted) {
    return;
  }
  // Deliberately never unsubscribed: adapter transitions are part of the
  // session log for as long as the harness-run app is alive.
  onAdapterStateChange((state) =>
    console.log(`${TAG} adapter state: ${state}`),
  );

  console.log(`${TAG} scanning for UprightGO (15s timeout)…`);
  const found = await new Promise<DiscoveredDevice | null>((resolve) => {
    const scan = scanForDevices({
      timeoutMs: 15_000,
      onDevice: (device) => {
        console.log(
          `${TAG} found ${device.name} id=${device.id} rssi=${device.rssi} signal=${device.signal}`,
        );
        scan.stop();
        resolve(device);
      },
      onTimeout: () => {
        console.log(`${TAG} scan timed out — is the device charged/nearby?`);
        resolve(null);
      },
      onError: (error) => {
        console.log(`${TAG} scan error:`, error);
        resolve(null);
      },
    });
  });
  if (!found) {
    return;
  }

  const device = new UprightGoDevice(getBleManager(), found.id, found.name);
  device.onConnectionStateChange((state) =>
    console.log(`${TAG} connection state → ${state}`),
  );

  console.log(`${TAG} connecting (GATT tree will be logged — GAP-03)…`);
  await device.connect();

  console.log(`${TAG} subscribing to posture (aaca) and button (aac6)…`);
  device.onPostureChange((status) => console.log(`${TAG} posture: ${status}`));
  device.onButtonPress((pressed) => console.log(`${TAG} button: ${pressed}`));

  // Note: the device blinks its green LED on its own right after a BLE
  // connection (firmware indicator) — unrelated to any aad6 write.
  await step('vibration pulse (aad3)', async () => {
    await device.setVibration(true);
    await delay(400);
    await device.setVibration(false);
  });

  if (calibrate) {
    await step('calibrate (GAP-04: aab1) — did the device react?', async () => {
      console.log(`${TAG} calibrating in 10s — hold your ideal posture…`);
      await delay(10_000);
      await device.calibrate();
    });
  }

  console.log(
    `${TAG} live: wear the device and slouch/straighten to log aaca payloads (GAP-02); press the physical button to test aac6.`,
  );
}

/**
 * Phase 5.6 probe: read EVERY readable characteristic on the connected
 * device and log a hex snapshot. Run it (a) freshly power-cycled and
 * uncalibrated, (b) right after calibrating, (c) after another power
 * cycle + reconnect — bytes that flip between (b) and (a)/(c) are
 * calibration-state candidates (prime suspects: aab2, aab3).
 * Reads only — ADR-006 forbids writes to undocumented characteristics,
 * not reads. UUIDs are enumerated from the live GATT tree, not hardcoded
 * (ADR-002 intact).
 */
export async function dumpReadableCharacteristics(deviceId: string): Promise<void> {
  const manager = getBleManager();
  console.log(`${TAG} --- readable-characteristics snapshot ---`);
  const services = await manager.servicesForDevice(deviceId);
  for (const service of services) {
    const characteristics = await manager.characteristicsForDevice(
      deviceId,
      service.uuid,
    );
    for (const characteristic of characteristics) {
      if (!characteristic.isReadable) {
        continue;
      }
      const label = `${shortUUID(service.uuid)}/${shortUUID(characteristic.uuid)}`;
      try {
        // Sequential on purpose — parallel reads congest the GATT queue.
        const read = await manager.readCharacteristicForDevice(
          deviceId,
          service.uuid,
          characteristic.uuid,
        );
        const hex = read.value ? bytesToHex(base64ToBytes(read.value)) : '(empty)';
        console.log(`${TAG} ${label}: ${hex}`);
      } catch (error) {
        console.log(`${TAG} ${label}: read failed —`, error);
      }
    }
  }
  console.log(`${TAG} --- snapshot end ---`);
}

function shortUUID(uuid: string): string {
  // 0000XXXX-0000-1000-8000-00805f9b34fb → xxxx
  return uuid.slice(4, 8).toLowerCase();
}

/**
 * Phase 5.2/GAP-06 probe: subscribe to EVERY notify/indicate characteristic
 * and log timestamped events. Run during a full wear session (upright →
 * slouch past the buzz → straighten → remove → button press → charger on/
 * off) to catalog which characteristics actually emit and when.
 * Prime suspects: aac4/aac9 (unknown notifies), aad2 (battery-voltage-like
 * reads: LE uint16 looks like millivolts), aac3 (worn flag?), aab2
 * (calibration flag, indicate). aaca is skipped — the device layer already
 * logs it. Subscriptions only; nothing is written (ADR-006 safe).
 */
export async function monitorAllNotifiables(
  deviceId: string,
): Promise<() => void> {
  const manager = getBleManager();
  const KNOWN_SPAMMY = new Set(['aaca']);
  const subscriptions: { remove: () => void }[] = [];
  const startedAt = Date.now();
  const stamp = () => `+${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
  console.log(`${TAG} --- monitoring all notify/indicate characteristics ---`);
  const services = await manager.servicesForDevice(deviceId);
  for (const service of services) {
    const characteristics = await manager.characteristicsForDevice(
      deviceId,
      service.uuid,
    );
    for (const characteristic of characteristics) {
      const short = shortUUID(characteristic.uuid);
      if (
        (!characteristic.isNotifiable && !characteristic.isIndicatable) ||
        KNOWN_SPAMMY.has(short)
      ) {
        continue;
      }
      const label = `${shortUUID(service.uuid)}/${short}`;
      subscriptions.push(
        manager.monitorCharacteristicForDevice(
          deviceId,
          service.uuid,
          characteristic.uuid,
          (error, notified) => {
            if (error) {
              console.log(`${TAG} ${stamp()} ${label} monitor ended: ${error.message}`);
              return;
            }
            if (notified?.value) {
              console.log(
                `${TAG} ${stamp()} ${label} → ${bytesToHex(base64ToBytes(notified.value))}`,
              );
            }
          },
        ),
      );
      console.log(`${TAG} subscribed ${label}`);
    }
  }
  console.log(`${TAG} monitoring ${subscriptions.length} characteristics — go use the device`);
  return () => {
    for (const subscription of subscriptions) {
      subscription.remove();
    }
    console.log(`${TAG} --- monitor probe stopped ---`);
  };
}

/**
 * Phase 5.4 probe (GAP-05): write a scripted sequence of values to the
 * vibration characteristic (aad3) and let the wearer report what each
 * feels like — pattern? intensity? plain on? Every test value is followed
 * by an explicit motor-off and a rest gap, so the motor can never be left
 * running and each sensation is separable. Writes use with-response, so a
 * value the firmware REJECTS surfaces as a logged GATT error (also data).
 * Scope note: aad3 is a documented, hardware-confirmed characteristic —
 * this probes its value space, which ADR-006 permits (its ban is on
 * undocumented/firmware characteristics).
 *
 * Hold or wear the device. Best run with training mode paused (press the
 * physical button) or while upright, so the device's own slouch buzz can't
 * blend into the readings.
 */
export async function runVibrationPatternProbe(deviceId: string): Promise<void> {
  const manager = getBleManager();
  const serviceUuid = SERVICE_BY_CHARACTERISTIC[Characteristic.vibration];
  const ON_MS = 3_000;
  const REST_MS = 2_000;
  // Singles sweep the value space coarsely; the pairs test whether the
  // firmware parses a second byte (duration? intensity? repeat count?).
  const testValues: number[][] = [
    [0x02], [0x03], [0x04], [0x05], [0x0a],
    [0x10], [0x20], [0x40], [0x80], [0xff],
    [0x01, 0x01], [0x01, 0x05], [0x01, 0xff],
    [0x05, 0x05], [0xff, 0xff],
  ];

  const writeValue = async (bytes: number[]) => {
    await manager.writeCharacteristicWithResponseForDevice(
      deviceId,
      serviceUuid,
      Characteristic.vibration,
      bytesToBase64(Uint8Array.from(bytes)),
    );
  };
  const off = async () => {
    try {
      await writeValue([Command.off]);
    } catch (error) {
      console.log(`${TAG} motor-off write failed — POWER CYCLE THE DEVICE IF STILL BUZZING`, error);
    }
  };

  console.log(`${TAG} --- vibration pattern probe: ${testValues.length} values, ~${Math.round(((ON_MS + REST_MS) * testValues.length) / 1000)}s ---`);
  console.log(`${TAG} note per value: nothing / plain buzz / pulses / weaker / stronger`);
  for (const [index, value] of testValues.entries()) {
    const label = `[${index + 1}/${testValues.length}] aad3 ← ${bytesToHex(Uint8Array.from(value))}`;
    console.log(`${TAG} ${label} — feel now…`);
    try {
      await writeValue(value);
    } catch (error) {
      console.log(`${TAG} ${label} REJECTED by firmware:`, error);
    }
    await delay(ON_MS);
    await off();
    await delay(REST_MS);
  }
  await off();
  console.log(`${TAG} --- vibration probe done (motor off) ---`);
}

/**
 * Phase 5.4 follow-up: are non-0x01 single bytes IGNORED or do they act
 * as STOP? Starts the motor with 0x01, writes a probe value mid-buzz,
 * and leaves 3s to observe whether the buzz survives it. Two rounds
 * (0x05, 0xff), each ended with a real 0x00 stop.
 */
export async function runVibrationStopSemanticsProbe(deviceId: string): Promise<void> {
  const manager = getBleManager();
  const serviceUuid = SERVICE_BY_CHARACTERISTIC[Characteristic.vibration];
  const writeValue = (byte: number) =>
    manager.writeCharacteristicWithResponseForDevice(
      deviceId,
      serviceUuid,
      Characteristic.vibration,
      bytesToBase64(Uint8Array.of(byte)),
    );
  console.log(`${TAG} --- vibration stop-semantics probe ---`);
  for (const probeByte of [0x05, 0xff]) {
    try {
      console.log(`${TAG} motor ON (0x01)…`);
      await writeValue(Command.on);
      await delay(2_000);
      console.log(
        `${TAG} writing 0x${probeByte.toString(16).padStart(2, '0')} mid-buzz — DID IT STOP OR KEEP BUZZING?`,
      );
      await writeValue(probeByte);
      await delay(3_000);
    } finally {
      console.log(`${TAG} motor OFF (0x00)`);
      await writeValue(Command.off).catch((error) =>
        console.log(`${TAG} off write failed — power cycle if still buzzing`, error),
      );
    }
    await delay(1_500);
  }
  console.log(`${TAG} --- stop-semantics probe done ---`);
}

/**
 * Phase 5.7 probe: can the app toggle pause mode by writing aac7?
 * Three escalating steps, each user-gated (observe before advancing):
 *   1 — NULL WRITE: read aac7, write back the exact value it already
 *       holds. Tests "is writing this characteristic safe" with zero
 *       intended state change.
 *   2 — write 0x01 (pause). Expected if it works: aac7 notify fires →
 *       the app's "Reminders paused" hint appears; slouching stops
 *       triggering the buzz — identical to a physical button press.
 *   3 — write 0x00 (resume). Hint disappears, buzz behavior returns.
 * Values written are strictly the two the firmware itself emits for this
 * flag (observed via button presses). Every step reads back and logs.
 */
export async function runPauseWriteStep(
  deviceId: string,
  step: 1 | 2 | 3,
): Promise<void> {
  const manager = getBleManager();
  const serviceUuid = SERVICE_BY_CHARACTERISTIC[Characteristic.pauseMode];
  const readBack = async (label: string) => {
    const characteristic = await manager.readCharacteristicForDevice(
      deviceId,
      serviceUuid,
      Characteristic.pauseMode,
    );
    const bytes = characteristic.value
      ? base64ToBytes(characteristic.value)
      : Uint8Array.of();
    console.log(`${TAG} aac7 ${label}: ${bytesToHex(bytes)}`);
    return bytes;
  };
  const writeValue = (byte: number) =>
    manager.writeCharacteristicWithResponseForDevice(
      deviceId,
      serviceUuid,
      Characteristic.pauseMode,
      bytesToBase64(Uint8Array.of(byte)),
    );

  console.log(`${TAG} --- pause-write probe, step ${step}/3 ---`);
  try {
    const before = await readBack('before');
    if (step === 1) {
      if (before.length === 0) {
        console.log(`${TAG} empty read — aborting null write`);
        return;
      }
      console.log(`${TAG} null write: writing back 0x${before[0].toString(16).padStart(2, '0')}…`);
      await writeValue(before[0]);
    } else {
      const target = step === 2 ? Command.on : Command.off;
      console.log(`${TAG} writing 0x0${target} (${step === 2 ? 'pause' : 'resume'})…`);
      await writeValue(target);
    }
    console.log(`${TAG} write ACCEPTED`);
    await readBack('after');
    console.log(
      step === 1
        ? `${TAG} step 1 done — confirm the device still behaves (test vibration, tilt logs), then run step 2`
        : step === 2
          ? `${TAG} step 2 done — check for the "Reminders paused" hint and confirm slouching does NOT buzz, then run step 3`
          : `${TAG} step 3 done — hint should be gone and slouch buzz back to normal`,
    );
  } catch (error) {
    console.log(`${TAG} step ${step} write REJECTED/failed:`, error);
  }
}

/** Run one hardware probe; a failure is logged but never aborts the session. */
async function step(label: string, action: () => Promise<void>): Promise<void> {
  console.log(`${TAG} ${label}`);
  try {
    await action();
    console.log(`${TAG} step OK: ${label}`);
  } catch (error) {
    console.log(`${TAG} step FAILED: ${label}`, error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
