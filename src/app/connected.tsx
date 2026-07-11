import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

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
import {
  DEMO_DEVICE_ID,
  setDemoPostureOverride,
  type DemoPostureOverride,
} from '@/device/demoTransport';
import {
  deviceIdSuffix,
  type DeviceOdometer,
  type PostureStatus,
} from '@/device/types';
import type { UprightGoDevice } from '@/device/UprightGoDevice';
import { useDevice } from '@/hooks/useDevice';
import { usePosture } from '@/hooks/usePosture';
import { useSessionStats } from '@/hooks/useSessionStats';
import { useTilt } from '@/hooks/useTilt';
import { useVitals } from '@/hooks/useVitals';

// 'unknown' = genuinely uncalibrated hardware (post power-cycle; the
// onboarding flow catches new connects, so this shows only after a skip
// or an auto-reconnect to a power-cycled device). Deliberately a quiet
// line, not a callout — 2026-07-11 review demoted the amber card.
const POSTURE_LINE: Record<PostureStatus, { label: string; color: string }> = {
  upright: { label: 'Upright', color: Palette.successGreen },
  slouching: { label: 'Slouching', color: Palette.warningOrange },
  unknown: {
    label: 'Calibrate to see live posture',
    color: Palette.secondarySlate,
  },
};

type PendingAction = 'vibration' | 'pause' | 'disconnect' | 'forget' | null;

