import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';

import { Palette } from '@/constants/palette';
import { DeviceProvider } from '@/hooks/useDevice';

export default function RootLayout() {
  return (
    <DeviceProvider>
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
        <Stack.Screen name="select" options={{ title: 'Select device' }} />
        {/* Leaving this screen without disconnecting would show the home
            screen's "No device connected" while a link is still live — the
            only ways out are the Disconnect action or a connection drop.
            These options cover iOS; the Android hardware back button is
            blocked by a BackHandler in connected.tsx. */}
        <Stack.Screen
          name="connected"
          options={{
            title: 'Connected',
            headerBackVisible: false,
            gestureEnabled: false,
          }}
        />
        <Stack.Screen name="calibrate" options={{ title: 'Calibrate posture' }} />
      </Stack>
    </DeviceProvider>
  );
}
