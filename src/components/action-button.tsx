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
  icon,
}: {
  label: string;
  onPress: () => void;
  accessibilityLabel: string;
  variant?: ActionButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  /** Fit content width (e.g. inside a device card) instead of full width. */
  compact?: boolean;
  /** Decorative leading icon; replaced by the spinner while loading. */
  icon?: React.ReactNode;
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
      {loading ? <ActivityIndicator size="small" color={labelColor} /> : icon}
      <Text
        style={[
          styles.label,
          { color: labelColor, fontWeight: LABEL_WEIGHT[variant] },
        ]}
        maxFontSizeMultiplier={2}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Outline reads as a quieter secondary action (specs/assets/
// device_selection.png shows Connect at regular weight); filled variants
// keep the bold button token.
const LABEL_WEIGHT: Record<ActionButtonVariant, '400' | '700'> = {
  primary: '700',
  neutral: '700',
  outline: '400',
  ghost: '700',
};

const LABEL_COLOR: Record<ActionButtonVariant, string> = {
  primary: Palette.primaryCharcoal,
  neutral: Palette.cardSoftCream,
  // Amber like the border (specs/assets/device_selection.png), darkened to
  // pass WCAG AA on the cream fill — raw accentAmber is ~2:1 there.
  outline: Palette.accentAmberText,
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
