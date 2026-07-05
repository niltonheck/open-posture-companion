import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';

/**
 * In-page header for sub-flow screens whose native bar is hidden
 * (specs/design_decisions.md): back arrow at the left edge, centered
 * title. iOS swipe-back stays enabled; this arrow is the visible way out.
 */
export function PageHeader({ title }: { title: string }) {
  const router = useRouter();
  return (
    <View style={styles.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        hitSlop={12}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <MaterialIcons
          name="arrow-back"
          size={28}
          color={Palette.primaryCharcoal}
        />
      </Pressable>
      <Text style={Type.pageTitle} accessibilityRole="header">
        {title}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Layout.pagePadding,
    paddingVertical: Layout.componentGap,
  },
  backButton: {
    position: 'absolute',
    left: Layout.pagePadding,
  },
  pressed: {
    opacity: Layout.pressedOpacity,
  },
});
