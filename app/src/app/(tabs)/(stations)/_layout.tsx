import { Stack } from 'expo-router';
import { useTheme } from '@/ui/theme';

export default function TabStack() {
  const { c } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerLargeTitle: true,
        headerShadowVisible: false,
        headerLargeTitleShadowVisible: false,
        headerStyle: { backgroundColor: c.bg },
        headerLargeStyle: { backgroundColor: c.bg },
        headerTintColor: c.tint,
        headerTitleStyle: { color: c.ink },
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: c.bg },
      }}
    />
  );
}
