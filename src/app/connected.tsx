import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
// Dev-only probe trigger (Phase 5.6) — sanctioned harness exception to the
// screens-use-hooks-only rule, like the Phase 1 harness before it.
import { dumpReadableCharacteristics } from '@/device/devHarness';
import type { PostureStatus } from '@/device/types';
import { useDevice } from '@/hooks/useDevice';
import { usePosture } from '@/hooks/usePosture';

const POSTURE_LINE: Record<PostureStatus, { label: string; color: string }> = {
  upright: { label: 'Upright', color: Palette.successGreen },
  slouching: { label: 'Slouching', color: Palette.warningOrange },
  unknown: {
    label: 'Calibrate to see live status',
    color: Palette.secondarySlate,
  },
};

type PendingAction = 'vibration' | 'disconnect' | null;

export default function ConnectedScreen() {
  const router = useRouter();
  const { device, connectionState, bluetoothOff, disconnect } = useDevice();
  const posture = usePosture();
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [lastAction, setLastAction] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

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

  // headerBackVisible/gestureEnabled in _layout.tsx cover iOS; the Android
  // hardware back button ignores both, so it needs its own block while
  // this screen is focused. Exits stay: Disconnect, or a connection drop.
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener(
        'hardwareBackPress',
        () => true,
      );
      return () => subscription.remove();
    }, []),
  );

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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Card>
        <Text
          style={[
            Type.body,
            reconnecting ? styles.reconnectingLabel : styles.connectedLabel,
          ]}
        >
          {reconnecting ? 'Connection lost' : 'Connected'}
        </Text>
        <Text style={Type.display}>{device?.name ?? 'Posture device'}</Text>
        <Text style={Type.body}>Compatible device</Text>
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
            <Text
              style={[Type.body, styles.postureValue, { color: postureLine.color }]}
            >
              {postureLine.label}
            </Text>
          </View>
        )}
      </Card>

      {needsCalibration && (
        <Card style={styles.calloutCard}>
          <Text style={Type.title}>Calibration needed</Text>
          <Text style={Type.body}>
            Sit or stand upright, then calibrate. This sets the reference
            for the live status and turns on the device’s slouch vibration.
            If the device was calibrated before, this simply resets it.
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
        disabled={actionsDisabled}
        onPress={() => router.navigate('/calibrate')}
      />
      <ActionButton
        label={pendingAction === 'vibration' ? 'Sending vibration…' : 'Test vibration'}
        accessibilityLabel="Send vibration test"
        variant="outline"
        loading={pendingAction === 'vibration'}
        disabled={actionsDisabled}
        onPress={() => void handleTestVibration()}
      />

      {lastAction && (
        <Card>
          <Text style={Type.title}>Status</Text>
          <Text
            style={[Type.body, !lastAction.ok && styles.errorText]}
            accessibilityLiveRegion="polite"
          >
            Last action: {lastAction.text}
          </Text>
        </Card>
      )}

      {__DEV__ && (
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
      )}

      <View style={styles.footer}>
        <ActionButton
          label={pendingAction === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          accessibilityLabel="Disconnect from device"
          variant="ghost"
          loading={pendingAction === 'disconnect'}
          disabled={busy}
          onPress={() => void handleDisconnect()}
        />
        <Disclaimer />
      </View>
    </ScrollView>
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
