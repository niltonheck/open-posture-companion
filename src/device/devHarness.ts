/**
 * Dev-only harness for hardware sessions (Phase 1 tasks 1.4/1.5; Phase 5
 * probes). Log output only — no UI beyond dev-gated trigger buttons.
 */

import { base64ToBytes, bytesToHex } from './encoding';
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
