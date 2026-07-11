import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import {
  SafeAreaView,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BluetoothPulse } from '@/components/bluetooth-pulse';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
import { DEVICE_NAME } from '@/device/characteristics';
import { DEMO_DEVICE_ID } from '@/device/demoTransport';
import {
  deviceIdSuffix,
  type DiscoveredDevice,
  type SignalStrength,
} from '@/device/types';
import { useDevice } from '@/hooks/useDevice';

const SIGNAL_LABEL: Record<SignalStrength, string> = {
  strong: 'Strong',
  medium: 'Medium',
  weak: 'Weak',
};

// Never color alone — the label text carries the meaning (docs/product.html).
const SIGNAL_COLOR: Record<SignalStrength, string> = {
  strong: Palette.successGreen,
  medium: Palette.warningOrange,
  weak: Palette.errorRed,
};

/**
 * One discovered device — the whole row is the tap target (2026-07-11
 * review, same rule as the stats history rows; the chevron marks it
 * tappable). While this row is connecting, its content dims in place
 * (still occupying layout, so the card never resizes) and a centered
 * "Connecting…" overlay crossfades in.
 */
function DeviceRow({
  item,
  connecting,
  disabled,
  lastUsed,
  onConnect,
}: {
  item: DiscoveredDevice;
  connecting: boolean;
  /** Some connection attempt is in flight (this row's or another's). */
  disabled: boolean;
  /**
   * This is the remembered device (last successful connect). The pill
   * disambiguates identical "UprightGO" rows — two real units, or the
   * demo device in dev builds, where it shares the plain hardware name
   * and is never remembered.
   */
  lastUsed: boolean;
  onConnect: () => void;
}) {
  const dim = useSharedValue(connecting ? 1 : 0);
  useEffect(() => {
    dim.value = withTiming(connecting ? 1 : 0, { duration: 200 });
  }, [connecting, dim]);
  const contentStyle = useAnimatedStyle(() => ({
    opacity: 1 - dim.value * 0.85,
  }));

  const suffix = deviceIdSuffix(item.id);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Connect to ${item.name} ${suffix}${
        lastUsed ? ', last used' : ''
      }, signal ${SIGNAL_LABEL[item.signal].toLowerCase()}`}
      accessibilityState={{ disabled, busy: connecting }}
      disabled={disabled}
      onPress={onConnect}
      style={({ pressed }) => pressed && { opacity: Layout.pressedOpacity }}
    >
      <Card>
        <Animated.View
          style={[styles.deviceRowContent, contentStyle]}
          accessibilityElementsHidden={connecting}
          importantForAccessibility={
            connecting ? 'no-hide-descendants' : 'auto'
          }
        >
          <View
            style={styles.deviceTile}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          >
            {/* Prefix match: the demo device is named "UprightGO (Demo)" in
                production builds and deserves the same silhouette. */}
            {item.name.startsWith(DEVICE_NAME) ? (
              // Original silhouette illustration, not an UPRIGHT asset —
              // see the header comment in device-upright-go.svg.
              <Image
                source={require('../../assets/images/device-upright-go.png')}
                style={styles.deviceTileLogo}
              />
            ) : (
              <MaterialIcons
                name="bluetooth"
                size={34}
                color={Palette.primaryCharcoal}
              />
            )}
          </View>
          {/* The row Pressable carries the composed a11y label; every unit
              advertises the same name, so the id suffix is the only thing
              that tells two of them apart. The pill's meaning rides on its
              text, never color alone. */}
          <View style={styles.deviceInfo}>
            <View style={styles.deviceNameRow}>
              <Text style={Type.title}>{item.name}</Text>
              <Text style={Type.caption}>· {suffix}</Text>
              {lastUsed && (
                <View style={styles.lastUsedPill}>
                  <Text style={[Type.caption, styles.lastUsedText]}>
                    Last used
                  </Text>
                </View>
              )}
            </View>
            <Text style={Type.body}>
              Signal:{' '}
              <Text style={{ color: SIGNAL_COLOR[item.signal] }}>
                {SIGNAL_LABEL[item.signal]}
              </Text>
            </Text>
          </View>
          <MaterialIcons
            name="chevron-right"
            size={20}
            color={Palette.secondarySlate}
          />
        </Animated.View>
        {connecting && (
          <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            style={styles.connectingOverlay}
            pointerEvents="none"
            accessibilityLiveRegion="polite"
          >
            <BluetoothPulse size={20} color={Palette.primaryCharcoal} />
            <Text style={[Type.body, styles.connectingText]}>Connecting…</Text>
          </Animated.View>
        )}
      </Card>
    </Pressable>
  );
}

export default function SelectDeviceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const {
    connectionState,
    scanStatus,
    devices,
    device,
    bluetoothOff,
    rememberedDevice,
    startScan,
    stopScan,
    connect,
    disconnect,
  } = useDevice();
  const [connectError, setConnectError] = useState(false);
  // Tap-time marker: the machine only reaches 'connecting' after the
  // provider has released any previous device (a real BLE call), and that
  // gap must not leave every Connect button enabled.
  const [pendingId, setPendingId] = useState<string | null>(null);

  const connectingId =
    pendingId ??
    (connectionState === 'connecting' ? (device?.id ?? null) : null);

  useEffect(() => {
    startScan();
    return stopScan;
  }, [startScan, stopScan]);

  // connect() can resolve after the user backed out of this screen; only
  // navigate while focused (and release the abandoned connection).
  const focusedRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, []),
  );

  const handleConnect = async (target: DiscoveredDevice) => {
    setConnectError(false);
    setPendingId(target.id);
    try {
      const instance = await connect(target);
      if (!focusedRef.current) {
        void disconnect();
        return;
      }
      // Onboarding gate (specs/design_decisions.md): a real device that
      // connects uncalibrated (aab2 resets on power cycle) goes straight
      // into the calibrate step. The demo device bypasses it — reviewer
      // sessions must land on the marquee screen with no detour.
      const needsCalibration =
        target.id !== DEMO_DEVICE_ID && !(await instance.isCalibrated());
      if (!focusedRef.current) {
        void disconnect();
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Replace so the back gesture from the connected screen returns home,
      // not to a consumed scan list.
      router.replace('/connected');
      if (needsCalibration) {
        // Pushed over /connected, so back/swipe and "Skip for now" both
        // land there naturally — no gesture blocking needed.
        router.push({ pathname: '/calibrate', params: { onboarding: '1' } });
      }
    } catch {
      if (focusedRef.current) {
        setConnectError(true);
      }
    } finally {
      setPendingId(null);
    }
  };

  const handleScanAgain = () => {
    setConnectError(false);
    startScan();
  };

  const permissionNeeded = connectionState === 'permission_needed';
  // Covers the OS-permission-prompt window too: startScan marks 'scanning'
  // synchronously, so the footer never presents an in-progress scan as
  // finished ("Scan again").
  const scanning = scanStatus === 'scanning';
  // With permission missing or the radio off, entries can't be reached —
  // don't leave them rendered and tappable. The demo device is the
  // exception: connecting to it never touches the radio, and it must stay
  // reachable in a reviewer environment we don't control (BT off, denied).
  const listDevices =
    permissionNeeded || bluetoothOff
      ? devices.filter((item) => item.id === DEMO_DEVICE_ID)
      : devices;

  const renderEmptyState = () => {
    if (permissionNeeded) {
      return (
        <Card>
          <Text style={Type.title}>Bluetooth permission needed</Text>
          <Text style={Type.body}>
            This app uses Bluetooth only to find and talk to your posture
            device. Allow Bluetooth access in Settings, then scan again.
          </Text>
        </Card>
      );
    }
    if (bluetoothOff) {
      // Takes priority over the scanning spinner: a scan started with the
      // radio off just waits until its timeout, and "Scanning…" would be a
      // lie the user can act on.
      return (
        <Card>
          <Text style={Type.title}>Bluetooth is off</Text>
          <Text style={Type.body}>
            Turn on Bluetooth, then scan again to find your device.
          </Text>
        </Card>
      );
    }
    if (scanStatus === 'error') {
      return (
        <Card>
          <Text style={Type.title}>Scanning didn’t work</Text>
          <Text style={Type.body}>
            Check that Bluetooth is turned on, then scan again.
          </Text>
        </Card>
      );
    }
    if (scanStatus === 'timed_out') {
      return (
        <Card>
          <Text style={Type.title}>No devices found</Text>
          <Text style={Type.body}>
            Make sure your device is charged and nearby, then scan again.
          </Text>
        </Card>
      );
    }
    // 'scanning' (which includes the permission-prompt window — startScan
    // marks it synchronously): never claim "no devices found" mid-scan.
    // The footer's "Scanning…" button (pulsing glyph) already reports the
    // in-progress state — a second message here would duplicate it.
    return null;
  };

  return (
    // Bottom edge released so the list scrolls under the home indicator;
    // the inset moves into the list's bottom padding (see connected.tsx).
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      {/* Native header is hidden for this screen (_layout.tsx); the iOS
          swipe-back gesture still works, this arrow is the visible way out. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        hitSlop={12}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <MaterialIcons
          name="arrow-back"
          size={28}
          color={Palette.primaryCharcoal}
        />
      </Pressable>
      <FlatList
        data={listDevices}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[
          styles.list,
          { paddingBottom: Layout.pagePadding + insets.bottom },
        ]}
        ListHeaderComponent={
          <View style={styles.pageHeader}>
            <Text style={Type.display}>Select device</Text>
            <Text style={Type.body}>
              {listDevices.length > 0
                ? 'Found nearby devices'
                : 'Scan for compatible BLE posture devices nearby.'}
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <DeviceRow
            item={item}
            connecting={connectingId === item.id}
            disabled={connectingId !== null}
            lastUsed={item.id === rememberedDevice?.id}
            onConnect={() => void handleConnect(item)}
          />
        )}
        ListEmptyComponent={renderEmptyState()}
        ListFooterComponent={
          <View style={styles.footer}>
            {connectError && (
              <Text
                style={[Type.body, styles.connectError]}
                accessibilityLiveRegion="polite"
              >
                Couldn’t connect to the device. Move closer and try again.
              </Text>
            )}
            {/* Always visible; while a scan runs it turns into a disabled
                "Scanning…" state with a pulsing bluetooth glyph. Also the
                only way to re-trigger the permission prompt after an Android
                denial, which leaves scanStatus 'idle'. */}
            <ActionButton
              label={scanning ? 'Scanning for devices…' : 'Scan again'}
              accessibilityLabel={
                scanning ? 'Scanning for devices' : 'Scan for devices'
              }
              variant="ghost"
              icon={
                scanning ? (
                  <BluetoothPulse size={20} color={Palette.primaryCharcoal} />
                ) : (
                  <MaterialIcons
                    name="refresh"
                    size={20}
                    color={Palette.primaryCharcoal}
                  />
                )
              }
              onPress={handleScanAgain}
              disabled={connectingId !== null || scanning}
            />
            <Disclaimer />
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  backButton: {
    marginTop: Layout.componentGap,
    marginLeft: Layout.pagePadding,
    alignSelf: 'flex-start',
  },
  pressed: {
    opacity: Layout.pressedOpacity,
  },
  pageHeader: {
    gap: 4,
    marginBottom: Layout.componentGap,
  },
  list: {
    padding: Layout.pagePadding,
    gap: Layout.componentGap,
  },
  deviceRowContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Layout.componentGap,
  },
  connectingOverlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  connectingText: {
    color: Palette.primaryCharcoal,
  },
  deviceTile: {
    width: 72,
    height: 72,
    borderRadius: Layout.radiusIconTile,
    backgroundColor: Palette.softAmber,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceTileLogo: {
    width: 60,
    height: 60,
  },
  deviceInfo: {
    flex: 1,
    gap: 2,
  },
  deviceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  lastUsedPill: {
    backgroundColor: Palette.softGreen,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
  lastUsedText: {
    color: Palette.primaryCharcoal,
  },
  connectError: {
    color: Palette.errorRed,
    textAlign: 'center',
  },
  footer: {
    gap: Layout.componentGap,
    paddingTop: Layout.componentGap,
  },
});
