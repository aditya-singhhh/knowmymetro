import DateTimePicker from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LANGS, nearestStation, pad2, stationName, type Lang } from '@kmm/shared';
import { setRiderProperty, track } from '@/core/analytics';
import { useApp } from '@/core/app-state';
import { Button, Card, Notice, T, Tap } from '@/ui/components';
import { StationPicker } from '@/ui/station-picker';
import { radius, space, useTheme } from '@/ui/theme';

export default function Onboarding() {
  const { step: startStep } = useLocalSearchParams<{ step?: string }>();
  const app = useApp();
  const { t, tt, lang, setLang, setCommute, finishOnboarding, setHomeStation } = app;
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<'lang' | 'commute'>(startStep === 'commute' ? 'commute' : 'lang');
  const [from, setFrom] = useState<string | null>(app.homeStation);
  const [to, setTo] = useState<string | null>(null);
  const [time, setTime] = useState('09:30');
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [locMsg, setLocMsg] = useState<string | null>(null);

  const done = (saved: boolean) => {
    if (saved && from && to) { setCommute({ from, to, time, mode: 'by', priority: 'all' }); setHomeStation(from); }
    finishOnboarding();
    track('onboarding_done', { lang, has_commute: saved });
    setRiderProperty('has_commute', saved ? 'yes' : 'no');
    if (router.canGoBack()) router.back(); else router.replace('/(tabs)/(home)');
  };

  const useLocation = async () => {
    setLocMsg(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') { setLocMsg(t('loc_fail')); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      if ((pos.coords.accuracy ?? 9999) > 1500) { setLocMsg(t('loc_rough')); return; }
      const code = nearestStation(tt, pos.coords.latitude, pos.coords.longitude);
      if (code) { setFrom(code); setLocMsg(t('nearest', { s: stationName(tt, code, lang) })); }
    } catch { setLocMsg(t('loc_fail')); }
  };

  const timeDate = (() => { const d = new Date(); const [h, m] = time.split(':').map(Number); d.setHours(h, m, 0, 0); return d; })();

  return (
    <View style={{ flex: 1, backgroundColor: c.bg, paddingTop: insets.top + space.xl }}>
      <ScrollView contentContainerStyle={{ padding: space.l, gap: space.xl, paddingBottom: insets.bottom + space.xl }} keyboardShouldPersistTaps="handled">
        <View style={{ gap: space.s }}>
          <Image source={require('@/assets/images/icon.png')} style={s.logo} accessibilityIgnoresInvertColors />
          <T v="large">KnowMyMetro</T>
          <T v="body" color={c.ink2}>{t('setup_sub')}</T>
        </View>

        {step === 'lang' ? (
          <>
            <T v="title">{t('onb_lang')}</T>
            <Card padded={false}>
              {LANGS.map(([code, name], i) => (
                <Tap key={code} onPress={() => { setLang(code as Lang); setRiderProperty('lang', code); }} style={[s.langRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }]} accessibilityRole="radio" accessibilityState={{ checked: lang === code }}>
                  <T v="headline" style={{ fontSize: 19 }}>{name}</T>
                  {lang === code ? <T v="headline" color={c.tint}>✓</T> : null}
                </Tap>
              ))}
            </Card>
            <Button label={t('cont')} onPress={() => setStep('commute')} />
          </>
        ) : (
          <>
            <T v="title">{t('setup_title')}</T>
            <Card padded={false}>
              <Tap onPress={() => setPicking('from')} style={s.field}>
                <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{t('from')}</T>
                <T v="headline" color={from ? c.ink : c.ink3}>{from ? stationName(tt, from, lang) : t('choose_station')}</T>
              </Tap>
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.sep, marginLeft: space.l }} />
              <Tap onPress={() => setPicking('to')} style={s.field}>
                <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{t('to')}</T>
                <T v="headline" color={to ? c.ink : c.ink3}>{to ? stationName(tt, to, lang) : t('choose_station')}</T>
              </Tap>
            </Card>
            <Tap onPress={useLocation}><T v="sub" color={c.tint} style={{ fontWeight: '600' }}>◎ {t('use_loc')}</T></Tap>
            {locMsg ? <Notice text={locMsg} /> : null}
            <Card style={{ gap: space.s }}>
              <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{t('arr_lbl')}</T>
              <DateTimePicker value={timeDate} mode="time" display={Platform.OS === 'ios' ? 'spinner' : 'default'} minuteInterval={5}
                onChange={(_, d) => { if (d) setTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`); }} />
            </Card>
            <Button label={t('save_trip')} disabled={!from || !to || from === to} onPress={() => done(true)} />
            <Tap onPress={() => done(false)} style={{ alignItems: 'center', padding: space.s }}><T v="sub" color={c.ink2}>{t('skip')}</T></Tap>
          </>
        )}
      </ScrollView>
      <StationPicker visible={picking !== null} title={picking === 'from' ? t('from') : t('to')} onClose={() => setPicking(null)}
        onPick={(code) => { if (picking === 'from') setFrom(code); else setTo(code); setPicking(null); }} />
    </View>
  );
}

const s = StyleSheet.create({
  logo: { width: 60, height: 60, borderRadius: 14, marginBottom: space.s },
  langRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 16, paddingHorizontal: space.l },
  field: { paddingVertical: space.m, paddingHorizontal: space.l, gap: 2 },
});
