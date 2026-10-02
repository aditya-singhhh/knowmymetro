import { router, Stack } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { departuresAt, fmt, secondsNow, serviceFor, stationName, type PlanOption } from '@kmm/shared';
import { useApp, useNow } from '@/core/app-state';
import { commuteDayOffset, dayFromToday } from '@/core/days';
import { useStationHere } from '@/core/here';
import { buildRequest, prefetchCommute, usePlan } from '@/core/planner';
import { putTrip } from '@/core/trip-store';
import { Button, Card, Chevron, CoachStrip, Notice, SeatBadge, SectionHeader, Screen, Skeleton, T, Tap, TrainChain } from '@/ui/components';
import { space, type, useTheme } from '@/ui/theme';
import { coachWords } from '@/ui/trip-view';

export default function Home() {
  const app = useApp();
  const { t, tt, lang, commute, prefs, homeStation } = app;
  const { c } = useTheme();
  const now = useNow();
  const h = now.getHours();
  const greet = h < 4 ? t('greet_n') : h < 12 ? t('greet_m') : h < 17 ? t('greet_a') : t('greet_e');

  const offset = commute ? commuteDayOffset(commute.time, now) : 0;
  const req = useMemo(() => (commute ? buildRequest(commute, dayFromToday(offset), prefs) : null), [commute, offset, prefs]);
  const plan = usePlan(req);
  useEffect(() => { if (commute) prefetchCommute(commute, prefs); }, [commute, prefs]);
  // refresh "where am I" every few minutes while the app is open (useNow ticks every 30 s)
  const { code: here, allowed, ask } = useStationHere(tt, Math.floor(now.getTime() / 180000));
  const nextAt = here ?? homeStation;
  const awayFromCommute = !!here && here !== commute?.from;

  return (
    <>
      <Stack.Screen options={{
        title: greet,
        headerRight: () => <Tap onPress={() => router.push('/settings')} hitSlop={12} accessibilityLabel={t('settings')}><T v="headline" color={c.tint}>{t('settings')}</T></Tap>,
      }} />
      <Screen>
        <Tap onPress={() => router.navigate({ pathname: '/(tabs)/(plan)', params: { pick: 'to', at: String(Date.now()), ...(here ? { from: here } : {}) } })} style={[s.search, { backgroundColor: c.card }]} accessibilityRole="search">
          <T v="body" color={c.ink3}>⌕</T>
          <View style={{ flex: 1 }}>
            <T v="body" color={c.ink2} style={{ fontSize: 17 }}>{t('where')}</T>
            {here ? <T v="caption" color={c.tint} style={{ fontWeight: '500' }}>{t('from')} {stationName(tt, here, lang)} · {t('near_you')}</T> : null}
          </View>
        </Tap>
        {allowed === false ? (
          <Tap onPress={ask} style={{ paddingHorizontal: space.xs, marginTop: -space.s }}>
            <T v="sub" color={c.tint} style={{ fontWeight: '600' }}>◎ {t('use_loc')}</T>
          </Tap>
        ) : null}

        {awayFromCommute && nextAt ? <NextTrains code={nextAt} now={now} /> : null}

        {commute ? (
          <View style={{ gap: space.m }}>
            <SectionHeader title={offset === 0 ? t('c_today') : offset === 1 ? t('c_tom') : t('c_day', { d: dayFromToday(offset).toLocaleDateString(app.locale, { weekday: 'long' }) })} action={t('edit')} onAction={() => router.navigate({ pathname: '/(tabs)/(plan)', params: { edit: 'commute', at: String(Date.now()) } })} />
            {plan.data || plan.loading ? <CommuteCard option={plan.data && plan.data.best >= 0 ? plan.data.options[plan.data.best] : null} loading={plan.loading && !plan.data} offset={offset} now={now} /> : null}
            {plan.error && plan.data ? <Notice text={t('offline')} /> : null}
            {plan.error && !plan.data ? <Card><T v="sub" color={c.ink2}>{t('err_net')}</T><View style={{ height: space.m }} /><Button label={t('retry')} kind="plain" onPress={plan.retry} /></Card> : null}
            {plan.data?.error ? <Notice text={plan.data.error === 'none-in-time' ? t('no_trains', { s: stationName(tt, commute.to, lang), t: commute.time, a: plan.data.earliestArrival ? fmt(plan.data.earliestArrival) : '—' }) : t('pick_two')} tone="bad" /> : null}
          </View>
        ) : (
          <Card style={{ gap: space.m }}>
            <T v="title">{t('setup_title')}</T>
            <T v="sub" color={c.ink2}>{t('setup_sub')}</T>
            <Button label={t('save_trip')} onPress={() => router.push('/onboarding?step=commute')} />
          </Card>
        )}

        {!awayFromCommute && nextAt ? <NextTrains code={nextAt} now={now} /> : null}

        <T v="caption" color={c.ink3} style={{ textAlign: 'center', fontWeight: '400', lineHeight: 17 }}>{t('fine')}</T>
      </Screen>
    </>
  );
}

