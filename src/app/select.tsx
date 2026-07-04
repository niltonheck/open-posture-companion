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
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { BluetoothPulse } from '@/components/bluetooth-pulse';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
import { DEVICE_NAME } from '@/device/characteristics';
import type { DiscoveredDevice, SignalStrength } from '@/device/types';
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
 * One discovered device. While this row is connecting, its content dims in
 * place (still occupying layout, so the card never resizes) and a centered
 * "Connecting…" overlay crossfades in — the button label itself never
 * changes, which is what kept jolting the row width.
 */
function DeviceRow({
  item,
  connecting,
  disabled,
  onConnect,
}: {
  item: DiscoveredDevice;
  connecting: boolean;
  /** Some connection attempt is in flight (this row's or another's). */
  disabled: boolean;
  onConnect: () => void;
}) {
  const dim = useSharedValue(connecting ? 1 : 0);
  useEffect(() => {
    dim.value = withTiming(connecting ? 1 : 0, { duration: 200 });
  }, [connecting, dim]);
  const contentStyle = useAnimatedStyle(() => ({
    opacity: 1 - dim.value * 0.85,
  }));

  return (
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
          {item.name === DEVICE_NAME ? (
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
        {/* One grouped element: "UprightGO, Signal: Strong" per swipe. */}
        <View style={styles.deviceInfo} accessible>
          <Text style={Type.title}>{item.name}</Text>
          <Text style={Type.body}>
            Signal:{' '}
            <Text style={{ color: SIGNAL_COLOR[item.signal] }}>
              {SIGNAL_LABEL[item.signal]}
            </Text>
          </Text>
        </View>
        <ActionButton
          label="Connect"
          accessibilityLabel={`Connect to ${item.name}`}
          variant="outline"
          compact
          disabled={disabled}
          onPress={onConnect}
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
  );
}

export default function SelectDeviceScreen() {
  const router = useRouter();
  const {
    connectionState,
    scanStatus,
    devices,
    device,
    bluetoothOff,
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
      await connect(target);
      if (!focusedRef.current) {
        void disconnect();
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // Replace so the back gesture from the connected screen returns home,
      // not to a consumed scan list.
      router.replace('/connected');
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
  const scanning = scanStatus === 'scanning';
  // With permission missing or the radio off, entries can't be reached —
  // don't leave them rendered and tappable.
  const listDevices = permissionNeeded || bluetoothOff ? [] : devices;

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
    // 'scanning' — or 'idle' while the mount-time startScan is still
    // waiting on the permission prompt; either way a scan is underway or
    // imminent, so never claim "no devices found" here.
    return (
      <View style={styles.scanningRow}>
        <BluetoothPulse size={22} color={Palette.secondarySlate} />
        <Text style={Type.body}>Scanning for devices…</Text>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
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
        contentContainerStyle={styles.list}
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
              label={scanning ? 'Scanning…' : 'Scan again'}
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
    opacity: 0.6,
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
  scanningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: Layout.sectionGap,
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
