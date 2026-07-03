// Design tokens from specs/design_tokens.json — see docs/design.html
export const Palette = {
  backgroundWarmWhite: '#F8F3EA',
  cardSoftCream: '#FFFDF8',
  primaryCharcoal: '#202832',
  secondarySlate: '#56616D',
  accentAmber: '#F5A623',
  softAmber: '#FFF1D6',
  successGreen: '#4FA66A',
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
} as const;
