import { useRouter } from 'expo-router';
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { Card } from '@/components/card';
import { Disclaimer } from '@/components/disclaimer';
import { Layout, Palette } from '@/constants/palette';
import { Type } from '@/constants/typography';
import { useDevice } from '@/hooks/useDevice';

export default function HomeScreen() {
  const router = useRouter();
  // Only known after the first scan attempt starts the adapter watch
  // (lazy by design); before that this renders nothing here.
  const { bluetoothOff } = useDevice();

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.hero}>
          {/* Decorative — the app name right below carries the meaning. */}
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
          <Text style={[Type.display, styles.centered]}>
            Open Posture Companion
          </Text>
          <Text style={[Type.caption, styles.centered]}>
            Compatible with selected Upright GO 1 devices
          </Text>
        </View>

        <Card>
          <Text style={Type.title}>No device connected</Text>
          <Text style={Type.body}>
            Scan for compatible BLE posture devices nearby.
          </Text>
        </Card>

        {bluetoothOff && (
          <Card>
            <Text style={Type.title}>Bluetooth is off</Text>
            <Text style={Type.body}>
              Turn on Bluetooth to scan for devices.
            </Text>
          </Card>
        )}

        <ActionButton
          label="Scan for devices"
          accessibilityLabel="Scan for devices"
          variant="neutral"
          onPress={() => router.navigate('/select')}
        />

        <Disclaimer medical />
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
    gap: Layout.componentGap,
  },
  logoTile: {
    width: 88,
    height: 88,
    borderRadius: Layout.radiusIconTile,
    backgroundColor: Palette.cardSoftCream,
    borderWidth: 1,
    borderColor: Palette.borderDivider,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImage: {
    width: 72,
    height: 72,
  },
  centered: {
    textAlign: 'center',
  },
});
