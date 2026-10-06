import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { departuresAt, fmt, lineOrigins, linesOf, secondsNow, serviceFor, stationName } from '@kmm/shared';
import { track } from '@/core/analytics';
import { useApp, useNow } from '@/core/app-state';
import { dayFromToday } from '@/core/days';
import { tripFromDeparture } from '@/core/departure';
import { putTrip } from '@/core/trip-store';
import { Card, SeatBadge, SectionHeader, Screen, T, Tap } from '@/ui/components';
import { space, type, useTheme } from '@/ui/theme';

const LINE_KEY = { PURPLE: 'P', GREEN: 'G', YELLOW: 'Y' } as const;

export default function StationDetail() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { tt, t, lang, homeStation, setHomeStation } = useApp();
  const th = useTheme();
  const { c } = th;
  const now = useNow();
  useEffect(() => { if (code) track('station_open', { code }); }, [code]);
  if (!code || !tt.stations[code]) return null;

  const lines = linesOf(tt, code);
  const origins = lineOrigins(tt);
  const hub = lines.some((L) => origins[L]?.has(code));
  let groups = departuresAt(tt, code, serviceFor(tt, now) ?? 'weekday', secondsNow(now), 5);
  let tomorrow = false;
  if (!groups.some((g) => g.rows.length)) { tomorrow = true; groups = departuresAt(tt, code, serviceFor(tt, dayFromToday(1)) ?? 'weekday', 0, 5); }
  const svc = serviceFor(tt, tomorrow ? dayFromToday(1) : now);
  const work = svc === 'weekday' || svc === 'monday';
  const s0 = tt.stations[code];

  return (
    <>
      <Stack.Screen options={{ title: stationName(tt, code, lang) }} />
      <Screen>
        <Card style={{ gap: space.m }}>
          {s0.full !== s0.en ? <T v="sub" color={c.ink2}>{s0.full}</T> : null}
          {s0.kn && lang !== 'kn' ? <T v="sub" color={c.ink2}>{s0.kn}</T> : null}
          <View style={s.pills}>
            {lines.map((L) => (
              <View key={L} style={[s.pill, { backgroundColor: th.line(L) }]}><T v="sub" color={th.lineText(L)} style={{ fontWeight: '700' }}>{t(LINE_KEY[L as keyof typeof LINE_KEY])}</T></View>
            ))}
          </View>
          {hub ? <View style={[s.hub, { backgroundColor: c.okBg }]}><T v="sub" color={c.ok} style={{ fontWeight: '600' }}>{t('st_hub')}</T></View> : null}
        </Card>

        <View style={s.actions}>
          <Action label={t('plan_from')} onPress={() => router.navigate({ pathname: '/(tabs)/(plan)', params: { from: code } })} />
          <Action label={t('plan_to')} onPress={() => router.navigate({ pathname: '/(tabs)/(plan)', params: { to: code } })} />
          <Action label={code === homeStation ? `★ ${t('tab_home')}` : t('set_home')} on={code === homeStation} onPress={() => setHomeStation(code)} />
        </View>

        <SectionHeader title={t('next_at', { s: stationName(tt, code, lang) })} />
        <Card padded={false}>
          {tomorrow ? <T v="sub" color={c.ink2} style={{ padding: space.l, paddingBottom: 0 }}>{t('no_more')}</T> : null}
          {groups.filter((g) => g.rows.length).map((g) => (
            <View key={g.line + g.dir} style={{ paddingTop: space.m }}>
              <View style={s.dirHead}>
                <View style={[s.sq, { backgroundColor: th.line(g.line) }]} />
                <T v="caption" color={c.ink2}>{t('towards', { s: stationName(tt, g.towards, lang) })}{g.via ? `, ${t('via', { s: stationName(tt, g.via, lang) })}` : ''}</T>
              </View>
              {g.rows.map((r, i) => {
                const wait = r.dep - secondsNow(now);
                return (
                  <Tap key={i} onPress={() => router.push({ pathname: '/(tabs)/(stations)/trip', params: { id: putTrip(tripFromDeparture(tt, r, work), tomorrow ? 1 : 0) } })}
                    style={[s.dep, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }]}>
                    <View style={[s.bar, { backgroundColor: th.line(r.line) }]} />
                    <View style={{ flex: 1, gap: 3 }}>
                      <T v="headline" numberOfLines={1}>{stationName(tt, r.terminus, lang)}</T>
                      <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{r.before === 0 ? t('starts_here') : t('from_s', { s: stationName(tt, r.origin, lang) })}{r.platform ? ` · ${t('platform', { p: r.platform })}` : ''}</T>
                      <SeatBadge seat={r.seat} />
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <T v="title" style={type.time}>{fmt(r.dep)}</T>
                      {!tomorrow && wait < 3600 ? <T v="caption" color={c.tint}>{t('in_x', { x: `${Math.max(0, Math.round(wait / 60))} ${t('min')}` })}</T> : null}
                    </View>
                  </Tap>
                );
              })}
            </View>
          ))}
        </Card>
      </Screen>
    </>
  );
}

function Action({ label, onPress, on }: { label: string; onPress: () => void; on?: boolean }) {
  const { c } = useTheme();
  return (
    <Tap onPress={onPress} style={[s.action, { backgroundColor: on ? c.tintBg : c.card }]}>
      <T v="sub" color={c.tint} style={{ fontWeight: '700', textAlign: 'center' }}>{label}</T>
    </Tap>
  );
}

const s = StyleSheet.create({
  pills: { flexDirection: 'row', gap: space.s, flexWrap: 'wrap' },
  pill: { borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 },
  hub: { borderRadius: 10, padding: space.m },
  actions: { flexDirection: 'row', gap: space.s },
  action: { flex: 1, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 6, justifyContent: 'center' },
  dirHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.l, paddingBottom: 4 },
  sq: { width: 10, height: 10, borderRadius: 3 },
  dep: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, marginHorizontal: space.l },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
});
