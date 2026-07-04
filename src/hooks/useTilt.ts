/**
 * Live forward-tilt readout for the shared device (Phase 6.5).
 */

import { useEffect, useState } from 'react';

import { useDevice } from './useDevice';

/**
 * Current forward-tilt angle in whole degrees; null while disconnected or
 * before the first reading. State holds the rounded value, so the chatty
 * deci-degree aaca stream only re-renders consumers on whole-degree changes.
 */
export function useTilt(): number | null {
  const { device } = useDevice();
  const [degrees, setDegrees] = useState<number | null>(null);

  useEffect(() => {
    if (!device) {
      return;
    }
    // Emits the current value immediately, so no reset between instances.
    return device.onTiltChange((decidegrees) =>
      setDegrees(decidegrees === null ? null : Math.round(decidegrees / 10)),
    );
  }, [device]);

  return degrees;
}
