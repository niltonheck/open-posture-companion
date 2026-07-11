import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Layout, Palette } from '@/constants/palette';

/**
 * Segment-based posture ribbon for the Statistics screen (Phase 11):
 * consecutive equal minute-flags render as one proportional block over an
 * arbitrary minute-of-day window, in the same visual grammar as the
 * connected screen's per-minute strip — green low = upright, red tall =
 * slouched, recessive slate dashes = no data (never color alone; heights
 * carry the meaning too). Upright/slouched segments are tappable when
 * `onSelectSegment` is given (tap-for-range, specs/design_decisions.md);
 * gaps never are.
 */

export interface RibbonSegment {
  flag: 'u' | 's';
  /** Minute of the local day, inclusive. */
  startMinute: number;
  /** Minute of the local day, exclusive. */
  endMinute: number;
}

export interface MinuteWindow {
  start: number;
  end: number;
}

/**
 * Auto-fit window: the day's worn span padded a little so sessions don't
 * touch the edges (specs/design_decisions.md — ribbons trim to worn
 * hours). Null when the day has no worn minutes.
 */
export function wornWindow(
  minuteFlags: string,
  padMinutes: number = 10,
): MinuteWindow | null {
  let first = -1;
  let last = -1;
  for (let minute = 0; minute < minuteFlags.length; minute += 1) {
    if (minuteFlags[minute] === 'u' || minuteFlags[minute] === 's') {
      if (first < 0) {
        first = minute;
      }
      last = minute;
    }
  }
  if (first < 0) {
    return null;
  }
  return {
    start: Math.max(0, first - padMinutes),
    end: Math.min(24 * 60, last + padMinutes + 1),
  };
}

/** "13:05" from a minute of the local day. */
export function formatMinuteOfDay(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, '0');
  const minutes = String(minute % 60).padStart(2, '0');
  return `${hours}:${minutes}`;
}

interface Run {
  flag: 'u' | 's' | '.';
  startMinute: number;
  endMinute: number;
}

function runsOf(minuteFlags: string, window: MinuteWindow): Run[] {
  const runs: Run[] = [];
  const flagAt = (minute: number): Run['flag'] => {
    const flag = minuteFlags[minute];
    return flag === 'u' || flag === 's' ? flag : '.';
  };
  let startMinute = window.start;
  let current = flagAt(window.start);
  for (let minute = window.start + 1; minute <= window.end; minute += 1) {
    const flag = minute < window.end ? flagAt(minute) : null;
    if (flag !== current) {
      runs.push({ flag: current, startMinute, endMinute: minute });
      if (flag !== null) {
        startMinute = minute;
        current = flag;
      }
    }
  }
  return runs;
}

export function segmentEquals(
  a: RibbonSegment | null,
  b: RibbonSegment | null,
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.flag === b.flag &&
    a.startMinute === b.startMinute &&
    a.endMinute === b.endMinute
  );
}

export function PostureRibbon({
  minuteFlags,
  window,
  nowMinute = null,
  onSelectSegment,
  selectedSegment = null,
  accessibilityLabel,
  style,
}: {
  minuteFlags: string | null;
  /** Null (or null flags) renders one full-width recessive dash strip. */
  window: MinuteWindow | null;
  /** Draws the charcoal now-marker at this minute when inside the window. */
  nowMinute?: number | null;
  onSelectSegment?: (segment: RibbonSegment) => void;
  selectedSegment?: RibbonSegment | null;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const sizes = REGULAR;
  const runs =
    minuteFlags !== null && window !== null ? runsOf(minuteFlags, window) : [];
  const showNowMarker =
    nowMinute !== null &&
    window !== null &&
    nowMinute >= window.start &&
    nowMinute <= window.end;
  return (
    <View
      style={[styles.row, { height: sizes.slouched }, style]}
      accessible={runs.length === 0 || onSelectSegment === undefined}
      accessibilityLabel={accessibilityLabel}
    >
      {runs.length === 0 ? (
        <View
          style={[styles.segment, styles.empty, { flex: 1, height: sizes.empty }]}
        />
      ) : (
        runs.map((run) => {
          const minutes = run.endMinute - run.startMinute;
          if (run.flag === '.' || onSelectSegment === undefined) {
            return (
              <View
                key={run.startMinute}
                style={[
                  styles.segment,
                  run.flag === 'u'
                    ? [styles.upright, { height: sizes.upright }]
                    : run.flag === 's'
                      ? [styles.slouched, { height: sizes.slouched }]
                      : [styles.empty, { height: sizes.empty }],
                  { flex: minutes },
                ]}
              />
            );
          }
          const segment: RibbonSegment = {
            flag: run.flag,
            startMinute: run.startMinute,
            endMinute: run.endMinute,
          };
          const selected = segmentEquals(selectedSegment, segment);
          return (
            <Pressable
              key={run.startMinute}
              accessibilityRole="button"
              accessibilityLabel={`${formatMinuteOfDay(run.startMinute)} to ${formatMinuteOfDay(
                run.endMinute,
              )}, ${run.flag === 'u' ? 'upright' : 'slouched'}, ${minutes} ${
                minutes === 1 ? 'minute' : 'minutes'
              }`}
              accessibilityState={{ selected }}
              onPress={() => onSelectSegment(segment)}
              // Thin one-minute segments stay tappable via the row height.
              hitSlop={{ top: 4, bottom: 4 }}
              style={({ pressed }) => [
                styles.segment,
                run.flag === 'u'
                  ? [styles.upright, { height: sizes.upright }]
                  : [styles.slouched, { height: sizes.slouched }],
                { flex: minutes },
                selected && styles.selected,
                pressed && { opacity: Layout.pressedOpacity },
              ]}
            />
          );
        })
      )}
      {showNowMarker && (
        <View
          pointerEvents="none"
          style={[
            styles.nowMarker,
            {
              left: `${(((nowMinute as number) - (window as MinuteWindow).start) /
                ((window as MinuteWindow).end - (window as MinuteWindow).start)) *
                100}%`,
            },
          ]}
        />
      )}
    </View>
  );
}

// Matches the connected screen's strip exactly. One size everywhere — the
// 2026-07-11 usability review killed the smaller history-row variant
// (illegible, untappable).
const REGULAR = { slouched: 16, upright: 8, empty: 3 } as const;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
  },
  segment: {
    minWidth: 1,
    borderRadius: 1,
  },
  upright: {
    backgroundColor: Palette.successGreen,
  },
  slouched: {
    backgroundColor: Palette.errorRed,
  },
  empty: {
    // Same recessive treatment as the connected timeline's gaps.
    backgroundColor: Palette.secondarySlate,
    opacity: 0.35,
  },
  selected: {
    borderWidth: 1.5,
    borderColor: Palette.primaryCharcoal,
  },
  nowMarker: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    marginLeft: -1,
    borderRadius: 1,
    backgroundColor: Palette.primaryCharcoal,
  },
});
