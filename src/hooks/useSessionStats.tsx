/**
 * App-side accumulation of the device's per-minute aac9 telemetry
 * (Phase 9.2): today's posture stats, persisted per local day and shared
 * app-wide. Lives at the provider level so minutes keep counting no matter
 * which screen is open while connected.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';

import { DEMO_DEVICE_ID } from '@/device/demoTransport';
import { buildDemoDayStats } from '@/storage/demoDayStats';
import {
  loadDayStats,
  localDateKey,
  saveDayStats,
  setMinuteFlag,
  type DayStats,
} from '@/storage/sessionStats';

import { useDevice } from './useDevice';

/**
 * A tick's minute is flagged slouched when its interval accumulated at
 * least this much measured slouch time (ties the timeline to the same
 * sensitivity as the slouch-event dwell) OR the tick-time bit-7 sample
 * was set — bit 7 covers a slouch still in progress whose time hasn't
 * been credited yet.
 */
const SLOUCHED_MINUTE_MIN_SECONDS = 5;

interface DayRecord {
  key: string;
  stats: DayStats;
  /** In-memory demo-session day (fixture-seeded, never persisted). */
  demo: boolean;
}

/**
 * Today's record — re-loads from storage when the calendar day moves. A
 * demo session (simulated device, App Store review) runs on a generated
 * in-memory fixture instead: entering demo swaps to the fixture, leaving
 * it reloads the untouched real day from storage.
 */
function currentDay(previous: DayRecord | undefined, demo: boolean): DayRecord {
  const key = localDateKey();
  if (previous && previous.key === key && previous.demo === demo) {
    return previous;
  }
  if (demo) {
    return { key, stats: buildDemoDayStats(), demo: true };
  }
  return { key, stats: loadDayStats(key), demo: false };
}

const SessionStatsContext = createContext<DayStats | null>(null);

