import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AppHeader } from '@/components/app-header';
import { BluetoothPulse } from '@/components/bluetooth-pulse';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
import { useDevice } from '@/hooks/useDevice';

/** Lifecycle of the launch reconnect to the remembered device (9.1). */
type AutoConnect = 'none' | 'connecting' | 'failed';

export default function HomeScreen() {
  const router = useRouter();
  // bluetoothOff is only known after the first BLE-touching action starts
  // the adapter watch (lazy by design); before that it reads false here.
  const {
    bluetoothOff,
    rememberedDevice,
    reconnectToRemembered,
    cancelReconnectToRemembered,
    disconnect,
  } = useDevice();
  const [autoConnect, setAutoConnect] = useState<AutoConnect>('none');

  // The launch reconnect resolves after up to a 10 s connect timeout — by
  // then the user may have moved on. Navigate only while home is focused.
  const focusedRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, []),
  );

  // Try the remembered device once per app launch, skipping the select
  // screen entirely (Phase 9.1). Home is the stack root and never unmounts,
  // so a ref is enough to keep this a launch-time-only behavior. Marked
  // attempted even when nothing is remembered — otherwise the first manual
  // connect (which sets rememberedDevice) would re-fire this effect
  // mid-session. Sanctioned exception to the no-BLE-before-user-action
  // rule: a remembered device implies a past successful connect, so the
  // permission prompt cannot be a surprise.
  const attemptedRef = useRef(false);
  useEffect(() => {
    if (attemptedRef.current) {
      return;
    }
    attemptedRef.current = true;
    if (!rememberedDevice) {
      return;
    }
    setAutoConnect('connecting');
    void (async () => {
      const result = await reconnectToRemembered();
      if (result === 'connected') {
        if (focusedRef.current) {
          router.navigate('/connected');
        } else {
          // The user wandered off (e.g. into About) while this resolved.
          // No screen represents a link that appears under them — release
          // it, same invariant as select's unfocused-connect path.
          void disconnect();
        }
        setAutoConnect('none');
      } else {
        setAutoConnect(result === 'failed' ? 'failed' : 'none');
      }
    })();
  }, [rememberedDevice, reconnectToRemembered, disconnect, router]);

  const handleScanPress = () => {
    if (autoConnect === 'connecting') {
      // The scan flow supersedes the launch attempt. Cancel covers the
      // pre-connect await window (no device instance to abort yet);
      // disconnect() aborts an in-flight or completed connect so the
      // device stays discoverable.
      cancelReconnectToRemembered();
      void disconnect();
    }
    // Also clears a stale 'failed' — the user is acting on that message.
    setAutoConnect('none');
    router.navigate('/select');
  };

  // With the radio off both the pulse row and the failure copy would lie
  // ("reconnecting"/"scan" can't succeed) — the Bluetooth-off card below
  // carries the actionable message instead.
  const reconnecting = autoConnect === 'connecting' && !bluetoothOff;
  const reconnectFailed = autoConnect === 'failed' && !bluetoothOff;

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <AppHeader />

        <View style={styles.hero}>
          <View
            style={styles.heroCircle}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            <Image
              source={require('../../assets/images/logo-hero.png')}
              style={styles.heroImage}
            />
          </View>
        </View>

        <Card style={styles.statusCard}>
          <Text style={[Type.display, styles.centered]}>
            No device connected
          </Text>
          {reconnecting ? (
            // Polite live region: the transition out of "reconnecting" is
            // worth announcing; the pulse itself is decorative.
            <View style={styles.reconnectRow} accessibilityLiveRegion="polite">
              <BluetoothPulse size={20} color={Palette.secondarySlate} />
              <Text style={Type.body}>
                Reconnecting to {rememberedDevice?.name ?? 'your device'}…
              </Text>
            </View>
          ) : (
            <Text
              style={[Type.body, styles.centered]}
              accessibilityLiveRegion="polite"
            >
              {reconnectFailed
                ? `Couldn’t reach ${rememberedDevice?.name ?? 'your device'} automatically. Scan to connect.`
                : 'Scan for compatible BLE posture devices nearby.'}
            </Text>
          )}
          <View style={styles.cardAction}>
            {/* Stays enabled while the launch reconnect runs — tapping it
                cancels the attempt and moves to the scan flow (actions
                never disappear or dead-end; specs/design_decisions.md). */}
            <ActionButton
              label="Scan for devices"
              accessibilityLabel="Scan for devices"
              variant="neutral"
              icon={
                <MaterialIcons
                  name="bluetooth-searching"
                  size={20}
                  color={Palette.cardSoftCream}
                />
              }
              onPress={handleScanPress}
            />
          </View>
        </Card>

        {bluetoothOff && (
          <Card>
            <Text style={Type.title}>Bluetooth is off</Text>
            <Text style={Type.body}>
              Turn on Bluetooth to scan for devices.
            </Text>
          </Card>
        )}

        <View style={styles.compatRow}>
          <View style={styles.infoBadge} accessibilityElementsHidden>
            <Text style={styles.infoBadgeGlyph}>i</Text>
          </View>
          <Text style={[Type.caption, styles.compatText]}>
            Compatible with selected Upright GO 1 devices.
          </Text>
        </View>

        <Disclaimer medical />

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="About this app"
          onPress={() => router.navigate('/about')}
          // Visual is a quiet caption row (~26px); hitSlop makes up the
          // 44px minimum target (docs/product.html).
          hitSlop={{ top: 9, bottom: 9 }}
          style={({ pressed }) => [styles.aboutLink, pressed && styles.pressed]}
        >
          <Text style={Type.caption}>About this app</Text>
          <MaterialIcons
            name="chevron-right"
            size={14}
            color={Palette.secondarySlate}
          />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
    padding: Layout.pagePadding,
    gap: Layout.componentGap,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCircle: {
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroImage: {
    width: 187,
    height: 187,
  },
  statusCard: {
    gap: 8,
    paddingVertical: Layout.sectionGap,
  },
  reconnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  cardAction: {
    marginTop: Layout.componentGap,
  },
  compatRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  infoBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoBadgeGlyph: {
    fontSize: 14,
    fontWeight: '700',
    fontStyle: 'italic',
    color: Palette.primaryCharcoal,
  },
  centered: {
    textAlign: 'center',
  },
  compatText: {
    flexShrink: 1,
  },
  aboutLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 4,
  },
  pressed: {
    opacity: Layout.pressedOpacity,
  },
});
