/**
 * Live device vitals (battery, charging, worn, paused) for the shared
 * device. All-null until readings arrive and while disconnected — same
 * subscription pattern as usePosture.
 */

import { useEffect, useState } from 'react';

import type { DeviceVitals } from '@/device/types';

import { useDevice } from './useDevice';

const NO_VITALS: DeviceVitals = {
  batteryPercent: null,
  charging: null,
  worn: null,
  paused: null,
};

export function useVitals(): DeviceVitals {
  const { device } = useDevice();
  const [vitals, setVitals] = useState<DeviceVitals>(NO_VITALS);

  useEffect(() => {
    if (!device) {
      return;
    }
    // Emits the current value immediately, so no reset between instances.
    return device.onVitalsChange(setVitals);
  }, [device]);

  return vitals;
}
