import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BackHandler,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AppHeader } from '@/components/app-header';
import { BluetoothPulse } from '@/components/bluetooth-pulse';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
// Dev-only probe triggers (Phase 5) — sanctioned harness exception to the
// screens-use-hooks-only rule, like the Phase 1 harness before it.
import {
  DEV_PROBES_ENABLED,
  dumpReadableCharacteristics,
  monitorAllNotifiables,
} from '@/device/devHarness';
import type { DeviceOdometer, PostureStatus } from '@/device/types';
import type { UprightGoDevice } from '@/device/UprightGoDevice';
import { useDevice } from '@/hooks/useDevice';
import { usePosture } from '@/hooks/usePosture';
import { useSessionStats } from '@/hooks/useSessionStats';
import { useTilt } from '@/hooks/useTilt';
import { useVitals } from '@/hooks/useVitals';

const POSTURE_LINE: Record<PostureStatus, { label: string; color: string }> = {
  upright: { label: 'Upright', color: Palette.successGreen },
  slouching: { label: 'Slouching', color: Palette.warningOrange },
  unknown: {
    label: 'Calibrate to see live status',
    color: Palette.secondarySlate,
  },
};

type PendingAction = 'vibration' | 'pause' | 'disconnect' | 'forget' | null;

/**
 * Compact battery state beside the "Connected" label: glyph picked from the
 * 0–6 bar Material set (or the charging bolt), colored by charge level.
 * Color never carries the meaning alone — the percent text is right there.
 */
function BatteryIndicator({
  percent,
  charging,
}: {
  percent: number | null;
  charging: boolean | null;
}) {
  if (percent === null) {
    return null;
  }
  const name = (
    charging
      ? 'battery-charging-full'
      : percent >= 95
        ? 'battery-full'
        : `battery-${Math.min(6, Math.max(0, Math.round((percent / 100) * 6)))}-bar`
  ) as keyof typeof MaterialIcons.glyphMap;
  const color =
    percent <= 10
      ? Palette.errorRed
      : percent <= 25
        ? Palette.warningOrange
        : Palette.successGreen;
  return (
    <View
      style={styles.batteryChip}
      accessible
      accessibilityLabel={`Battery about ${percent} percent${charging ? ', charging' : ''}`}
    >
      <MaterialIcons name={name} size={18} color={color} />
      <Text style={Type.caption}>{percent}%</Text>
    </View>
  );
}

