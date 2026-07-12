import { MaterialIcons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import * as Haptics from 'expo-haptics';
import * as WebBrowser from 'expo-web-browser';
import React, { useRef, useState } from 'react';
import {
  Alert,
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

import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { PageHeader } from '@/components/page-header';
import { Layout, Palette } from '@/constants/palette';
import { APP_REPO_URL, PROTOCOL_RESEARCH_URL } from '@/constants/links';
import { Type } from '@/constants/typography';
import { isDemoMode, setDemoMode } from '@/storage/demoMode';

/** Taps on the version line within DEMO_TAP_WINDOW_MS to toggle demo mode. */
const DEMO_TAP_COUNT = 5;
const DEMO_TAP_WINDOW_MS = 2_000;

/** Badge + label row that opens an external link in the in-app browser. */
function LinkRow({ label, url }: { label: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => void WebBrowser.openBrowserAsync(url)}
      style={({ pressed }) => [styles.linkRow, pressed && styles.pressed]}
    >
      <View
        style={styles.linkBadge}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <MaterialIcons name="code" size={22} color={Palette.primaryCharcoal} />
      </View>
      <Text style={[Type.body, styles.linkLabel]} numberOfLines={2}>
        {label}
      </Text>
      <MaterialIcons
        name="open-in-new"
        size={20}
        color={Palette.secondarySlate}
      />
    </Pressable>
  );
}

export default function AboutScreen() {
  const insets = useSafeAreaInsets();
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const [demoMode, setDemoModeState] = useState(isDemoMode);
  const demoTapCountRef = useRef(0);
  const demoTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hidden gesture for App Store review / screenshots: five quick taps on
  // the version line toggle demo mode (a simulated device in scan results).
  // Deliberately quiet — no accessibility role, no visual affordance; the
  // App Review notes document the steps for the reviewer.
  const handleVersionTap = () => {
    if (demoTapTimerRef.current !== null) {
      clearTimeout(demoTapTimerRef.current);
    }
    demoTapTimerRef.current = setTimeout(() => {
      demoTapCountRef.current = 0;
    }, DEMO_TAP_WINDOW_MS);
    demoTapCountRef.current += 1;
    if (demoTapCountRef.current < DEMO_TAP_COUNT) {
      return;
    }
    demoTapCountRef.current = 0;
    const next = !isDemoMode();
    setDemoMode(next);
    setDemoModeState(next);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert(
      next ? 'Demo mode on' : 'Demo mode off',
      next
        ? 'A simulated posture device will appear when you scan. It behaves ' +
            'like real hardware, but nothing is saved to your history. Tap ' +
            'the version number five times again to turn demo mode off.'
        : undefined,
    );
  };

  return (
    // Bottom edge released so the scroll flows under the home indicator;
    // the inset moves into the content's bottom padding (see connected.tsx).
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Native header is hidden (_layout.tsx). */}
      <PageHeader title="About" />
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: Layout.pagePadding + insets.bottom },
        ]}
      >
        <Card style={styles.identityCard}>
          <View
            style={styles.logoTile}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Image
              source={require('../../assets/images/logo.png')}
              style={styles.logoImage}
            />
          </View>
          <Text style={[Type.title, styles.centered]}>
            Open Posture Companion
          </Text>
          {/* Quiet at rest (no role, no affordance — the gesture stays
              discoverable only via the review notes), but each tap fades
              the line while pressed so the finger knows it landed. */}
          <Pressable
            onPress={handleVersionTap}
            style={({ pressed }) => pressed && styles.pressed}
          >
            <Text style={[Type.caption, styles.centered]}>
              {/* "· demo" keeps the hidden toggle's state always visible. */}
              Version {version}
              {demoMode ? ' · demo' : ''}
            </Text>
          </Pressable>
          <Text style={[Type.body, styles.centered]}>
            An independent, open-source companion app for selected Upright GO 1
            posture trainers, created after the official app was discontinued.
          </Text>
        </Card>

        <Card>
          <Text style={Type.title}>Open source</Text>
          <Text style={Type.body}>
            The full source code is public. The repository is also the place
            for questions, issues, and contributions.
          </Text>
          <LinkRow label="Open Posture Companion on GitHub" url={APP_REPO_URL} />
        </Card>

        <Card>
          <Text style={Type.title}>Protocol research</Text>
          <Text style={Type.body}>
            The device’s Bluetooth Low Energy protocol was documented through
            independent observation of its BLE interface, solely to keep
            existing hardware usable. The research notes are public.
          </Text>
          <LinkRow
            label="Upright GO 1 protocol notes on GitHub"
            url={PROTOCOL_RESEARCH_URL}
          />
        </Card>

        <Card>
          <Text style={Type.title}>Built with</Text>
          <Text style={Type.body}>
            Expo and React Native, with react-native-ble-plx for Bluetooth
            Low Energy. Thanks to the maintainers of these projects.
          </Text>
        </Card>

        {/* Compliance-approved wording (docs/product.html) — do not vary. */}
        <Text style={[Type.caption, styles.centered]}>
          This is an independent open-source interoperability project. It is
          not affiliated with, endorsed by, sponsored by, or approved by
          UPRIGHT or any related company. “Upright GO” is used only to
          identify compatibility with original Upright GO 1 hardware.
        </Text>

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
  pressed: {
    opacity: Layout.pressedOpacity,
  },
  content: {
    padding: Layout.pagePadding,
    paddingTop: Layout.componentGap,
    gap: Layout.componentGap,
  },
  identityCard: {
    alignItems: 'center',
    gap: 6,
    paddingVertical: Layout.sectionGap,
  },
  logoTile: {
    width: 64,
    height: 64,
    borderRadius: Layout.radiusIconTile,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  logoImage: {
    width: 52,
    height: 52,
  },
  centered: {
    textAlign: 'center',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
    marginTop: 8,
    // 44px minimum tap target (docs/product.html) — the badge alone is 40.
    minHeight: 44,
  },
  linkBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  linkLabel: {
    flex: 1,
    color: Palette.primaryCharcoal,
  },
  footer: {
    marginTop: Layout.sectionGap - Layout.componentGap,
  },
});
