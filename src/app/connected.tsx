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
import type { PostureStatus } from '@/device/types';
import { useDevice } from '@/hooks/useDevice';
import { usePosture } from '@/hooks/usePosture';
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

type PendingAction = 'vibration' | 'pause' | 'disconnect' | null;

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
  const { device, connectionState, bluetoothOff, disconnect } = useDevice();
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
    opacity: 0.6,
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
});
