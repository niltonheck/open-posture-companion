/**
 * Deterministic fixture for a demo session's "today": several hours of
 * mostly-upright wear with periodic slouch clusters, so the connected
 * screen's stats caption and timeline are rich the moment a demo device
 * connects (App Store review / screenshots). Never persisted — the demo
 * session holds it in memory only (see useSessionStats).
 */

import { type DayStats } from './sessionStats';

/**
 * Seeded PRNG (mulberry32) instead of Math.random: the same time of day
 * always produces the same day, so screenshots are reproducible run to run.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Average seconds of measured slouch behind one slouched minute flag. */
const SLOUCHED_SECONDS_PER_MINUTE = 50;

/**
 * Counters derived from the flags so every number on screen tells the
 * same story — shared by today's fixture and the history fixtures.
 */
function dayStatsFromMinuteFlags(minuteFlags: string): DayStats {
  let uprightMinutes = 0;
  let slouchedMinutes = 0;
  let slouchRuns = 0;
  for (let i = 0; i < minuteFlags.length; i += 1) {
    if (minuteFlags[i] === 'u') {
      uprightMinutes += 1;
    } else if (minuteFlags[i] === 's') {
      slouchedMinutes += 1;
      if (minuteFlags[i - 1] !== 's') {
        slouchRuns += 1;
      }
    }
  }
  const postureTicks = uprightMinutes + slouchedMinutes;
  return {
    connectedTicks: postureTicks,
    postureTicks,
    slouchedTicks: slouchedMinutes,
    slouchCount: slouchRuns,
    slouchedSeconds: slouchedMinutes * SLOUCHED_SECONDS_PER_MINUTE,
    minuteFlags,
  };
}

export function buildDemoDayStats(now: Date = new Date()): DayStats {
  const nowMinute = now.getHours() * 60 + now.getMinutes();
  // Normally a 9:00 workday start; a morning demo still gets ≥3 h of
  // history so the stats caption never opens on near-zero numbers.
  const startMinute = Math.max(0, Math.min(9 * 60, nowMinute - 180));
  const random = mulberry32(0x5eed);

  // One honest "device off over lunch" gap — but only when it fits wholly
  // outside the final 30 minutes: the timeline renders a ±30 min window
  // around now, and the marquee screenshot needs that strip populated.
  const gapStart = 12 * 60 + 28;
  const gapEnd = gapStart + 16;
  const gapApplies = gapStart >= startMinute && gapEnd <= nowMinute - 30;

  const flags: string[] = new Array(startMinute).fill('.');
  let nextClusterAt = startMinute + 12 + Math.floor(random() * 15);
  let clusterRemaining = 0;
  for (let minute = startMinute; minute < nowMinute; minute += 1) {
    if (gapApplies && minute >= gapStart && minute < gapEnd) {
      flags.push('.');
      continue;
    }
    if (minute >= nextClusterAt && clusterRemaining === 0) {
      clusterRemaining = 2 + Math.floor(random() * 3);
    }
    if (clusterRemaining > 0) {
      clusterRemaining -= 1;
      if (clusterRemaining === 0) {
        nextClusterAt = minute + 20 + Math.floor(random() * 16);
      }
      flags.push('s');
    } else {
      flags.push('u');
    }
  }

  // ~90% upright over the connected hours.
  return dayStatsFromMinuteFlags(flags.join(''));
}

/**
 * Statistics-screen fixture: one full past day, keyed by how many days ago
 * it falls. Deterministic per offset, and shaped to tell a story on the
 * 30-day chart — older days slouch more, so the demo shows visible
 * improvement toward today. A few offsets return null (device left in the
 * drawer): the sparse-state rendering is part of what review screenshots
 * should show. In-memory only, like today's fixture.
 */
export function buildDemoHistoryDay(daysAgo: number): DayStats | null {
  const random = mulberry32(0x5eed ^ (daysAgo * 7919));
  // Two rest days across the window, deterministically placed.
  if (daysAgo > 1 && random() < 0.07) {
    return null;
  }
  // 0 = newest history day … 1 = oldest; drives the improvement trend.
  const age = Math.min(1, Math.max(0, (daysAgo - 1) / 28));

  const sessions: [number, number][] = [];
  const morningStart = 8 * 60 + 20 + Math.floor(random() * 50);
  const morningEnd = 12 * 60 + Math.floor(random() * 40);
  sessions.push([morningStart, morningEnd]);
  if (random() > 0.1) {
    const afternoonStart = 13 * 60 + 15 + Math.floor(random() * 50);
    const afternoonEnd = 17 * 60 + 20 + Math.floor(random() * 70);
    sessions.push([afternoonStart, afternoonEnd]);
  }

  const flags: string[] = new Array(1440).fill('.');
  for (const [sessionStart, sessionEnd] of sessions) {
    // Same cluster walk as today's fixture, with age-scaled cadence:
    // ~90% upright on recent days down to ~72% on the oldest.
    let nextClusterAt =
      sessionStart + 6 + Math.floor(random() * 12);
    let clusterRemaining = 0;
    for (let minute = sessionStart; minute < sessionEnd; minute += 1) {
      if (minute >= nextClusterAt && clusterRemaining === 0) {
        clusterRemaining =
          2 + Math.floor(random() * 3) + (random() < age * 0.5 ? 2 : 0);
      }
      if (clusterRemaining > 0) {
        clusterRemaining -= 1;
        if (clusterRemaining === 0) {
          nextClusterAt =
            minute +
            Math.round(24 - 17 * age) +
            Math.floor(random() * (16 - 8 * age));
        }
        flags[minute] = 's';
      } else {
        flags[minute] = 'u';
      }
    }
  }
  return dayStatsFromMinuteFlags(flags.join(''));
}
