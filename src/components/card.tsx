import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Layout, Palette } from '@/constants/palette';

/** Soft-cream bordered card — the base surface per docs/design.html. */
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.card, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    borderRadius: Layout.radiusCard,
    padding: Layout.cardPadding,
    gap: 4,
  },
});
