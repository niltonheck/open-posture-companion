import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { Type } from '@/constants/typography';

/**
 * Footer disclaimer, approved strings only (docs/product.html). The medical
 * line is mandatory on the calibration screen and the home screen.
 */
export function Disclaimer({ medical = false }: { medical?: boolean }) {
  return (
    <Text style={[Type.caption, styles.centered]}>
      Independent app · Not affiliated with UPRIGHT
      {medical && '\nThis app is not a medical device.'}
    </Text>
  );
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
});
