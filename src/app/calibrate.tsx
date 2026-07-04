import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { ActionButton } from '@/components/action-button';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
import { useDevice } from '@/hooks/useDevice';

/**
 * Screen-local outcome of the last attempt. The in-progress phase is NOT
 * mirrored here — connectionState === 'calibrating' already reports it
 * (the device layer owns that transition).
 */
type FlowResult = 'ready' | 'done' | 'error';

const BUTTON_TEXT: Record<FlowResult, { label: string; a11y: string }> = {
  ready: { label: 'Start calibration', a11y: 'Start calibration' },
  done: { label: 'Done', a11y: 'Done' },
  error: { label: 'Try again', a11y: 'Try calibration again' },
};

export default function CalibrateScreen() {
  const router = useRouter();
  const { device, connectionState, bluetoothOff } = useDevice();
  const [flow, setFlow] = useState<FlowResult>('ready');

  const calibrating = connectionState === 'calibrating';
  // Auto-reconnect (or a full drop) can happen under this screen; the
  // connected screen's watcher pops the whole stack home once the device
  // gives up, so this only has to cover the 'reconnecting' window.
  const linkDown = !calibrating && connectionState !== 'connected';

  const handleStart = async () => {
    // device.connectionState is synchronous truth — the context state lags
    // a render, so a same-frame double tap would otherwise start twice.
    if (!device || device.connectionState !== 'connected') {
      return;
    }
    try {
      await device.calibrate();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setFlow('done');
    } catch {
      // Rejects when the link dropped or before the first tilt reading
      // arrives (startup edge) — both worth a retry.
      setFlow('error');
    }
  };

  const buttonText = calibrating
    ? { label: 'Calibrating…', a11y: 'Calibrating' }
    : BUTTON_TEXT[flow];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {flow === 'done' ? (
        <Card>
          <Text style={[Type.display, styles.doneTitle]}>
            Calibration complete
          </Text>
          <Text style={Type.body}>
            The device vibrates twice to confirm. Your current posture is now
            the reference for the live status, and the device will vibrate
            when you slouch past it.
          </Text>
        </Card>
      ) : (
        <>
          <Card>
            <Text style={Type.display}>
              Sit or stand in your ideal posture, then hold still.
            </Text>
          </Card>

          <Card>
            <Text style={[Type.title, styles.checklistTitle]}>
              Before you begin
            </Text>
            {/* Bullets are decorative; group each row so screen readers
                read the item text without a stray "middle dot". */}
            <View style={styles.checklistItem} accessible>
              <Text
                style={[Type.body, styles.checklistBullet]}
                accessibilityElementsHidden
              >
                ·
              </Text>
              <Text style={Type.body}>Place the device comfortably</Text>
            </View>
            <View style={styles.checklistItem} accessible>
              <Text
                style={[Type.body, styles.checklistBullet]}
                accessibilityElementsHidden
              >
                ·
              </Text>
              <Text style={Type.body}>Hold still for a moment</Text>
            </View>
          </Card>

          {flow === 'error' && (
            <Text style={[Type.body, styles.errorText]}>
              Calibration didn’t complete. Make sure the device is connected
              and you’re holding still, then try again.
            </Text>
          )}
          {linkDown && (
            <Text
              style={[Type.body, styles.errorText]}
              accessibilityLiveRegion="polite"
            >
              {bluetoothOff
                ? 'Bluetooth is off. Turn it on to reconnect.'
                : 'Connection lost. Waiting for the device to reconnect…'}
            </Text>
          )}
        </>
      )}

      <ActionButton
        label={buttonText.label}
        accessibilityLabel={buttonText.a11y}
        variant="primary"
        loading={calibrating}
        disabled={flow !== 'done' && linkDown}
        onPress={() => {
          if (flow === 'done') {
            router.back();
          } else {
            void handleStart();
          }
        }}
      />

      <View style={styles.footer}>
        <Disclaimer medical />
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
  checklistTitle: {
    marginBottom: 4,
  },
  checklistItem: {
    flexDirection: 'row',
    gap: 8,
  },
  checklistBullet: {
    color: Palette.accentAmber,
    fontWeight: '700',
  },
  doneTitle: {
    color: Palette.successGreen,
  },
  errorText: {
    color: Palette.errorRed,
    textAlign: 'center',
  },
  footer: {
    marginTop: Layout.sectionGap - Layout.componentGap,
  },
});