function CommuteCard({ option, loading, offset, now }: { option: PlanOption | null; loading: boolean; offset: number; now: Date }) {
  const app = useApp();
  const { t, tt, lang, commute } = app;
  const { c } = useTheme();
  if (loading || !option || !commute) {
    return (
      <Card style={{ gap: space.m }}>
        <Skeleton height={14} width="45%" />
        <Skeleton height={48} width="55%" />
        <View style={{ flexDirection: 'row', gap: 8 }}><Skeleton height={30} width={86} /><Skeleton height={30} width={86} /></View>
        <T v="caption" color={c.ink3}>{t('loading')}</T>
      </Card>
    );
  }
  const left = option.dep - secondsNow(now);
  const when = offset > 0 ? dayFromToday(offset).toLocaleDateString(app.locale, { weekday: 'long' }) : left <= 0 ? t('leave_now') : t('in_x', { x: left >= 3600 ? `${Math.floor(left / 3600)} ${t('h')} ${Math.round((left % 3600) / 60)} ${t('min')}` : `${Math.round(left / 60)} ${t('min')}` });
  const ci = option.changes.findIndex((x) => x.coaches.length);
  return (
    <Tap onPress={() => router.push({ pathname: '/(tabs)/(home)/trip', params: { id: putTrip(option, offset) } })} accessibilityRole="button">
      <Card style={{ gap: space.m }}>
        <T v="sub" color={c.ink2} style={{ fontWeight: '500' }}>{stationName(tt, commute.from, lang)}  ›  {stationName(tt, commute.to, lang)}</T>
        <View style={s.row}>
          <View>
            <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('board_at', { s: stationName(tt, option.legs[0].from, lang) })}</T>
            <T v="clock">{fmt(option.dep)}</T>
            <T v="sub" color={c.tint} style={{ fontWeight: '700', marginTop: 2 }}>{when}</T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('reach')}</T>
            <T v="title" style={[type.time, { fontSize: 24 }]}>{fmt(option.arr)}</T>
          </View>
        </View>
        <TrainChain legs={option.legs} arr={option.arr} />
        <View style={s.badges}>{option.legs.map((l, i) => <SeatBadge key={i} seat={l.seat} />)}</View>
        {option.trick || ci >= 0 ? (
          <View style={[s.coachLine, { borderTopColor: c.sep }]}>
            <View style={{ flex: 1 }}>
              {option.trick ? (
                <><T v="headline">{t('trick')}</T><T v="sub" color={c.ink2}>{t(option.trick.kind === 'wait' ? 'trick_card_wait' : 'trick_card_rev', { s: stationName(tt, option.trick.at, lang) })}</T></>
              ) : (
                <><T v="headline">{t('board_coach', { c: coachWords(option.changes[ci].coaches, t('or'), t) })}</T><T v="sub" color={c.ink2}>{t(option.changes[ci].tight ? 'tight_change' : 'quick_change', { s: stationName(tt, option.changes[ci].at, lang) })}</T></>
              )}
            </View>
            {ci >= 0 ? <CoachStrip coaches={option.changes[ci].coaches} line={option.legs[ci].line} /> : <Chevron />}
          </View>
        ) : null}
      </Card>
    </Tap>
  );
}

function NextTrains({ code, now }: { code: string; now: Date }) {
  const { tt, t, lang } = useApp();
  const th = useTheme();
  const { c } = th;
  let groups = departuresAt(tt, code, serviceFor(tt, now) ?? 'weekday', secondsNow(now), 2);
  let tomorrow = false;
  if (!groups.some((g) => g.rows.length)) {
    tomorrow = true;
    groups = departuresAt(tt, code, serviceFor(tt, dayFromToday(1)) ?? 'weekday', 0, 2);
  }
  return (
    <View style={{ gap: space.m }}>
      <SectionHeader title={t('next_at', { s: stationName(tt, code, lang) })} action={t('see_all')} onAction={() => router.navigate({ pathname: '/(tabs)/(stations)/station/[code]', params: { code } })} />
      <Card padded={false}>
        {tomorrow ? <T v="sub" color={c.ink2} style={{ padding: space.l, paddingBottom: 0 }}>{t('no_more')}</T> : null}
        {groups.filter((g) => g.rows.length).map((g) => (
          <View key={g.line + g.dir} style={{ paddingTop: space.s }}>
            <View style={s.dirHead}>
              <View style={[s.sq, { backgroundColor: th.line(g.line) }]} />
              <T v="caption" color={c.ink2}>{t('towards', { s: stationName(tt, g.towards, lang) })}{g.via ? `, ${t('via', { s: stationName(tt, g.via, lang) })}` : ''}</T>
            </View>
            {g.rows.map((r, i) => {
              const wait = r.dep - secondsNow(now);
              return (
                <View key={i} style={[s.dep, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep }]}>
                  <View style={[s.bar, { backgroundColor: th.line(r.line) }]} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <T v="headline" numberOfLines={1}>{stationName(tt, r.terminus, lang)}</T>
                    <SeatBadge seat={r.seat} />
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    {!tomorrow && wait < 3600 ? (
                      <><T v="title" style={type.time}>{Math.max(0, Math.round(wait / 60))}</T><T v="caption" color={c.ink2}>{t('min')}</T></>
                    ) : <T v="title" style={type.time}>{fmt(r.dep)}</T>}
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </Card>
    </View>
  );
}

const s = StyleSheet.create({
  search: { minHeight: 50, paddingVertical: 8, borderRadius: 14, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  badges: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  coachLine: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingTop: space.m, borderTopWidth: StyleSheet.hairlineWidth },
  dirHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: space.l, paddingBottom: 4 },
  sq: { width: 10, height: 10, borderRadius: 3 },
  dep: { flexDirection: 'row', alignItems: 'center', gap: space.m, paddingVertical: space.m, marginHorizontal: space.l },
  bar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
});
