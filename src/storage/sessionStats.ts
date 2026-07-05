/**
 * Per-day posture stats accumulated from aac9 telemetry ticks (Phase 9.2).
 * The device keeps no retrievable history (TODO 5.9), so the app counts
 * ticks while connected and persists them per local calendar day — one
 * small JSON value per day, no accounts, nothing leaves the phone.
 * Storage policy (sync, swallow failures) lives in kv.ts.
 */

import { readJson, writeJson } from './kv';

const KEY_PREFIX = 'session-stats.v1:';

export interface DayStats {
  /** aac9 ticks received while connected — each is roughly one minute. */
  connectedTicks: number;
  /** Ticks that counted toward posture (device worn at tick time). */
  postureTicks: number;
  /**
   * Subset of postureTicks where the wearer was past the slouch threshold
   * (aac9 bit 7 point sample). Superseded by slouchedSeconds for the
   * upright % display; kept accumulating as a cross-check for the two
   * methods during daily use (feeds the 9.4 judgement).
   */
  slouchedTicks: number;
  /**
   * Sustained slouches (app-side dwell events — SLOUCH_EVENT_DWELL_MS,
   * both modes) — NOT aac9 excursions, whose counter is
   * Training-mode-only on hardware.
   */
  slouchCount: number;
  /**
   * Measured time past the slouch threshold while worn (onSlouchTime
   * credits). Numerator of the upright %; postureTicks × 60 approximates
   * the denominator.
   */
  slouchedSeconds: number;
  /**
   * Per-minute posture timeline: index = minute of the local day,
   * 'u' upright / 's' slouched / '.' no data (not connected or not worn).
   * Written once per tick; at most 1440 chars, trailing gaps unwritten.
   */
  minuteFlags: string;
}

export const ZERO_DAY_STATS: DayStats = {
  connectedTicks: 0,
  postureTicks: 0,
  slouchedTicks: 0,
  slouchCount: 0,
  slouchedSeconds: 0,
  minuteFlags: '',
};

/** Immutable single-char write into the minute timeline, gap-padded. */
export function setMinuteFlag(
  flags: string,
  minuteOfDay: number,
  flag: 'u' | 's' | '.',
): string {
  if (minuteOfDay < 0 || minuteOfDay >= 1440) {
    return flags;
  }
  const padded = flags.padEnd(minuteOfDay + 1, '.');
  return padded.slice(0, minuteOfDay) + flag + padded.slice(minuteOfDay + 1);
}

/** Single source of truth for the stored shape. */
const DAY_STATS_FIELDS = Object.keys(ZERO_DAY_STATS) as (keyof DayStats)[];

/** Local calendar day, e.g. "2026-07-04" — stats roll over at midnight. */
export function localDateKey(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function loadDayStats(dateKey: string): DayStats {
  return (
    readJson(KEY_PREFIX + dateKey, (parsed) => {
      if (typeof parsed !== 'object' || parsed === null) {
        return null;
      }
      const record = parsed as Record<string, unknown>;
      const stats: DayStats = { ...ZERO_DAY_STATS };
      for (const field of DAY_STATS_FIELDS) {
        const value = record[field];
        if (value === undefined) {
          continue; // Written before the field existed — keep the zero
          //           value instead of resetting the whole day.
        }
        if (typeof value !== typeof ZERO_DAY_STATS[field]) {
          return null;
        }
        (stats as unknown as Record<string, unknown>)[field] = value;
      }
      return stats;
    }) ?? ZERO_DAY_STATS
  );
}

export function saveDayStats(dateKey: string, stats: DayStats): void {
  writeJson(KEY_PREFIX + dateKey, stats);
}
