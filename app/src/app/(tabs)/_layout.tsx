import { Redirect } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform } from 'react-native';
import type { SFSymbol } from 'sf-symbols-typescript';
import { useApp } from '@/core/app-state';
import { useTheme } from '@/ui/theme';

const icon = (sf: SFSymbol, src: number) => (Platform.OS === 'ios' ? { sf } : { src });

export default function TabsLayout() {
  const { onboarded, t } = useApp();
  const { c } = useTheme();
  if (!onboarded) return <Redirect href="/onboarding" />;
  return (
    <NativeTabs tintColor={c.tint} backgroundColor={c.card} labelStyle={{ selected: { color: c.tint } }}>
      <NativeTabs.Trigger name="(home)">
        <NativeTabs.Trigger.Label>{t('tab_home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon {...icon('house.fill', require('@/assets/images/tabIcons/home.png'))} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(plan)">
        <NativeTabs.Trigger.Label>{t('tab_plan')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon {...icon('point.topleft.down.to.point.bottomright.curvepath.fill', require('@/assets/images/tabIcons/route.png'))} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="(stations)">
        <NativeTabs.Trigger.Label>{t('tab_st')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon {...icon('tram.fill', require('@/assets/images/tabIcons/train.png'))} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