export default function ConnectedScreen() {
  const router = useRouter();
  const { device, connectionState, bluetoothOff, disconnect, forgetDevice } =
    useDevice();
  const posture = usePosture();
  const vitals = useVitals();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  // Seeded so the Status card renders from the start (per the mockup) —
  // arriving on this screen is itself the first "action".
  const [lastAction, setLastAction] = useState<{
    ok: boolean;
    text: string;
  }>({ ok: true, text: 'Connected' });
  // Test vibration + Status live behind this disclosure. A failed action
  // must never report into a collapsed section, so errors force it open.
  const [toolsOpen, setToolsOpen] = useState(false);
  useEffect(() => {
    if (!lastAction.ok) {
      setToolsOpen(true);
    }
  }, [lastAction]);

  // Deliberate disconnect lands on 'idle', an exhausted reconnect schedule
  // on 'disconnected' — either way this screen's subject is gone, so
  // collapse the stack back home (also pops the calibrate screen if it's
  // on top). 'permission_needed' is included because it outranks the
  // terminal device states in deriveConnectionState: if it surfaces here,
  // the device is already idle/disconnected underneath and the watcher
  // would otherwise never fire, stranding the screen.
  useEffect(() => {
    if (
      connectionState === 'idle' ||
      connectionState === 'disconnected' ||
      connectionState === 'permission_needed'
    ) {
      router.dismissTo('/');
    }
  }, [connectionState, router]);

  // Single site for the null-worn policy: only a definite aac3 'not worn'
  // hides posture/tilt or mutes the tick — null (not yet primed) fails
  // open, so a slow priming read doesn't blank a live status line.
  const deviceOff = vitals.worn === false;

  // Light haptic tick when the wearer flips from upright to slouching.
  // Strictly 'upright' → 'slouching': posture round-trips through
  // 'unknown' on every drop/reconnect and at mount, and those
  // re-emissions are not posture changes — ticking there would buzz for
  // radio blips. Muted while the device dangles (its tilt is not the
  // wearer's posture) and while this screen is covered (calibrate on top:
  // the user is repositioning on purpose, and a stray tick would blur
  // into calibrate's own success haptic).
  const focusedRef = useRef(true);
  const prevPostureRef = useRef<PostureStatus>(posture);
  useEffect(() => {
    const flipped =
      posture === 'slouching' && prevPostureRef.current === 'upright';
    prevPostureRef.current = posture;
    if (flipped && !deviceOff && focusedRef.current) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [posture, deviceOff]);

  // headerBackVisible/gestureEnabled in _layout.tsx cover iOS; the Android
  // hardware back button ignores both, so it needs its own block while
  // this screen is focused. Exits stay: Disconnect, or a connection drop.
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => true,
      );
      return () => {
        focusedRef.current = false;
        subscription.remove();
      };
    }, []),
  );

  // Dev-only monitor probe lifecycle; stopped on unmount so subscriptions
  // never outlive the screen (the link teardown would kill them anyway,
  // but a deliberate stop keeps the log readable).
  const monitorStopRef = useRef<(() => void) | null>(null);
  const [monitorProbeOn, setMonitorProbeOn] = useState(false);
  useEffect(
    () => () => {
      monitorStopRef.current?.();
      monitorStopRef.current = null;
    },
    [],
  );
  const toggleMonitorProbe = async () => {
    if (monitorStopRef.current) {
      monitorStopRef.current();
      monitorStopRef.current = null;
      setMonitorProbeOn(false);
      return;
    }
    if (!device) {
      return;
    }
    monitorStopRef.current = await monitorAllNotifiables(device.id);
    setMonitorProbeOn(true);
  };

  const handleToggleMode = async () => {
    if (!device) {
      return;
    }
    const toTracking = !vitals.paused;
    setPendingAction('pause');
    try {
      await device.setPaused(toTracking);
      setLastAction({
        ok: true,
        text: toTracking ? 'Tracking mode on' : 'Training mode on',
      });
    } catch {
      setLastAction({
        ok: false,
        text: 'Couldn’t switch the mode. Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleTestVibration = async () => {
    if (!device) {
      return;
    }
    setPendingAction('vibration');
    try {
      await device.testVibration();
      setLastAction({ ok: true, text: 'Vibration sent' });
    } catch {
      setLastAction({
        ok: false,
        text: 'Couldn’t send the vibration. Try again.',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleDisconnect = async () => {
    setPendingAction('disconnect');
    try {
      await disconnect();
      // Navigation happens via the connectionState watcher above.
    } catch {
      setPendingAction(null);
      setLastAction({ ok: false, text: 'Couldn’t disconnect. Try again.' });
    }
  };

  // Forget lives with Disconnect (Phase 9.1): dropping the remembered
  // device only makes sense while also ending the session — otherwise the
  // provider would just re-remember on the next action. Forget first: it is
  // the user's primary intent and must stick even if the disconnect fails.
  const handleForget = async () => {
    setPendingAction('forget');
    forgetDevice();
    try {
      await disconnect();
    } catch {
      setPendingAction(null);
      setLastAction({ ok: false, text: 'Couldn’t disconnect. Try again.' });
    }
  };

  const busy = pendingAction !== null;
  const actionsDisabled = busy || connectionState !== 'connected';
  const postureLine = POSTURE_LINE[posture];
  // The device auto-reconnects with backoff after an unexpected drop; this
  // screen just reports it. Exhausted attempts land on 'disconnected' and
  // the watcher above takes the user home.
  const reconnecting = connectionState === 'reconnecting';
  // 'unknown' now means genuinely uncalibrated hardware: the device layer
  // reads the stored calibration on connect (aab2/aab3) and adopts its
  // baseline, so an already-calibrated device gets a live status line with
  // no callout. Training mode dies on power cycle (aab2 → 0x00), which is
  // exactly when this callout should appear.
  const needsCalibration = !reconnecting && posture === 'unknown';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <AppHeader style={styles.appHeader} />
        <Card>
          <View style={styles.deviceRow}>
            <View
              style={[
                styles.stateBadge,
                reconnecting ? styles.stateBadgeWarn : styles.stateBadgeOk,
              ]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {reconnecting ? (
                <BluetoothPulse size={34} color={Palette.warningOrange} />
              ) : (
                <MaterialIcons
                  name="check-circle-outline"
                  size={38}
                  color={Palette.successGreen}
                />
              )}
            </View>
            <View style={styles.deviceSummary}>
              <View style={styles.stateLabelRow}>
                <Text
                  style={[
                    Type.body,
                    reconnecting
                      ? styles.reconnectingLabel
                      : styles.connectedLabel,
                  ]}
                >
                  {reconnecting ? 'Connection lost' : 'Connected'}
                </Text>
                {/* Hidden while reconnecting — the reading would be stale. */}
                {!reconnecting && (
                  <BatteryIndicator
                    percent={vitals.batteryPercent}
                    charging={vitals.charging}
                  />
                )}
              </View>
              <Text style={Type.display}>
                {device?.name ?? 'Posture device'}
              </Text>
              <Text style={Type.body}>Compatible device</Text>
            </View>
          </View>
          {reconnecting ? (
          <Text
            style={[Type.body, styles.reconnectingHint]}
            accessibilityLiveRegion="polite"
          >
            {bluetoothOff
              ? 'Bluetooth is off. Turn it on to reconnect.'
              : 'Trying to reconnect — keep the device nearby.'}
          </Text>
        ) : (
          // One grouped element so screen readers get "Posture: Upright" in
          // a single swipe; polite live region announces changes on Android.
          <View
            style={styles.postureRow}
            accessible
            accessibilityLiveRegion="polite"
          >
            <Text style={Type.body}>Posture: </Text>
            {deviceOff ? (
              // A dangling device still streams tilt; never present that
              // as the wearer's posture.
              <Text style={[Type.body, styles.postureValue]}>
                Device not worn
              </Text>
            ) : (
              <Text
                style={[Type.body, styles.postureValue, { color: postureLine.color }]}
              >
                {postureLine.label}
              </Text>
            )}
          </View>
        )}
        <TiltCaption visible={!reconnecting && !deviceOff} />
        <TodayStatsCaption visible={!reconnecting} />
        <PostureTimeline visible={!reconnecting} />
        {/* Training = slouch vibration on; Tracking = senses only. The
            device's own taxonomy — never "paused/resumed" in UI copy. */}
        {!reconnecting && vitals.paused !== null && (
          <View style={styles.modeRow} accessible>
            <View
              style={[
                styles.modePill,
                vitals.paused ? styles.modePillTracking : styles.modePillTraining,
              ]}
            >
              <MaterialIcons
                name={vitals.paused ? 'visibility' : 'notifications-active'}
                size={14}
                color={Palette.primaryCharcoal}
              />
              <Text style={[Type.caption, styles.modePillText]}>
                {vitals.paused ? 'Tracking mode' : 'Training mode'}
              </Text>
            </View>
            {vitals.paused && (
              <Text style={Type.caption}>
                Senses posture — no slouch vibrations
              </Text>
            )}
          </View>
        )}
      </Card>

      {needsCalibration && (
        <Card style={styles.calloutCard}>
          <Text style={Type.title}>Calibration needed</Text>
          <Text style={Type.body}>
            Sit or stand upright, then calibrate. This sets the reference
            for the live status and turns on Training mode (slouch
            vibrations). If the device was calibrated before, this simply
            resets it.
          </Text>
        </Card>
      )}

      <Text
        style={[Type.title, styles.sectionTitle]}
        accessibilityRole="header"
      >
        Device actions
      </Text>

      <ActionButton
        label="Calibrate posture"
        accessibilityLabel="Start calibration"
        variant="primary"
        icon={
          <Image
            source={require('../../assets/images/icon-calibrate.png')}
            style={styles.buttonIcon}
          />
        }
        disabled={actionsDisabled}
        onPress={() => router.navigate('/calibrate')}
      />
      <ActionButton
        label={
          pendingAction === 'pause'
            ? 'Switching…'
            : vitals.paused
              ? 'Switch to Training mode'
              : 'Switch to Tracking mode'
        }
        accessibilityLabel={
          vitals.paused
            ? 'Switch to Training mode, turns slouch vibrations on'
            : 'Switch to Tracking mode, senses posture without vibrating'
        }
        variant="outline"
        icon={
          <MaterialIcons
            name={vitals.paused ? 'notifications-active' : 'visibility'}
            size={20}
            color={Palette.accentAmber}
          />
        }
        loading={pendingAction === 'pause'}
        disabled={actionsDisabled}
        onPress={() => void handleToggleMode()}
      />

      {/* Occasional tools live behind a quiet disclosure so they don't cost
          vertical space; a failed action force-opens it so the error is
          never invisible. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More device tools"
        accessibilityState={{ expanded: toolsOpen }}
        onPress={() => setToolsOpen((open) => !open)}
        style={({ pressed }) => [
          styles.toolsToggle,
          pressed && styles.toolsTogglePressed,
        ]}
      >
        <MaterialIcons
          name={toolsOpen ? 'expand-less' : 'expand-more'}
          size={20}
          color={Palette.secondarySlate}
        />
        <Text style={Type.caption}>
          {toolsOpen ? 'Fewer tools' : 'More tools'}
        </Text>
      </Pressable>

      {toolsOpen && (
        <Animated.View entering={FadeIn.duration(150)} style={styles.toolsBody}>
          <ActionButton
            label={
              pendingAction === 'vibration'
                ? 'Sending vibration…'
                : 'Test vibration'
            }
            accessibilityLabel="Send vibration test"
            variant="outline"
            icon={
              <Image
                source={require('../../assets/images/icon-vibration.png')}
                style={styles.buttonIcon}
              />
            }
            loading={pendingAction === 'vibration'}
            disabled={actionsDisabled}
            onPress={() => void handleTestVibration()}
          />
          <Card>
            <View style={styles.statusRow}>
              <View
                style={styles.statusBadge}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <MaterialIcons
                  name="schedule"
                  size={28}
                  color={Palette.primaryCharcoal}
                />
              </View>
              <View style={styles.statusSummary}>
                <Text style={Type.title}>Status</Text>
                <Text
                  style={[Type.body, !lastAction.ok && styles.errorText]}
                  accessibilityLiveRegion="polite"
                >
                  Last action: {lastAction.text}
                </Text>
              </View>
            </View>
          </Card>
          {device && connectionState === 'connected' && (
            <DeviceInfoCard device={device} />
          )}
        </Animated.View>
      )}

      {__DEV__ && DEV_PROBES_ENABLED && (
        <>
          <ActionButton
            label="Dev: read probe (log snapshot)"
            accessibilityLabel="Log readable characteristics snapshot"
            variant="ghost"
            disabled={actionsDisabled || !device}
            onPress={() => {
              if (device) {
                void dumpReadableCharacteristics(device.id);
              }
            }}
          />
          <ActionButton
            label={
              monitorProbeOn
                ? 'Dev: stop monitor probe'
                : 'Dev: monitor probe (log all notifies)'
            }
            accessibilityLabel="Toggle notify monitor probe"
            variant="ghost"
            disabled={(!monitorProbeOn && actionsDisabled) || !device}
            onPress={() => void toggleMonitorProbe()}
          />
        </>
      )}

      <View style={styles.footer}>
        <ActionButton
          label={pendingAction === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          accessibilityLabel="Disconnect from device"
          variant="ghost"
          icon={
            <MaterialIcons
              name="power-settings-new"
              size={20}
              color={Palette.primaryCharcoal}
            />
          }
          loading={pendingAction === 'disconnect'}
          disabled={busy}
          onPress={() => void handleDisconnect()}
        />
        {/* Quiet caption action, About-link pattern: plain Disconnect keeps
            the device remembered for the next launch's auto-reconnect;
            this is the escape from that behavior. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Forget this device and disconnect"
          disabled={busy}
          onPress={() => void handleForget()}
          hitSlop={8}
          style={({ pressed }) => [
            styles.forgetLink,
            (pressed || busy) && styles.forgetLinkDim,
          ]}
        >
          <Text style={Type.caption}>
            {pendingAction === 'forget'
              ? 'Forgetting…'
              : 'Forget this device'}
          </Text>
        </Pressable>
        <Disclaimer />
      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/**
 * One line, not a gauge (Phase 6.5). Tilt is absolute, so it is meaningful
 * even before calibration. A leaf subscriber so the chatty tilt stream
 * re-renders only this caption per degree, never the whole screen.
 * Deliberately NOT a live region — it changes every degree and would drown
 * a screen reader.
 */
function TiltCaption({ visible }: { visible: boolean }) {
  const tilt = useTilt();
  if (!visible || tilt === null) {
    return null;
  }
  return (
    <Text style={[Type.caption, styles.tiltLine]}>
      Forward tilt: about {tilt}°
    </Text>
  );
}

/** Human form for the odometer's minute/second counts, e.g. "41 h 12 min". */
function formatDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/**
 * Lifetime device counters behind More tools (Phase 9.3). Read once when
 * the disclosure mounts this card — on-demand data, not a subscription.
 * Copy hedges with "about": both decodes are single-session/probable
 * until the hardware confirmation walk (docs/protocol.html).
 */
function DeviceInfoCard({ device }: { device: UprightGoDevice }) {
  const [odometer, setOdometer] = useState<DeviceOdometer | null>(null);
  useEffect(() => {
    let cancelled = false;
    device
      .readOdometer()
      .then((value) => {
        if (!cancelled) {
          setOdometer(value);
        }
      })
      .catch(() => {
        // Not connected (raced a drop) — render nothing; the card
        // disappears with the disclosure on the next state change anyway.
      });
    return () => {
      cancelled = true;
    };
  }, [device]);

  const lines = odometer
    ? [
        odometer.connectionCount !== null &&
          `Connected about ${odometer.connectionCount} times so far`,
        odometer.lifetimeMinutes !== null &&
          `About ${formatDuration(odometer.lifetimeMinutes)} of use in total`,
        odometer.uptimeSeconds !== null &&
          `On for ${formatDuration(Math.floor(odometer.uptimeSeconds / 60))} since last power-on`,
      ].filter((line): line is string => Boolean(line))
    : [];
  if (lines.length === 0) {
    return null;
  }
  return (
    <Card>
      <View style={styles.statusRow}>
        <View
          style={styles.statusBadge}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <MaterialIcons
            name="history"
            size={28}
            color={Palette.primaryCharcoal}
          />
        </View>
        <View style={styles.statusSummary} accessible>
          <Text style={Type.title}>This device</Text>
          {lines.map((line) => (
            <Text key={line} style={Type.caption}>
              {line}
            </Text>
          ))}
        </View>
      </View>
    </Card>
  );
}

function minuteOfDayNow(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * One hour of the timeline: 60 minute slots over an hour label. Memoized
 * on its flags substring so past hours skip re-rendering on every tick —
 * only the current hour's block changes.
 */
const TimelineHour = React.memo(function TimelineHour({
  flags,
  label,
}: {
  flags: string;
  label: string;
}) {
  return (
    <View style={styles.timelineHour}>
      <View style={styles.timelineRow}>
        {Array.from(flags, (flag, index) => (
          <View
            key={index}
            style={[
              styles.timelineSlot,
              flag === 'u' && styles.timelineUpright,
              flag === 's' && styles.timelineSlouched,
            ]}
          />
        ))}
      </View>
      <Text style={Type.caption}>{label}</Text>
    </View>
  );
});

/**
 * Full-day posture strip, horizontally scrollable by hour: one slot per
 * minute, upright = short green, slouched = tall red, no data (off,
 * unworn, gap) = faint dot. Height differences carry the meaning
 * alongside color (never color alone — docs/product.html); the legend
 * names them and the whole element reads as one day summary to screen
 * readers. History-only by design (the live "Posture:" line above is the
 * real-time cue); the provider backfills tick-cadence gaps. Starts at the
 * first recorded hour (earlier minutes are dots by physics — the device
 * keeps no history to backfill from) and follows "now" unless the user
 * has scrolled back.
 */
function PostureTimeline({ visible }: { visible: boolean }) {
  const stats = useSessionStats();
  const [nowMinute, setNowMinute] = useState(minuteOfDayNow);
  useEffect(() => {
    // Same-value updates bail out of re-rendering, so this only costs a
    // render once per minute boundary.
    const interval = setInterval(() => setNowMinute(minuteOfDayNow()), 10_000);
    return () => clearInterval(interval);
  }, []);
  const scrollRef = useRef<ScrollView>(null);
  // Follow the growing edge only while the user is already there —
  // yanking them mid-scrollback once a minute would be hostile.
  const atEndRef = useRef(true);

  const flags = stats.minuteFlags;
  let firstRecorded = -1;
  let uprightCount = 0;
  let slouchedCount = 0;
  for (let minute = 0; minute < flags.length; minute += 1) {
    if (flags[minute] === 'u' || flags[minute] === 's') {
      if (firstRecorded === -1) {
        firstRecorded = minute;
      }
      if (flags[minute] === 'u') {
        uprightCount += 1;
      } else {
        slouchedCount += 1;
      }
    }
  }
  if (!visible || firstRecorded === -1) {
    return null;
  }

  const endMinute = Math.max(nowMinute, flags.length - 1);
  const hours: { label: string; flags: string }[] = [];
  for (
    let hour = Math.floor(firstRecorded / 60);
    hour <= Math.floor(endMinute / 60);
    hour += 1
  ) {
    const hourStart = hour * 60;
    const hourEnd = Math.min(hourStart + 59, endMinute);
    let hourFlags = '';
    for (let minute = hourStart; minute <= hourEnd; minute += 1) {
      const flag = flags[minute];
      hourFlags += flag === 'u' || flag === 's' ? flag : '.';
    }
    hours.push({ label: `${String(hour).padStart(2, '0')}:00`, flags: hourFlags });
  }

  return (
    <View
      accessible
      accessibilityLabel={`Posture timeline for today: ${uprightCount} ${
        uprightCount === 1 ? 'minute' : 'minutes'
      } upright, ${slouchedCount} ${
        slouchedCount === 1 ? 'minute' : 'minutes'
      } slouching`}
      style={styles.timeline}
    >
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={100}
        onScroll={(event) => {
          const { contentOffset, layoutMeasurement, contentSize } =
            event.nativeEvent;
          atEndRef.current =
            contentOffset.x + layoutMeasurement.width >=
            contentSize.width - 24;
        }}
        onContentSizeChange={() => {
          if (atEndRef.current) {
            scrollRef.current?.scrollToEnd({ animated: false });
          }
        }}
      >
        <View style={styles.timelineHours}>
          {hours.map((hourBlock) => (
            <TimelineHour
              key={hourBlock.label}
              flags={hourBlock.flags}
              label={hourBlock.label}
            />
          ))}
        </View>
      </ScrollView>
      <Text style={Type.caption}>
        Today · green low: upright · red tall: slouching
      </Text>
    </View>
  );
}

/**
 * Today's aac9-accumulated stats in one caption line (Phase 9.2) — the
 * humble V1 surface, deliberately not a dashboard. Hidden until the first
 * worn minute lands, so a fresh day never opens with "0% upright". A leaf
 * subscriber like TiltCaption: ticks arrive every ~60 s, so re-render cost
 * is irrelevant, but screen-level state would still be the wrong altitude.
 * Not a live region — a once-a-minute announcement would be noise.
 */
function TodayStatsCaption({ visible }: { visible: boolean }) {
  const stats = useSessionStats();
  if (!visible || stats.postureTicks === 0) {
    return null;
  }
  // Time-based: measured slouched seconds over worn-connected time
  // (postureTicks ≈ worn minutes). Clamped — crediting granularity can
  // momentarily put the numerator ahead of the tick-based denominator.
  const uprightPercent = Math.min(
    100,
    Math.max(
      0,
      Math.round(
        (1 - stats.slouchedSeconds / (stats.postureTicks * 60)) * 100,
      ),
    ),
  );
  const time = formatDuration(stats.connectedTicks);
  const slouches =
    stats.slouchCount === 1 ? '1 slouch' : `${stats.slouchCount} slouches`;
  return (
    <Text
      style={[Type.caption, styles.tiltLine]}
      accessibilityLabel={`Today: ${uprightPercent} percent upright, ${slouches}, ${time} connected`}
    >
      Today: {uprightPercent}% upright · {slouches} · {time} connected
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Layout.pagePadding,
    gap: Layout.componentGap,
  },
  appHeader: {
    marginBottom: Layout.sectionGap - Layout.componentGap,
  },
  buttonIcon: {
    width: 20,
    height: 20,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
  },
  stateLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  batteryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  modeRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  modePillTraining: {
    backgroundColor: Palette.softGreen,
  },
  modePillTracking: {
    backgroundColor: Palette.softAmber,
  },
  modePillText: {
    color: Palette.primaryCharcoal,
  },
  toolsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
  },
  toolsTogglePressed: {
    opacity: Layout.pressedOpacity,
  },
  toolsBody: {
    gap: Layout.componentGap,
  },
  stateBadge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stateBadgeOk: {
    backgroundColor: Palette.softGreen,
  },
  stateBadgeWarn: {
    backgroundColor: Palette.softAmber,
  },
  deviceSummary: {
    flex: 1,
    gap: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
  },
  statusBadge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusSummary: {
    flex: 1,
    gap: 2,
  },
  connectedLabel: {
    fontWeight: '700',
    color: Palette.successGreen,
  },
  reconnectingLabel: {
    fontWeight: '700',
    color: Palette.warningOrange,
  },
  postureRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 8,
  },
  reconnectingHint: {
    marginTop: 8,
  },
  tiltLine: {
    marginTop: 4,
  },
  timeline: {
    marginTop: 8,
    gap: 4,
  },
  timelineHours: {
    flexDirection: 'row',
    // Matches the intra-hour slot gap so hour boundaries are seamless.
    gap: 1,
  },
  timelineHour: {
    gap: 2,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    height: 16,
  },
  timelineSlot: {
    width: 3,
    height: 3,
    borderRadius: 1,
    backgroundColor: Palette.borderDivider,
  },
  timelineUpright: {
    height: 8,
    backgroundColor: Palette.successGreen,
  },
  timelineSlouched: {
    height: 16,
    backgroundColor: Palette.errorRed,
  },
  calloutCard: {
    backgroundColor: Palette.softAmber,
    borderColor: Palette.accentAmber,
  },
  postureValue: {
    fontWeight: '700',
  },
  sectionTitle: {
    marginTop: Layout.sectionGap - Layout.componentGap,
  },
  errorText: {
    color: Palette.errorRed,
  },
  footer: {
    marginTop: Layout.sectionGap - Layout.componentGap,
    gap: Layout.componentGap,
  },
  forgetLink: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  forgetLinkDim: {
    opacity: Layout.pressedOpacity,
  },
});
