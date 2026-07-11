import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { PageHeader } from '@/components/page-header';
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

/** One "Before you begin" row: soft-amber badge + text, per the mockup. */
function ChecklistRow({
  icon,
  text,
  title = false,
}: {
  icon: React.ReactNode;
  text: string;
  title?: boolean;
}) {
  return (
    <View style={styles.checklistRow} accessible>
      <View
        style={styles.checklistBadge}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {icon}
      </View>
      <Text style={[title ? Type.title : Type.body, styles.checklistText]}>
        {text}
      </Text>
    </View>
  );
}

export default function CalibrateScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  // Onboarding: pushed over /connected right after connecting a device
  // that reports uncalibrated (aab2 = 0x00 — every power cycle). Back,
  // swipe-back, and "Skip for now" all pop to the connected screen.
  const { onboarding } = useLocalSearchParams<{ onboarding?: string }>();
  const isOnboarding = onboarding === '1';
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
    // Bottom edge released so the scroll flows under the home indicator;
    // the inset moves into the content's bottom padding (see connected.tsx).
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Native header is hidden (_layout.tsx). */}
      <PageHeader title="Calibrate posture" />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Layout.pagePadding + insets.bottom },
        ]}
      >
        {isOnboarding && flow !== 'done' && (
          <Text style={Type.body}>
            Your device is connected but not calibrated yet — this happens
            after every power-off. Calibrating enables the live posture
            status and slouch vibrations.
          </Text>
        )}
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
            <Card style={styles.heroCard}>
              <Text style={[Type.display, styles.heroText]}>
                Sit or stand in your ideal posture, then hold still.
              </Text>
              <Image
                source={require('../../assets/images/illustration-calibrate.png')}
                style={styles.heroImage}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </Card>

            <ActionButton
              label={buttonText.label}
              accessibilityLabel={buttonText.a11y}
              variant="primary"
              icon={
                <Image
                  source={require('../../assets/images/icon-calibrate.png')}
                  style={styles.buttonIcon}
                />
              }
              loading={calibrating}
              disabled={linkDown}
              onPress={() => void handleStart()}
            />

            <Card style={styles.checklistCard}>
              <ChecklistRow
                title
                text="Before you begin"
                icon={
                  <MaterialIcons
                    name="info-outline"
                    size={22}
                    color={Palette.primaryCharcoal}
                  />
                }
              />
              <View style={styles.divider} />
              <ChecklistRow
                text="Place the device comfortably"
                icon={
                  <Image
                    source={require('../../assets/images/icon-device.png')}
                    style={styles.checklistGlyph}
                  />
                }
              />
              <View style={styles.divider} />
              <ChecklistRow
                text="Hold still for a moment"
                icon={
                  <MaterialIcons
                    name="schedule"
                    size={22}
                    color={Palette.primaryCharcoal}
                  />
                }
              />
            </Card>

            {isOnboarding && (
              // Quiet caption action (forget-link pattern): skipping is
              // legitimate — the connected screen's posture line and the
              // Calibrate button carry the uncalibrated state from there.
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Skip calibration for now"
                onPress={() => router.back()}
                hitSlop={8}
                style={({ pressed }) => [
                  styles.skipLink,
                  pressed && styles.skipLinkDim,
                ]}
              >
                <Text style={Type.caption}>Skip for now</Text>
              </Pressable>
            )}
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

        {flow === 'done' && (
          <ActionButton
            label={buttonText.label}
            accessibilityLabel={buttonText.a11y}
            variant="primary"
            onPress={() => router.back()}
          />
        )}

        <View style={styles.footer}>
          <Disclaimer medical />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Layout.pagePadding,
    paddingTop: Layout.componentGap,
    gap: Layout.componentGap,
  },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
    paddingTop: Layout.sectionGap,
    // The figure's ground line sits near the card's bottom edge (mockup).
    paddingBottom: 10,
  },
  heroText: {
    flex: 1,
    // Between title and display — the mockup's hero copy is ~21pt.
    fontSize: 21,
    lineHeight: 29,
    // Text block floats around the card's middle while the image bottoms out.
    marginBottom: Layout.sectionGap,
  },
  heroImage: {
    // 3x asset is 423x660 — keep the aspect to avoid resampling distortion.
    width: 141,
    height: 220,
    alignSelf: 'flex-end',
  },
  buttonIcon: {
    width: 20,
    height: 20,
  },
  checklistCard: {
    gap: 10,
  },
  checklistRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
  },
  checklistBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checklistGlyph: {
    width: 22,
    height: 22,
  },
  checklistText: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: Palette.borderDivider,
  },
  doneTitle: {
    color: Palette.successGreen,
  },
  errorText: {
    color: Palette.errorRed,
    textAlign: 'center',
  },
  skipLink: {
    alignSelf: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  skipLinkDim: {
    opacity: Layout.pressedOpacity,
  },
  footer: {
    marginTop: Layout.sectionGap - Layout.componentGap,
  },
});
