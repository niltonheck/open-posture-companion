import { MaterialIcons } from '@expo/vector-icons';
import React, { useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { Card } from '@/components/card';
import { PageHeader } from '@/components/page-header';
import {
  formatMinuteOfDay,
  PostureRibbon,
  wornWindow,
  type MinuteWindow,
  type RibbonSegment,
} from '@/components/posture-ribbon';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
import { DEMO_DEVICE_ID } from '@/device/demoTransport';
import { useDevice } from '@/hooks/useDevice';
import { useSessionStats } from '@/hooks/useSessionStats';
import { buildDemoHistoryDay } from '@/storage/demoDayStats';
import {
  dateKeyDaysAgo,
  HISTORY_DAYS,
  loadRecentDays,
  type DayStats,
  type HistoryDay,
} from '@/storage/sessionStats';

/**
 * Statistics screen (Phase 11, specs/design_decisions.md → "Statistics &
 * history"): Today / 7 days / 30 days tiles, the 30-day bar chart, and the
 * history calendar of day rows that expand in place — the whole row is the
 * tap target (2026-07-11 usability review), and the unfolded day carries
 * the full-size ribbon, time labels, day stats, and tap-for-range. A
 * chart-bar tap scrolls to and expands that day's row: one detail surface.
 * Sparse/empty states keep the full layout — nothing unmounts, quiet copy
 * explains what fills each card.
 */

/** Upright % day grading (user-visible via the ⓘ tip — never color alone). */
const GRADE_GREEN_MIN_PERCENT = 80;
const GRADE_AMBER_MIN_PERCENT = 65;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function dateOf(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day);
}

/** "Today" / "Yesterday" / "Wed, Jul 8". */
function dayLabel(day: HistoryDay): string {
  if (day.daysAgo === 0) {
    return 'Today';
  }
  if (day.daysAgo === 1) {
    return 'Yesterday';
  }
  const date = dateOf(day.dateKey);
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()].slice(0, 3)} ${date.getDate()}`;
}

/** Compact history-row form: "Wed 8". */
function rowLabel(day: HistoryDay): string {
  const date = dateOf(day.dateKey);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}`;
}