export function SessionStatsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { device } = useDevice();
  // Known benign staleness: after disconnecting from the demo device the
  // context keeps serving demo stats until a real device connects or the
  // app relaunches — nothing outside /connected reads these today.
  const demoActive = device?.id === DEMO_DEVICE_ID;
  // Continues today's tally across app restarts (one sync kv-store read).
  const [day, setDay] = useState<DayRecord>(() => currentDay(undefined, false));
  // Slouched seconds credited since the last tick — read and reset
  // outside the setDay updater (updaters must stay pure) to classify the
  // tick's minute for the timeline.
  const intervalSlouchSecondsRef = useRef(0);

  // Entering/leaving a demo session swaps the whole day record (see
  // currentDay); the real day's persisted record is never touched by it.
  useEffect(() => {
    setDay((previous) => currentDay(previous, demoActive));
  }, [demoActive]);

  useEffect(() => {
    if (!device) {
      return;
    }
    const demo = device.id === DEMO_DEVICE_ID;
    // Worn gates what counts: a dangling device streams tilt that is not
    // the wearer's posture. The tick carries worn (stamped by the device
    // layer); null fails open — same policy as the connected screen — so
    // a slow priming read doesn't drop real minutes.
    const unsubscribeTicks = device.onTelemetryTick((tick) => {
      const worn = tick.worn !== false;
      const intervalSlouchSeconds = intervalSlouchSecondsRef.current;
      intervalSlouchSecondsRef.current = 0;
      const flag = !worn
        ? '.'
        : tick.slouched ||
            intervalSlouchSeconds >= SLOUCHED_MINUTE_MIN_SECONDS
          ? 's'
          : 'u';
      const minuteOfDay = (() => {
        const now = new Date();
        return now.getHours() * 60 + now.getMinutes();
      })();
      // Functional update: rollover re-derives the base from storage, so
      // a day change (midnight, timezone travel) never clobbers a day
      // that already has persisted ticks.
      setDay((previous) => {
        const base = currentDay(previous, demo);
        let minuteFlags = setMinuteFlag(
          base.stats.minuteFlags,
          minuteOfDay,
          flag,
        );
        // Tick cadence (~60 s) isn't aligned to wall minutes, so a
        // drifting tick can skip a minute slot entirely. This tick's
        // interval spanned the previous minute too — when that slot is
        // empty but the one before it has data (same session, pure
        // drift), credit it with this tick's flag; a ≥2-minute hole is a
        // real gap and stays honest dots.
        const previousMinute = minuteOfDay - 1;
        if (
          flag !== '.' &&
          previousMinute >= 1 &&
          (minuteFlags[previousMinute] ?? '.') === '.' &&
          (minuteFlags[previousMinute - 1] === 'u' ||
            minuteFlags[previousMinute - 1] === 's')
        ) {
          minuteFlags = setMinuteFlag(minuteFlags, previousMinute, flag);
        }
        return {
          ...base,
          stats: {
            ...base.stats,
            connectedTicks: base.stats.connectedTicks + 1,
            postureTicks: base.stats.postureTicks + (worn ? 1 : 0),
            slouchedTicks:
              base.stats.slouchedTicks + (worn && tick.slouched ? 1 : 0),
            minuteFlags,
          },
        };
      });
    });
    // Slouch count comes from the app-side sustained-slouch event, NOT
    // tick.excursions: the device's counter is Training-mode-only
    // (hardware-corrected 2026-07-04), and one definition must hold in
    // both modes. Worn- and dwell-gating live in the device layer.
    const unsubscribeSlouches = device.onSlouchEvent(() => {
      setDay((previous) => {
        const base = currentDay(previous, demo);
        return {
          ...base,
          stats: {
            ...base.stats,
            slouchCount: base.stats.slouchCount + 1,
          },
        };
      });
    });
    // Measured slouched time — the upright %'s numerator. Credits arrive
    // at slouch end and per-minute during long slouches; sub-second
    // remainders are kept in the stored seconds via rounding per credit
    // (drift is bounded by ±0.5 s per slouch, irrelevant at day scale).
    const unsubscribeSlouchTime = device.onSlouchTime((milliseconds) => {
      const seconds = Math.round(milliseconds / 1000);
      if (seconds === 0) {
        return;
      }
      intervalSlouchSecondsRef.current += seconds;
      setDay((previous) => {
        const base = currentDay(previous, demo);
        return {
          ...base,
          stats: {
            ...base.stats,
            slouchedSeconds: base.stats.slouchedSeconds + seconds,
          },
        };
      });
    });
    return () => {
      unsubscribeTicks();
      unsubscribeSlouches();
      unsubscribeSlouchTime();
    };
  }, [device]);

  // Persist outside the updater (updaters must stay side-effect free); the
  // write is idempotent, so a double-invoked effect costs nothing. A demo
  // day stays in memory only — simulated data must never reach the real
  // session-stats keys.
  useEffect(() => {
    if (!day.demo) {
      saveDayStats(day.key, day.stats);
    }
  }, [day]);

  // Without ticks nothing re-renders past midnight, and yesterday's totals
  // would present as "Today" until the next tick (up to a minute connected,
  // indefinitely otherwise). A timer pinned to the next local midnight
  // keeps the display honest; the tick-time rollover stays the fallback
  // for timers iOS defers in the background.
  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );
    const timer = setTimeout(
      () => setDay((previous) => currentDay(previous, demoActive)),
      nextMidnight.getTime() - now.getTime() + 1_000,
    );
    return () => clearTimeout(timer);
  }, [day.key, demoActive]);

  return (
    <SessionStatsContext.Provider value={day.stats}>
      {children}
    </SessionStatsContext.Provider>
  );
}

/** Today's accumulated posture stats; zeros until the first tick ever. */
export function useSessionStats(): DayStats {
  const stats = useContext(SessionStatsContext);
  if (!stats) {
    throw new Error('useSessionStats must be used within <SessionStatsProvider>');
  }
  return stats;
}