/**
 * Compact battery state beside the "Connected" label: glyph picked from the
 * 0–6 bar Material set (or the charging bolt); green while charging,
 * otherwise charcoal above 20%, amber at 20% and below, red below 10%
 * (product owner's spec). Color never carries the meaning alone — the
 * percent text is right there.
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
  const color = charging
    ? Palette.successGreen
    : percent < 10
      ? Palette.errorRed
      : percent <= 20
        ? Palette.accentAmber
        : Palette.primaryCharcoal;
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
  const insets = useSafeAreaInsets();
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
  // "This device" details expansion (odometer lines + dev demo steering).
  // Errors don't need to force anything open anymore — the status line
  // under the actions card is always visible (Option 1 redesign).
  const [infoOpen, setInfoOpen] = useState(false);
  // Mirrors the transport's screenshot-steering override (write-only API);
  // null = the 60 s auto cycle, matching a fresh demo connection.
  const [demoOverride, setDemoOverride] = useState<DemoPostureOverride>(null);

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

  return (
    // Bottom edge released on scrollable screens (2026-07-11): with it, the
    // scroll surface clips ~34 pt above the screen bottom and the scroll
    // feels walled-in. Content flows under the home indicator instead, and
    // the inset moves into the content's bottom padding so the last element
    // still clears the indicator at rest.
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Layout.pagePadding + insets.bottom },
        ]}
      >
        <AppHeader style={styles.appHeader} />
        {/* Live-only main card (Option 3, 2026-07-11 redesign): identity is
            a compact caption row — the name is stable chrome, not the hero
            — and the live posture takes the display slot. Today's numbers
            and the timeline live in the Statistics card below. */}
        <Card>
          <View
            style={styles.identityRow}
            accessible
            accessibilityLabel={`${device?.name ?? 'Posture device'}${
              device ? ' ' + deviceIdSuffix(device.id) : ''
            }, ${reconnecting ? 'connection lost' : 'connected'}`}
          >
            <View
              style={[
                styles.identityBadge,
                reconnecting ? styles.stateBadgeWarn : styles.stateBadgeOk,
              ]}
            >
              {reconnecting ? (
                <BluetoothPulse size={20} color={Palette.warningOrange} />
              ) : (
                <MaterialIcons
                  name="check-circle-outline"
                  size={20}
                  color={Palette.successGreen}
                />
              )}
            </View>
            {/* Same id suffix as the scan rows — the only way to tell
                identically-named units apart. */}
            <Text style={[Type.body, styles.identityName]} numberOfLines={1}>
              {device?.name ?? 'Posture device'}
              {device ? ` · ${deviceIdSuffix(device.id)}` : ''}
            </Text>
            {/* Hidden while reconnecting — the reading would be stale. */}
            {!reconnecting && (
              <BatteryIndicator
                percent={vitals.batteryPercent}
                charging={vitals.charging}
              />
            )}
          </View>
          {reconnecting ? (
            <>
              <Text style={[Type.title, styles.reconnectingLabel]}>
                Connection lost
              </Text>
              <Text
                style={[Type.body, styles.reconnectingHint]}
                accessibilityLiveRegion="polite"
              >
                {bluetoothOff
                  ? 'Bluetooth is off. Turn it on to reconnect.'
                  : 'Trying to reconnect — keep the device nearby.'}
              </Text>
            </>
          ) : (
            // One grouped element so screen readers get "Posture: Upright"
            // in a single swipe; polite live region announces changes on
            // Android. The hero size is reserved for a live value — the
            // not-worn and uncalibrated states render quiet instead.
            <View
              style={styles.heroBlock}
              accessible
              accessibilityLabel={`Posture: ${
                deviceOff ? 'device not worn' : postureLine.label
              }`}
              accessibilityLiveRegion="polite"
            >
              {deviceOff ? (
                // A dangling device still streams tilt; never present that
                // as the wearer's posture.
                <Text style={[Type.title, styles.heroQuiet]}>
                  Device not worn
                </Text>
              ) : posture === 'unknown' ? (
                <Text style={[Type.title, styles.heroQuiet]}>
                  {postureLine.label}
                </Text>
              ) : (
                <Text style={[styles.postureHero, { color: postureLine.color }]}>
                  {postureLine.label}
                </Text>
              )}
            </View>
          )}
        <TiltCaption visible={!reconnecting && !deviceOff} />
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
            {/* Training's promise only holds when armed — an uncalibrated
                device (posture 'unknown') doesn't vibrate. */}
            {!vitals.paused && posture !== 'unknown' && (
              <Text style={Type.caption}>Vibrates when you slouch</Text>
            )}
          </View>
        )}
      </Card>

      {/* History lives on its own screen (specs/design_decisions.md →
          "Statistics & history"); this lead-in badge card is the entry —
          promoted from a caption link in the 2026-07-11 review. Local
          data, so it stays useful even while reconnecting. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open statistics"
        onPress={() => router.navigate('/stats')}
        style={({ pressed }) => pressed && { opacity: Layout.pressedOpacity }}
      >
        <Card>
          <View style={styles.statusRow}>
            <View
              style={styles.statusBadge}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <MaterialIcons
                name="insights"
                size={28}
                color={Palette.primaryCharcoal}
              />
            </View>
            <View style={styles.statusSummary}>
              <Text style={Type.title}>Statistics</Text>
              <StatsCardCaption />
            </View>
            <MaterialIcons
              name="chevron-right"
              size={20}
              color={Palette.secondarySlate}
            />
          </View>
          {/* Live preview (Option 3 redesign): today's strip belongs with
              the numbers it summarizes — one home for history, and a
              better invitation to the stats screen than a static caption. */}
          <PostureTimeline visible />
        </Card>
      </Pressable>

      <Text
        style={[Type.title, styles.sectionTitle]}
        accessibilityRole="header"
      >
        Device actions
      </Text>

      {/* Option 1 (2026-07-11 actions redesign): every action is a compact
          row in one card — all visible without scrolling. Chevrons only
          where a row navigates or expands; the old "More tools" disclosure
          is gone, and errors report into the always-visible status line
          under the card. Labels stay frozen while an action runs (the
          spinner replaces the icon) — async work must not resize a row. */}
      <Card style={styles.actionsCard}>
        <ActionRow
          icon={
            <Image
              source={require('../../assets/images/icon-calibrate.png')}
              style={styles.buttonIcon}
            />
          }
          label="Calibrate posture"
          accessibilityLabel="Start calibration"
          disabled={actionsDisabled}
          trailing={
            <MaterialIcons
              name="chevron-right"
              size={20}
              color={Palette.secondarySlate}
            />
          }
          onPress={() => router.navigate('/calibrate')}
        />
        <View style={styles.actionDivider} />
        <ActionRow
          icon={
            <MaterialIcons
              name={vitals.paused ? 'notifications-active' : 'visibility'}
              size={20}
              color={Palette.primaryCharcoal}
            />
          }
          label={
            vitals.paused ? 'Switch to Training mode' : 'Switch to Tracking mode'
          }
          sublabel={
            vitals.paused
              ? 'Turns slouch vibrations on'
              : 'Senses posture — no slouch vibrations'
          }
          accessibilityLabel={
            vitals.paused
              ? 'Switch to Training mode, turns slouch vibrations on'
              : 'Switch to Tracking mode, senses posture without vibrating'
          }
          loading={pendingAction === 'pause'}
          disabled={actionsDisabled}
          onPress={() => void handleToggleMode()}
        />
        <View style={styles.actionDivider} />
        <ActionRow
          icon={
            <Image
              source={require('../../assets/images/icon-vibration.png')}
              style={styles.buttonIcon}
            />
          }
          label="Test vibration"
          accessibilityLabel="Send vibration test"
          loading={pendingAction === 'vibration'}
          disabled={actionsDisabled}
          onPress={() => void handleTestVibration()}
        />
        <View style={styles.actionDivider} />
        <ActionRow
          icon={
            <MaterialIcons
              name="history"
              size={20}
              color={Palette.primaryCharcoal}
            />
          }
          label="This device"
          accessibilityLabel="Device details"
          expanded={infoOpen}
          disabled={connectionState !== 'connected'}
          trailing={
            <MaterialIcons
              name={infoOpen ? 'expand-less' : 'expand-more'}
              size={20}
              color={Palette.secondarySlate}
            />
          }
          onPress={() => setInfoOpen((open) => !open)}
        />
        {infoOpen && device && connectionState === 'connected' && (
          <Animated.View
            entering={FadeIn.duration(150)}
            style={styles.deviceInfoBody}
          >
            <DeviceInfoLines device={device} />
            {/* Screenshot steering for the simulated device: pin a posture
                instead of the 60 s auto-cycle. Dev builds only, and nested
                behind this collapsed-by-default expansion so the control
                can never leak into a marketing screenshot. A three-state
                choice, so a compact segmented control — left-aligned with
                the info lines, not a stack of centered buttons. */}
            {__DEV__ && device.id === DEMO_DEVICE_ID && (
              <View style={styles.demoSteering}>
                <Text style={Type.caption}>Demo posture</Text>
                <View style={styles.demoSegments}>
                  {(
                    [
                      { value: 'slouch', label: 'Slouch' },
                      { value: 'upright', label: 'Upright' },
                      { value: null, label: 'Auto cycle' },
                    ] as { value: DemoPostureOverride; label: string }[]
                  ).map((option) => {
                    const selected = demoOverride === option.value;
                    return (
                      <Pressable
                        key={option.label}
                        accessibilityRole="button"
                        accessibilityLabel={`Demo posture: ${option.label}`}
                        accessibilityState={{ selected }}
                        onPress={() => {
                          setDemoPostureOverride(option.value);
                          setDemoOverride(option.value);
                        }}
                        style={({ pressed }) => [
                          styles.demoSegment,
                          selected && styles.demoSegmentOn,
                          pressed && !selected && {
                            opacity: Layout.pressedOpacity,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            Type.caption,
                            styles.demoSegmentText,
                            selected && styles.demoSegmentTextOn,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
          </Animated.View>
        )}
        <View style={styles.actionDivider} />
        <ActionRow
          destructive
          icon={
            <MaterialIcons
              name="power-settings-new"
              size={20}
              color={Palette.errorRed}
            />
          }
          label="Disconnect"
          accessibilityLabel="Disconnect from device"
          loading={pendingAction === 'disconnect'}
          disabled={busy}
          onPress={() => void handleDisconnect()}
        />
      </Card>
      <Text
        style={[Type.caption, styles.statusLine, !lastAction.ok && styles.errorText]}
        accessibilityLiveRegion="polite"
      >
        Last action: {lastAction.text}
      </Text>

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
 * One compact row of the actions card (Option 1, 2026-07-11 redesign) —
 * icon bubble, label (+ optional sublabel), optional trailing glyph for
 * rows that navigate or expand. While loading, the spinner replaces the
 * icon and the label stays frozen: async work must not resize the row.
 */
function ActionRow({
  icon,
  label,
  sublabel,
  accessibilityLabel,
  trailing,
  destructive = false,
  loading = false,
  disabled = false,
  expanded,
  onPress,
}: {
  icon: React.ReactNode;
  label: string;
  sublabel?: string;
  accessibilityLabel: string;
  trailing?: React.ReactNode;
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: disabled || loading, busy: loading, expanded }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.actionRow,
        (pressed || (disabled && !loading)) && { opacity: Layout.pressedOpacity },
      ]}
    >
      <View
        style={[styles.actionIcon, destructive && styles.actionIconDestructive]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {loading ? (
          <ActivityIndicator
            size="small"
            color={destructive ? Palette.errorRed : Palette.primaryCharcoal}
          />
        ) : (
          icon
        )}
      </View>
      <View style={styles.actionText}>
        <Text
          style={[
            Type.body,
            styles.actionLabel,
            destructive && styles.actionLabelDestructive,
          ]}
        >
          {label}
        </Text>
        {sublabel !== undefined && <Text style={Type.caption}>{sublabel}</Text>}
      </View>
      {trailing}
    </Pressable>
  );
}

/**
 * Lifetime device counters inside the "This device" expansion (Phase 9.3).
 * Read once when the expansion mounts this component — on-demand data, not
 * a subscription. Copy hedges with "about": both decodes are
 * single-session/probable until the hardware confirmation walk
 * (docs/protocol.html).
 */
function DeviceInfoLines({ device }: { device: UprightGoDevice }) {
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
    <View accessible style={styles.deviceInfoLines}>
      {lines.map((line) => (
        <Text key={line} style={Type.caption}>
          {line}
        </Text>
      ))}
    </View>
  );
}

function minuteOfDayNow(): number {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/**
 * Minutes shown either side of "now" — a one-hour window total. Slots
 * stretch to the card width, so widening the span only makes them thinner.
 */
const TIMELINE_HALF_SPAN_MINUTES = 30;

/**
 * Posture strip: a fixed now-centered window that always fills the card
 * width — the current minute sits under the center marker, the last half
 * hour to its left, the (empty) next half hour to its right; the strip
 * slides as time advances. One slot per minute, upright = short green,
 * slouched = tall red, no data (off, unworn, gap, future) = faint dot.
 * Height differences carry the meaning alongside color (never color alone
 * — docs/product.html); the whole element reads as one day summary to
 * screen readers. History-only by design (the live "Posture:" line above
 * is the real-time cue); the provider backfills tick-cadence gaps.
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

  const flags = stats.minuteFlags;
  let hasRecorded = false;
  let uprightCount = 0;
  let slouchedCount = 0;
  for (let minute = 0; minute < flags.length; minute += 1) {
    if (flags[minute] === 'u') {
      hasRecorded = true;
      uprightCount += 1;
    } else if (flags[minute] === 's') {
      hasRecorded = true;
      slouchedCount += 1;
    }
  }
  if (!visible || !hasRecorded) {
    return null;
  }

  // Minutes outside today (window crossing midnight) render as dots, same
  // as unrecorded ones — flags[m] is undefined there.
  const slots: string[] = [];
  for (
    let minute = nowMinute - TIMELINE_HALF_SPAN_MINUTES;
    minute <= nowMinute + TIMELINE_HALF_SPAN_MINUTES;
    minute += 1
  ) {
    const flag = minute >= 0 ? flags[minute] : undefined;
    slots.push(flag === 'u' || flag === 's' ? flag : '.');
  }
  const nowLabel = `${String(Math.floor(nowMinute / 60)).padStart(2, '0')}:${String(
    nowMinute % 60,
  ).padStart(2, '0')}`;

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
      <View style={styles.timelineRow}>
        {/* Minutes without data — past gaps and the future half alike —
            render as grey baseline dashes in the same per-minute rhythm
            as the bars, so the strip reads as one continuous track. */}
        {slots.map((flag, index) => (
          <View
            key={index}
            style={[
              styles.timelineSlot,
              flag === 'u'
                ? styles.timelineUpright
                : flag === 's'
                  ? styles.timelineSlouched
                  : styles.timelineEmpty,
            ]}
          />
        ))}
        <View style={styles.timelineNowMarker} pointerEvents="none" />
      </View>
      {/* The encoding legend moved to the stats screen's ⓘ tip (Option 3
          redesign) — one caption fewer here, taught where users dig in. */}
      <Text style={[Type.caption, styles.timelineNowLabel]}>{nowLabel}</Text>
    </View>
  );
}

/**
 * The Statistics card's caption: today's headline numbers while there is
 * data (Option 3 redesign — the card previews what the stats screen
 * expands on), the feature description before the first worn minute so a
 * fresh day never opens with "0% upright". A leaf subscriber like
 * TiltCaption: ticks arrive every ~60 s, so re-render cost is irrelevant,
 * but screen-level state would still be the wrong altitude. Not a live
 * region — a once-a-minute announcement would be noise.
 */
function StatsCardCaption() {
  const stats = useSessionStats();
  if (stats.postureTicks === 0) {
    return (
      <Text style={Type.caption}>
        Your day, week, and 30-day posture history
      </Text>
    );
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
  const slouches =
    stats.slouchCount === 1 ? '1 slouch' : `${stats.slouchCount} slouches`;
  return (
    <Text
      style={Type.caption}
      accessibilityLabel={`Today: ${uprightPercent} percent upright, ${slouches}`}
    >
      Today: {uprightPercent}% upright · {slouches}
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
  identityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  identityBadge: {
    // Same footprint as the action-row icon bubbles (icon system,
    // specs/design_decisions.md).
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityName: {
    flex: 1,
  },
  heroBlock: {
    marginTop: 10,
  },
  postureHero: {
    fontSize: 27,
    fontWeight: '700',
    lineHeight: 33,
  },
  heroQuiet: {
    fontWeight: '400',
    color: Palette.secondarySlate,
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
  actionsCard: {
    paddingVertical: 4,
    gap: 0,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
    paddingVertical: 11,
  },
  actionIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIconDestructive: {
    backgroundColor: 'transparent',
  },
  actionText: {
    flex: 1,
    gap: 0,
  },
  actionLabel: {
    color: Palette.primaryCharcoal,
    fontWeight: '600',
  },
  actionLabelDestructive: {
    color: Palette.errorRed,
    fontWeight: '400',
  },
  actionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.borderDivider,
  },
  deviceInfoBody: {
    paddingBottom: 11,
    paddingLeft: 34 + Layout.componentGap,
    gap: Layout.componentGap,
  },
  deviceInfoLines: {
    gap: 2,
  },
  demoSteering: {
    gap: 6,
  },
  demoSegments: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    backgroundColor: Palette.backgroundWarmWhite,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    borderRadius: 10,
    padding: 2,
  },
  demoSegment: {
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  demoSegmentOn: {
    backgroundColor: Palette.primaryCharcoal,
  },
  demoSegmentText: {
    fontWeight: '600',
  },
  demoSegmentTextOn: {
    color: Palette.cardSoftCream,
  },
  statusLine: {
    paddingHorizontal: 4,
    marginTop: -6,
  },
  stateBadgeOk: {
    backgroundColor: Palette.softGreen,
  },
  stateBadgeWarn: {
    backgroundColor: Palette.softAmber,
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
  reconnectingLabel: {
    marginTop: 10,
    color: Palette.warningOrange,
  },
  reconnectingHint: {
    marginTop: 4,
  },
  tiltLine: {
    marginTop: 4,
  },
  timeline: {
    marginTop: 8,
    gap: 4,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 1,
    height: 16,
  },
  timelineSlot: {
    // Equal shares of the card width — the strip always fills it exactly.
    flex: 1,
    height: 3,
    borderRadius: 1,
  },
  timelineEmpty: {
    // borderDivider is imperceptible at 3px on the cream card; slate at
    // low opacity keeps the empty dashes recessive but clearly there.
    backgroundColor: Palette.secondarySlate,
    opacity: 0.35,
  },
  timelineNowMarker: {
    position: 'absolute',
    left: '50%',
    marginLeft: -1,
    top: 0,
    bottom: 0,
    width: 2,
    borderRadius: 1,
    backgroundColor: Palette.primaryCharcoal,
  },
  timelineNowLabel: {
    alignSelf: 'center',
  },
  timelineUpright: {
    height: 8,
    backgroundColor: Palette.successGreen,
  },
  timelineSlouched: {
    height: 16,
    backgroundColor: Palette.errorRed,
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
