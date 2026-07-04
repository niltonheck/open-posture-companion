import { MaterialIcons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

/**
 * Pulsing bluetooth-searching glyph — the "radio lookup in progress" cue
 * (specs/design_decisions.md). Use wherever a BLE scan/connect/reconnect is
 * running, instead of a generic ActivityIndicator.
 */
export function BluetoothPulse({ size, color }: { size: number; color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.25, { duration: 600 }),
      -1,
      true, // reverse: fade out, fade back in
    );
  }, [opacity]);
  const pulse = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View style={pulse}>
      <MaterialIcons name="bluetooth-searching" size={size} color={color} />
    </Animated.View>
  );
}
