// Design tokens from specs/design_tokens.json — see docs/design.html
export const Palette = {
  backgroundWarmWhite: '#F8F3EA',
  cardSoftCream: '#FFFDF8',
  primaryCharcoal: '#202832',
  secondarySlate: '#56616D',
  accentAmber: '#F5A623',
  // accentAmber darkened for text: ≥4.5:1 (WCAG AA) on all warm surfaces
  // (5.4:1 on cardSoftCream, ~4.9:1 on softAmber / backgroundWarmWhite).
  accentAmberText: '#8F5F00',
  softAmber: '#FFF1D6',
  successGreen: '#4FA66A',
  // Decorative pale tint of successGreen, softAmber's counterpart.
  softGreen: '#E6F2EA',
  warningOrange: '#E58A1F',
  errorRed: '#D9534F',
  borderDivider: '#E7DED0',
} as const;

export const Layout = {
  pagePadding: 24,
  cardPadding: 20,
  sectionGap: 28,
  componentGap: 14,
  buttonHeight: 56,
  radiusCard: 22,
  radiusButton: 16,
  radiusIconTile: 18,
  /** Pressed-state dim for Pressable feedback, app-wide. */
  pressedOpacity: 0.6,
} as const;
