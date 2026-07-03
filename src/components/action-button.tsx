import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { Layout, Palette } from '@/constants/palette';

export type ActionButtonVariant = 'primary' | 'neutral' | 'outline' | 'ghost';

/**
 * The four button styles from docs/design.html: primary (amber hero),
 * neutral (charcoal, for scan entry actions), outline (amber border on
 * cream, e.g. per-card Connect), ghost (plain text action). Loading always
 * pairs the spinner with the label text (accessibility guideline in
 * docs/product.html).
 */
export function ActionButton({
  label,
  onPress,
  accessibilityLabel,
  variant = 'primary',
  disabled = false,
  loading = false,
  compact = false,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: ActionButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** Fit content width (e.g. inside a device card) instead of full width. */
  compact?: boolean;
}) {
  const labelColor = LABEL_COLOR[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        compact && styles.compact,
        pressed && styles.pressed,
        (disabled || loading) && styles.disabled,
      ]}
    >
      {loading && <ActivityIndicator size="small" color={labelColor} />}
      <Text
        style={[styles.label, { color: labelColor }]}
        maxFontSizeMultiplier={2}
      >
        {label}
      </Text>
    </Pressable>
  );
}

const LABEL_COLOR: Record<ActionButtonVariant, string> = {
  primary: Palette.primaryCharcoal,
  neutral: Palette.cardSoftCream,
  outline: Palette.primaryCharcoal,
  ghost: Palette.primaryCharcoal,
};

const styles = StyleSheet.create({
  base: {
    // minHeight, not height: the label may scale up to 2× with the user's
    // font settings (capped above) and the button must grow, not clip.
    minHeight: Layout.buttonHeight,
    borderRadius: Layout.radiusButton,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  primary: {
    backgroundColor: Palette.accentAmber,
  },
  neutral: {
    backgroundColor: Palette.primaryCharcoal,
  },
  outline: {
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.accentAmber,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
  compact: {
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 4,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.5,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 22,
    flexShrink: 1,
    textAlign: 'center',
  },
});
