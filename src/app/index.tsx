import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActionButton } from '@/components/action-button';
import { AppHeader } from '@/components/app-header';
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
          <Text style={[Type.body, styles.centered]}>
            Scan for compatible BLE posture devices nearby.
          </Text>
          <View style={styles.cardAction}>
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
              onPress={() => router.navigate('/select')}
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
});
