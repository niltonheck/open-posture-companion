import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { ActionButton } from '@/components/action-button';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
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
        <ActivityIndicator color={Palette.secondarySlate} />
        <Text style={Type.body}>Scanning for devices…</Text>
      </View>
    );
  };

  // permissionNeeded must offer the button too: on Android a denial leaves
  // scanStatus 'idle' (startScan bails before scanning), and "Scan again"
  // is the only way to re-trigger the permission prompt from this screen.
  const showScanAgain =
    permissionNeeded ||
    bluetoothOff ||
    scanStatus === 'timed_out' ||
    scanStatus === 'error' ||
    (!scanning && listDevices.length > 0);

  return (
    <View style={styles.container}>
      <FlatList
        data={listDevices}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={Type.body}>
            {listDevices.length > 0
              ? 'Found nearby devices'
              : 'Scan for compatible BLE posture devices nearby.'}
          </Text>
        }
        renderItem={({ item }) => (
          <Card style={styles.deviceCard}>
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
              label={connectingId === item.id ? 'Connecting…' : 'Connect'}
              accessibilityLabel={`Connect to ${item.name}`}
              variant="outline"
              compact
              loading={connectingId === item.id}
              disabled={connectingId !== null}
              onPress={() => void handleConnect(item)}
            />
          </Card>
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
            {showScanAgain && (
              <ActionButton
                label="Scan again"
                accessibilityLabel="Scan for devices"
                variant="ghost"
                onPress={handleScanAgain}
                disabled={connectingId !== null}
              />
            )}
            <Disclaimer />
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  list: {
    padding: Layout.pagePadding,
    gap: Layout.componentGap,
  },
  deviceCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Layout.componentGap,
  },
  deviceInfo: {
    flexShrink: 1,
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
