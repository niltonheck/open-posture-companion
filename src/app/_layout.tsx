import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';

import { Palette } from '@/constants/palette';
import { DeviceProvider } from '@/hooks/useDevice';
import { SessionStatsProvider } from '@/hooks/useSessionStats';

export default function RootLayout() {
  return (
    <DeviceProvider>
      <SessionStatsProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: Palette.backgroundWarmWhite },
          headerTintColor: Palette.primaryCharcoal,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: Palette.backgroundWarmWhite },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        {/* In-page back arrow + large title per specs/assets/device_selection.png */}
        <Stack.Screen name="select" options={{ headerShown: false }} />
        {/* Leaving this screen without disconnecting would show the home
            screen's "No device connected" while a link is still live — the
            only ways out are the Disconnect action or a connection drop.
            These options cover iOS; the Android hardware back button is
            blocked by a BackHandler in connected.tsx. */}
        <Stack.Screen
          name="connected"
          options={{
            // In-page AppHeader instead of a native bar; no back affordance
            // by design (see comment above), so nothing is lost by hiding it.
            headerShown: false,
            gestureEnabled: false,
          }}
        />
        {/* In-page back arrow + centered title per the calibrate mockup. */}
        <Stack.Screen name="calibrate" options={{ headerShown: false }} />
        <Stack.Screen name="about" options={{ headerShown: false }} />
      </Stack>
      </SessionStatsProvider>
    </DeviceProvider>
  );
}
