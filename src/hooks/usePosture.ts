/**
 * Live posture status for the shared device (Phase 2.2).
 */

import { useEffect, useState } from 'react';

import type { PostureStatus } from '@/device/types';

import { useDevice } from './useDevice';

/**
 * Returns 'unknown' until a device is connected AND the user has calibrated —
 * classification is relative to the calibration reference (see
 * UprightGoDevice.onPostureChange). The device emits 'unknown' on disconnect
 * and re-creates its BLE monitor per connection, so this hook only has to
 * track the instance.
 */
export function usePosture(): PostureStatus {
  const { device } = useDevice();
  const [posture, setPosture] = useState<PostureStatus>('unknown');

  useEffect(() => {
    if (!device) {
      return;
    }
    // Emits the current status immediately, so no reset between instances.
    return device.onPostureChange(setPosture);
  }, [device]);

  return posture;
}