/** "6 h 10 min" / "45 min" — same form as the connected screen. */
function formatMinutes(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/** Any worn minute at all — the display gate for "this day has data". */
function hasData(stats: DayStats | null): stats is DayStats {
  return stats !== null && stats.postureTicks > 0;
}

interface RangeTotals {
  wornMinutes: number;
  slouchedMinutes: number;
  slouchCount: number;
  /** Null until the first worn minute — tiles show an em-dash, not "0%". */
  uprightPercent: number | null;
}

/**
 * Time-based upright %, the same method as the connected screen's caption:
 * measured slouched seconds over worn-connected time, clamped because
 * crediting granularity can momentarily put the numerator ahead.
 */
function totalsOf(days: HistoryDay[]): RangeTotals {
  let wornMinutes = 0;
  let slouchedSeconds = 0;
  let slouchCount = 0;
  for (const day of days) {
    if (!hasData(day.stats)) {
      continue;
    }
    wornMinutes += day.stats.postureTicks;
    slouchedSeconds += day.stats.slouchedSeconds;
    slouchCount += day.stats.slouchCount;
  }
  return {
    wornMinutes,
    slouchedMinutes: Math.round(slouchedSeconds / 60),
    slouchCount,
    uprightPercent:
      wornMinutes === 0
        ? null
        : Math.min(
            100,
            Math.max(
              0,
              Math.round((1 - slouchedSeconds / (wornMinutes * 60)) * 100),
            ),
          ),
  };
}

function gradeColor(percent: number): string {
  return percent >= GRADE_GREEN_MIN_PERCENT
    ? Palette.successGreen
    : percent >= GRADE_AMBER_MIN_PERCENT
      ? Palette.accentAmber
      : Palette.errorRed;
}

/** Grade color for text — amber text always via accentAmberText (WCAG). */
function gradeTextColor(percent: number): string {
  return percent >= GRADE_GREEN_MIN_PERCENT
    ? Palette.successGreen
    : percent >= GRADE_AMBER_MIN_PERCENT
      ? Palette.accentAmberText
      : Palette.errorRed;
}

type StatsRange = 'day' | 'week' | 'month';

const RANGE_OPTIONS: { key: StatsRange; label: string }[] = [
  { key: 'day', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
];

interface Selection {
  /** The row's dateKey — a segment highlights only in the row it was tapped. */
  dateKey: string;
  segment: RibbonSegment;
}

function selectionText(segment: RibbonSegment): string {
  const minutes = segment.endMinute - segment.startMinute;
  const range = `${formatMinuteOfDay(segment.startMinute)} – ${formatMinuteOfDay(segment.endMinute)}`;
  const what = segment.flag === 'u' ? 'Upright' : 'Slouched';
  return `${range} · ${what} ${formatMinutes(minutes)}`;
}

function minuteOfDayNow(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

export default function StatsScreen() {
  const insets = useSafeAreaInsets();
  const { device } = useDevice();
  const todayStats = useSessionStats();
  // Same gate as useSessionStats: a demo session presents a generated
  // 30-day history so the screen is rich for App Store review — in memory
  // only, the real session-stats keys are never touched.
  const demoActive = device?.id === DEMO_DEVICE_ID;

  const days: HistoryDay[] = useMemo(() => {
    const stored: HistoryDay[] = demoActive
      ? Array.from({ length: HISTORY_DAYS }, (_, daysAgo) => ({
          dateKey: dateKeyDaysAgo(daysAgo),
          daysAgo,
          stats: daysAgo === 0 ? null : buildDemoHistoryDay(daysAgo),
        }))
      : loadRecentDays();
    // Today always comes from the live provider (fresher than storage in a
    // real session; the demo fixture itself in a demo one) so this screen
    // and the connected screen tell the same story.
    return stored.map((day) =>
      day.daysAgo === 0 ? { ...day, stats: todayStats } : day,
    );
  }, [demoActive, todayStats]);

  const [range, setRange] = useState<StatsRange>('day');
  const [tipOpen, setTipOpen] = useState(false);
  // Today starts unfolded — parity with the old default detail view.
  const [expandedKey, setExpandedKey] = useState<string | null>(() =>
    dateKeyDaysAgo(0),
  );
  const [selection, setSelection] = useState<Selection | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const listYRef = useRef(0);
  const rowYsRef = useRef<Record<string, number>>({});

  const totals = useMemo(
    () =>
      totalsOf(
        range === 'day'
          ? days.slice(0, 1)
          : range === 'week'
            ? days.slice(0, 7)
            : days,
      ),
    [days, range],
  );

  const recordedCount = days.filter((day) => hasData(day.stats)).length;

  // Rows: recorded days only — plus today, always (design log). Collapsed
  // rows share one window (union of worn spans) so noon aligns with noon.
  const rows = days.filter((day) => day.daysAgo === 0 || hasData(day.stats));
  const listWindow = useMemo((): MinuteWindow | null => {
    let window: MinuteWindow | null = null;
    for (const day of days) {
      const span = hasData(day.stats) ? wornWindow(day.stats.minuteFlags) : null;
      if (span) {
        window = window
          ? {
              start: Math.min(window.start, span.start),
              end: Math.max(window.end, span.end),
            }
          : span;
      }
    }
    return window;
  }, [days]);

  const toggleRow = (dateKey: string) => {
    setSelection(null);
    setExpandedKey((previous) => (previous === dateKey ? null : dateKey));
  };

  // Chart-bar tap: unfold the day's row and bring it into view. The scroll
  // waits a beat because folding the previously open row shifts positions;
  // by then onLayout has refreshed the offsets.
  const expandFromChart = (dateKey: string) => {
    setSelection(null);
    setExpandedKey(dateKey);
    setTimeout(() => {
      scrollRef.current?.scrollTo({
        y: Math.max(0, listYRef.current + (rowYsRef.current[dateKey] ?? 0) - 12),
        animated: true,
      });
    }, 100);
  };

  let lastMonth = -1;

  return (
    // Bottom edge released so the scroll flows under the home indicator;
    // the inset moves into the content's bottom padding (see connected.tsx).
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <PageHeader title="Statistics" />
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Layout.pagePadding + insets.bottom },
        ]}
      >
        <RangeControl range={range} onChange={setRange} />
        <StatTiles
          totals={totals}
          tipOpen={tipOpen}
          onToggleTip={() => setTipOpen((open) => !open)}
        />
        {tipOpen && (
          <View style={styles.tip} accessibilityLiveRegion="polite">
            <Text style={[Type.caption, styles.tipText]}>
              <Text style={styles.tipBold}>How this is calculated: </Text>
              Upright % is your upright time divided by the time you wore the
              device. Days grade green at {GRADE_GREEN_MIN_PERCENT}% or more,
              amber from {GRADE_AMBER_MIN_PERCENT}%, red below. In timelines,
              short green bars are upright time, tall red bars are slouches,
              and only the hours you wore the device are shown.
            </Text>
          </View>
        )}

        <Card>
          <Text style={Type.title}>Last 30 days</Text>
          <BarChart
            days={days}
            expandedKey={expandedKey}
            onSelectDay={expandFromChart}
          />
          {recordedCount === 0 ? (
            <Text style={Type.caption}>
              Each day you track fills one bar — your month builds up here.
            </Text>
          ) : (
            // Persistent legend: the grade colors must never carry the
            // meaning alone (design log) — the ⓘ tip holds the formula,
            // but the thresholds live right under the bars they color.
            <View
              style={styles.gradeLegend}
              accessible
              accessibilityLabel={`Bar colors: green ${GRADE_GREEN_MIN_PERCENT} percent or more upright, amber ${GRADE_AMBER_MIN_PERCENT} to ${GRADE_GREEN_MIN_PERCENT - 1}, red below ${GRADE_AMBER_MIN_PERCENT}`}
            >
              <View style={styles.gradeLegendItem}>
                <View
                  style={[styles.gradeDot, { backgroundColor: Palette.successGreen }]}
                />
                <Text style={Type.caption}>
                  ≥ {GRADE_GREEN_MIN_PERCENT}% upright
                </Text>
              </View>
              <View style={styles.gradeLegendItem}>
                <View
                  style={[styles.gradeDot, { backgroundColor: Palette.accentAmber }]}
                />
                <Text style={Type.caption}>
                  {GRADE_AMBER_MIN_PERCENT}–{GRADE_GREEN_MIN_PERCENT - 1}%
                </Text>
              </View>
              <View style={styles.gradeLegendItem}>
                <View
                  style={[styles.gradeDot, { backgroundColor: Palette.errorRed }]}
                />
                <Text style={Type.caption}>
                  below {GRADE_AMBER_MIN_PERCENT}%
                </Text>
              </View>
            </View>
          )}
        </Card>

        <Text style={[Type.caption, styles.listLabel]} accessibilityRole="header">
          HISTORY
        </Text>
        {listWindow && (
          <View style={styles.listWindowRow}>
            <Text style={Type.caption}>{formatMinuteOfDay(listWindow.start)}</Text>
            <Text style={Type.caption}>{formatMinuteOfDay(listWindow.end)}</Text>
          </View>
        )}
        <View
          onLayout={(event) => {
            listYRef.current = event.nativeEvent.layout.y;
          }}
        >
          {rows.map((day) => {
            const date = dateOf(day.dateKey);
            const monthMark =
              date.getMonth() !== lastMonth
                ? `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
                : null;
            lastMonth = date.getMonth();
            return (
              <View
                key={day.dateKey}
                onLayout={(event) => {
                  rowYsRef.current[day.dateKey] = event.nativeEvent.layout.y;
                }}
              >
                {monthMark && (
                  <Text style={[Type.caption, styles.monthMark]}>{monthMark}</Text>
                )}
                <HistoryRow
                  day={day}
                  listWindow={listWindow}
                  expanded={expandedKey === day.dateKey}
                  onToggle={() => toggleRow(day.dateKey)}
                />
                {expandedKey === day.dateKey && (
                  <ExpandedDay
                    day={day}
                    selection={selection}
                    onSelectSegment={(segment) =>
                      setSelection({ dateKey: day.dateKey, segment })
                    }
                  />
                )}
              </View>
            );
          })}
        </View>
        {recordedCount < HISTORY_DAYS && (
          <Text style={Type.caption}>
            {recordedCount === 0
              ? 'Your posture timeline appears here after your first tracked minutes.'
              : 'New days appear here after each day you track.'}
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function RangeControl({
  range,
  onChange,
}: {
  range: StatsRange;
  onChange: (range: StatsRange) => void;
}) {
  return (
    <View style={styles.rangeControl} accessibilityRole="tablist">
      {RANGE_OPTIONS.map((option) => {
        const selected = option.key === range;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="tab"
            accessibilityLabel={`Show statistics for ${option.label}`}
            accessibilityState={{ selected }}
            onPress={() => onChange(option.key)}
            style={({ pressed }) => [
              styles.rangeOption,
              selected && styles.rangeOptionSelected,
              pressed && !selected && { opacity: Layout.pressedOpacity },
            ]}
          >
            <Text
              style={[
                Type.caption,
                styles.rangeOptionText,
                selected && styles.rangeOptionTextSelected,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function StatTiles({
  totals,
  tipOpen,
  onToggleTip,
}: {
  totals: RangeTotals;
  tipOpen: boolean;
  onToggleTip: () => void;
}) {
  const noData = totals.uprightPercent === null;
  const value = (text: string) => (noData ? '—' : text);
  const tiles: { key: string; value: string; label: string; hero?: boolean }[] = [
    {
      key: 'upright',
      value: value(`${totals.uprightPercent}%`),
      label: 'Upright',
      hero: true,
    },
    {
      key: 'slouched',
      value: value(formatMinutes(totals.slouchedMinutes)),
      label: 'Slouched',
    },
    { key: 'worn', value: value(formatMinutes(totals.wornMinutes)), label: 'Worn' },
    { key: 'slouches', value: value(String(totals.slouchCount)), label: 'Slouches' },
  ];
  return (
    <View style={styles.tiles}>
      {tiles.map((tile) => (
        <View key={tile.key} style={styles.tile} accessible>
          <Text
            style={[
              styles.tileValue,
              tile.hero && !noData && styles.tileValueHero,
              noData && styles.tileValueEmpty,
            ]}
          >
            {tile.value}
          </Text>
          <Text style={[Type.caption, styles.tileLabel]}>{tile.label}</Text>
          {tile.hero && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="How is this calculated?"
              accessibilityState={{ expanded: tipOpen }}
              onPress={onToggleTip}
              hitSlop={8}
              style={({ pressed }) => [
                styles.tileInfo,
                pressed && { opacity: Layout.pressedOpacity },
              ]}
            >
              <MaterialIcons
                name="info-outline"
                size={20}
                color={Palette.secondarySlate}
              />
            </Pressable>
          )}
        </View>
      ))}
    </View>
  );
}

const BAR_TRACK_HEIGHT = 88;

function BarChart({
  days,
  expandedKey,
  onSelectDay,
}: {
  days: HistoryDay[];
  expandedKey: string | null;
  onSelectDay: (dateKey: string) => void;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const oldestFirst = useMemo(() => [...days].reverse(), [days]);
  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      // Today lives at the right edge — land there, not on the oldest day.
      onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      style={styles.barScroll}
    >
      <View style={styles.barRow}>
        {oldestFirst.map((day) => {
          const percent = hasData(day.stats)
            ? totalsOf([day]).uprightPercent
            : null;
          const dayNumber =
            day.daysAgo === 0 ? 'Now' : String(dateOf(day.dateKey).getDate());
          return (
            <View key={day.dateKey} style={styles.barColumn}>
              {percent === null ? (
                // Unrecorded days keep their slot: the month frame is
                // visible from day one (empty-state rule in the design log).
                <View style={styles.barTrack} />
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${dayLabel(day)}: ${percent} percent upright — show in history`}
                  accessibilityState={{ selected: day.dateKey === expandedKey }}
                  onPress={() => onSelectDay(day.dateKey)}
                  style={({ pressed }) => [
                    styles.barTrack,
                    day.dateKey === expandedKey && styles.barSelected,
                    pressed && { opacity: Layout.pressedOpacity },
                  ]}
                >
                  <View
                    style={[
                      styles.barFill,
                      {
                        height: `${Math.max(7, percent * 0.86)}%`,
                        backgroundColor: gradeColor(percent),
                      },
                    ]}
                  />
                </Pressable>
              )}
              <Text
                style={[
                  styles.barDay,
                  day.daysAgo === 0 && styles.barDayToday,
                ]}
              >
                {dayNumber}
              </Text>
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** Collapsed row — the whole row is the tap target, never its segments. */
function HistoryRow({
  day,
  listWindow,
  expanded,
  onToggle,
}: {
  day: HistoryDay;
  listWindow: MinuteWindow | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stats = hasData(day.stats) ? day.stats : null;
  const percent = stats ? totalsOf([day]).uprightPercent : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        percent === null
          ? `${dayLabel(day)}, no tracking yet`
          : `${dayLabel(day)}, ${percent} percent upright`
      }
      accessibilityState={{ expanded }}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.historyRow,
        pressed && { opacity: Layout.pressedOpacity },
      ]}
    >
      <Text
        style={[
          Type.caption,
          styles.historyDate,
          day.daysAgo === 0 && styles.historyDateToday,
        ]}
      >
        {day.daysAgo === 0 ? 'Today' : rowLabel(day)}
      </Text>
      <View
        style={styles.historyRibbon}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <PostureRibbon
          minuteFlags={stats ? stats.minuteFlags : null}
          window={listWindow}
        />
      </View>
      <MaterialIcons
        name={expanded ? 'expand-more' : 'chevron-right'}
        size={20}
        color={Palette.secondarySlate}
      />
    </Pressable>
  );
}

