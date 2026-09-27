import { DarkTheme, DefaultTheme, Stack, ThemeProvider, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import * as Updates from 'expo-updates';
import { useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { trackScreen } from '@/core/analytics';
import { AppProvider } from '@/core/app-state';

// Keep the native splash until the first frame is drawn. Data loads synchronously,
// so this is a few milliseconds, not a loading screen.
SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 200, fade: true });

/** Download app updates in the background; they apply the next time the app starts. */
function useBackgroundUpdates() {
  useEffect(() => {
    if (__DEV__ || !Updates.isEnabled) return;
    const check = async () => {
      try {
        const r = await Updates.checkForUpdateAsync();
        if (r.isAvailable) await Updates.fetchUpdateAsync();
      } catch { /* offline: try again next time */ }
    };
    check();
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') check(); });
    return () => sub.remove();
  }, []);
}

/** Screen views for analytics (route names only, e.g. /station/KGWA). */
function useScreenTracking() {
  const path = usePathname();
  useEffect(() => { trackScreen(path.replace(/\/(\d+)$/, '/:id')); }, [path]);
}

export default function RootLayout() {
  const scheme = useColorScheme();
  useBackgroundUpdates();
  useScreenTracking();
  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={() => SplashScreen.hideAsync().catch(() => undefined)}>
      <AppProvider>
        <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="onboarding" options={{ presentation: 'fullScreenModal', gestureEnabled: false }} />
            <Stack.Screen name="settings" options={{ presentation: 'modal', headerShown: true }} />
          </Stack>
        </ThemeProvider>
      </AppProvider>
    </GestureHandlerRootView>
  );
}
