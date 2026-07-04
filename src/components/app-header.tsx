import React from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';

/**
 * App wordmark header: logo tile beside the app name, used on screens
 * without a native navigation header (home, connected).
 */
export function AppHeader({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.header, style]}>
      {/* Decorative — the app name right beside it carries the meaning. */}
      <View
        style={styles.logoTile}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Image
          source={require('../../assets/images/logo.png')}
          style={styles.logoImage}
        />
      </View>
      <Text style={[Type.display, styles.title]}>Open Posture Companion</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
  },
  logoTile: {
    width: 64,
    height: 64,
    borderRadius: Layout.radiusIconTile,
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: {
    width: 52,
    height: 52,
  },
  title: {
    flex: 1,
    // Type.display scaled ~10% down so two lines sit within the 64px logo
    // tile, at regular weight so it reads as a wordmark, not a heading.
    fontSize: 25,
    lineHeight: 31,
    fontWeight: '400',
  },
});