/**
 * The unfolded day: full-size auto-fit ribbon with tap-for-range, window
 * time labels, and the day's stat line — detail appears where the finger
 * is, no separate detail card (design log).
 */
function ExpandedDay({
  day,
  selection,
  onSelectSegment,
}: {
  day: HistoryDay;
  selection: Selection | null;
  onSelectSegment: (segment: RibbonSegment) => void;
}) {
  const stats = hasData(day.stats) ? day.stats : null;
  const window = stats ? wornWindow(stats.minuteFlags) : null;
  const percent = stats ? totalsOf([day]).uprightPercent : null;
  const ownSelection = selection?.dateKey === day.dateKey ? selection : null;
  return (
    <View style={styles.expandCard}>
      <View style={styles.expandHead}>
        <Text
          style={[
            styles.detailPercent,
            {
              color:
                percent === null
                  ? Palette.secondarySlate
                  : gradeTextColor(percent),
            },
          ]}
        >
          {percent === null ? '—' : `${percent}%`}
        </Text>
        <Text style={[Type.caption, styles.expandStats]}>
          {stats
            ? `Worn ${formatMinutes(stats.postureTicks)} · Slouched ${formatMinutes(
                Math.round(stats.slouchedSeconds / 60),
              )} · ${stats.slouchCount} ${stats.slouchCount === 1 ? 'slouch' : 'slouches'}`
            : 'No tracking yet today'}
        </Text>
      </View>
      <PostureRibbon
        minuteFlags={stats ? stats.minuteFlags : null}
        window={window}
        nowMinute={day.daysAgo === 0 ? minuteOfDayNow() : null}
        onSelectSegment={stats ? onSelectSegment : undefined}
        selectedSegment={ownSelection?.segment ?? null}
        style={styles.detailRibbon}
      />
      {window && (
        // Auto-fit means a short session fills the full width — these
        // labels carry the truth about the real span (design log).
        <View style={styles.ticksRow}>
          <Text style={Type.caption}>{formatMinuteOfDay(window.start)}</Text>
          <Text style={Type.caption}>
            {formatMinuteOfDay(Math.round((window.start + window.end) / 2))}
          </Text>
          <Text style={Type.caption}>{formatMinuteOfDay(window.end)}</Text>
        </View>
      )}
      <Text
        style={[Type.caption, ownSelection !== null && styles.readoutActive]}
        accessibilityLiveRegion="polite"
      >
        {ownSelection !== null
          ? selectionText(ownSelection.segment)
          : stats
            ? 'Tap the timeline to inspect a period'
            : 'Wear your device and connect to start tracking'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Layout.pagePadding,
    paddingTop: 0,
    gap: Layout.componentGap,
  },
  rangeControl: {
    flexDirection: 'row',
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    borderRadius: 14,
    padding: 3,
  },
  rangeOption: {
    flex: 1,
    borderRadius: 11,
    paddingVertical: 7,
    alignItems: 'center',
  },
  rangeOptionSelected: {
    backgroundColor: Palette.primaryCharcoal,
  },
  rangeOptionText: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  rangeOptionTextSelected: {
    color: Palette.cardSoftCream,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tile: {
    flexBasis: '48%',
    flexGrow: 1,
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  tileValue: {
    fontSize: 19,
    fontWeight: '700',
    lineHeight: 26,
    color: Palette.primaryCharcoal,
  },
  tileValueHero: {
    color: Palette.successGreen,
  },
  tileValueEmpty: {
    fontWeight: '400',
    color: Palette.secondarySlate,
  },
  tileLabel: {
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontSize: 10,
    lineHeight: 15,
  },
  tileInfo: {
    position: 'absolute',
    top: 8,
    right: 10,
  },
  tip: {
    backgroundColor: Palette.softAmber,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  tipText: {
    color: Palette.accentAmberText,
  },
  tipBold: {
    fontWeight: '700',
  },
  barScroll: {
    marginTop: 8,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 5,
    paddingHorizontal: 2,
  },
  barColumn: {
    alignItems: 'center',
    gap: 4,
  },
  barTrack: {
    width: 22,
    height: BAR_TRACK_HEIGHT,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    backgroundColor: Palette.backgroundWarmWhite,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  barSelected: {
    borderWidth: 2,
    borderColor: Palette.primaryCharcoal,
  },
  barFill: {
    width: '100%',
  },
  barDay: {
    fontSize: 9,
    lineHeight: 13,
    color: Palette.secondarySlate,
  },
  barDayToday: {
    fontWeight: '800',
    color: Palette.primaryCharcoal,
  },
  gradeLegend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  gradeLegendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  gradeDot: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  listLabel: {
    marginTop: Layout.sectionGap - Layout.componentGap,
    letterSpacing: 0.8,
    fontWeight: '700',
  },
  listWindowRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginLeft: 62,
    marginRight: 30,
    marginBottom: -6,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 4,
  },
  historyDate: {
    width: 52,
  },
  historyDateToday: {
    fontWeight: '700',
    color: Palette.primaryCharcoal,
  },
  historyRibbon: {
    flex: 1,
  },
  expandCard: {
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 6,
    gap: 4,
  },
  expandHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 10,
  },
  expandStats: {
    flexShrink: 1,
    textAlign: 'right',
  },
  detailPercent: {
    fontSize: 18,
    fontWeight: '700',
    lineHeight: 24,
  },
  detailRibbon: {
    marginTop: 6,
  },
  ticksRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 2,
  },
  readoutActive: {
    color: Palette.accentAmberText,
    fontWeight: '600',
  },
  monthMark: {
    marginTop: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontWeight: '700',
    fontSize: 10,
    lineHeight: 15,
  },
});
