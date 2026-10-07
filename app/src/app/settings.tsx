import * as Application from 'expo-application';
import { router, Stack } from 'expo-router';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { LANGS, type Lang, type Pace } from '@kmm/shared';
import { setRiderProperty, track } from '@/core/analytics';
import { useApp } from '@/core/app-state';
import { allowNotifications } from '@/core/notify';
import { Card, Screen, Segmented, T, Tap } from '@/ui/components';
import { space, useTheme } from '@/ui/theme';

export default function Settings() {
  const { t, lang, setLang, prefs, setPrefs, tt } = useApp();
  // 7 taps on the timetable version: developer tools on/off (not advertised)
  const [taps, setTaps] = useState(0);
  const devTap = () => { const n = taps + 1; setTaps(n >= 7 ? 0 : n); if (n >= 7) setPrefs({ dev: !prefs.dev }); };
  const { c } = useTheme();
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);

  const checkUpdates = async () => {
    if (__DEV__ || !Updates.isEnabled) { setUpdateMsg(t('up_to_date')); return; }
    try {
      const r = await Updates.checkForUpdateAsync();
      if (!r.isAvailable) { setUpdateMsg(t('up_to_date')); return; }
      await Updates.fetchUpdateAsync();
      setUpdateMsg(t('update_ready'));
      await Updates.reloadAsync();
    } catch { setUpdateMsg(t('err_net')); }
  };

  return (
    <>
      <Stack.Screen options={{ title: t('settings') }} />
      <Screen>
        <View style={{ gap: space.s, marginTop: space.l }}>
          <T v="caption" color={c.ink2} style={s.label}>{t('language')}</T>
          <Card padded={false}>
            {LANGS.map(([code, name], i) => (
              <Tap key={code} onPress={() => { setLang(code as Lang); setRiderProperty('lang', code); track('language_changed', { lang: code }); }}
                style={[s.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }]}>
                <T v="body">{name}</T>
                {lang === code ? <T v="headline" color={c.tint}>✓</T> : null}
              </Tap>
            ))}
          </Card>
        </View>

        <View style={{ gap: space.s }}>
          <T v="caption" color={c.ink2} style={s.label}>{t('pace')}</T>
          <Segmented<Pace> value={prefs.pace} onChange={(p) => setPrefs({ pace: p })} options={[{ value: 'fast', label: t('p_fast') }, { value: 'normal', label: t('p_normal') }, { value: 'slow', label: t('p_slow') }]} />
          <Card style={s.switchRow}>
            <View style={{ flex: 1 }}><T v="body">{t('women_coach')}</T><T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('women_sub')}</T></View>
            <Switch value={prefs.women} onValueChange={(v) => setPrefs({ women: v })} trackColor={{ true: c.ok }} />
          </Card>
        </View>

        <View style={{ gap: space.s }}>
          <T v="caption" color={c.ink2} style={s.label}>{t('remind')}</T>
          <Segmented<'0' | '5' | '10' | '15'> value={String(prefs.remind ?? 0) as '0'}
            onChange={async (v) => { const m = Number(v); if (m > 0 && !(await allowNotifications())) return; setPrefs({ remind: m }); track('reminder_set', { minutes: m }); }}
            options={[{ value: '0', label: t('off') }, { value: '5', label: `5 ${t('min')}` }, { value: '10', label: `10 ${t('min')}` }, { value: '15', label: `15 ${t('min')}` }]} />
        </View>

        {prefs.dev ? (
          <View style={{ gap: space.s }}>
            <T v="caption" color={c.ink2} style={s.label}>Developer</T>
            <Card padded={false}>
              <Tap onPress={() => { router.back(); router.push('/recorder'); }} style={s.row}>
                <View style={{ flex: 1 }}><T v="body">Trip recorder</T><T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>Record GPS, towers and motion on your ride to improve live tracking</T></View>
                <T v="headline" color={c.ink3}>›</T>
              </Tap>
            </Card>
          </View>
        ) : null}

        <View style={{ gap: space.s }}>
          <T v="caption" color={c.ink2} style={s.label}>{t('about')}</T>
          <Card padded={false}>
            <View style={s.row}><T v="body">{t('version', { v: `${Application.nativeApplicationVersion ?? '1.0.0'} (${Application.nativeBuildVersion ?? 'dev'})` })}</T></View>
            <Tap onPress={devTap} style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }]}><T v="body">{t('timetable_v', { v: tt.version })}</T></Tap>
            <Tap onPress={checkUpdates} style={[s.row, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }]}>
              <T v="body" color={c.tint}>{t('check_updates')}</T>
              {updateMsg ? <T v="caption" color={c.ink2}>{updateMsg}</T> : null}
            </Tap>
          </Card>
          <T v="caption" color={c.ink3} style={{ fontWeight: '400', lineHeight: 17, paddingHorizontal: space.xs }}>{t('privacy_note')}</T>
          <T v="caption" color={c.ink3} style={{ fontWeight: '400', lineHeight: 17, paddingHorizontal: space.xs }}>{t('fine')}</T>
        </View>
      </Screen>
    </>
  );
}

const s = StyleSheet.create({
  label: { paddingHorizontal: space.xs, fontWeight: '500' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, paddingHorizontal: space.l, gap: space.m },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
});
