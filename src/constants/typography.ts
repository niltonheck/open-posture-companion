import { StyleSheet } from 'react-native';

import { Palette } from './palette';

/**
 * Text tokens from docs/design.html. Screens compose overrides via style
 * arrays (e.g. [Type.body, { color: Palette.errorRed }]) instead of
 * re-declaring the metrics.
 */
export const Type = StyleSheet.create({
  /** Screen title — 28/700/34. */
  display: {
    fontSize: 28,
    fontWeight: '700',
    lineHeight: 34,
    color: Palette.primaryCharcoal,
  },
  /** Section / card title — 18/700/24. */
  title: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
    color: Palette.primaryCharcoal,
  },
  /** Body — 16/400/24. */
  body: {
    fontSize: 16,
    lineHeight: 24,
    color: Palette.secondarySlate,
  },
  /** Caption — 12/400/18, disclaimers and compatibility notes. */
  caption: {
    fontSize: 12,
    lineHeight: 18,
    color: Palette.secondarySlate,
  },
});
