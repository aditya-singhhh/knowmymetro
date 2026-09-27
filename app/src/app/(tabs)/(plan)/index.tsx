import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { fmt, mins, pad2, stationName, ymd, type Pace, type PlanOption, type PlanRequest, type Priority, type TimeMode } from '@kmm/shared';
import { track } from '@/core/analytics';
import { useApp } from '@/core/app-state';
import { commuteDayOffset, dayFromToday } from '@/core/days';
import { usePlan } from '@/core/planner';
import { putTrip } from '@/core/trip-store';
import { Button, Card, Notice, Screen, SeatBadge, Segmented, Skeleton, T, Tap, TrainChain } from '@/ui/components';
import { StationPicker } from '@/ui/station-picker';
import { radius, space, type, useTheme } from '@/ui/theme';

export default function Plan() {
  const app = useApp();
  const { t, tt, lang, commute, prefs, setPrefs, homeStation, setCommute, locale } = app;
  const { c } = useTheme();
  const params = useLocalSearchParams<{ pick?: string; from?: string; to?: string }>();

  const [from, setFrom] = useState(commute?.from ?? homeStation ?? 'KGWA');
  const [to, setTo] = useState(commute?.to ?? '');
  const [mode, setMode] = useState<TimeMode>(commute?.mode ?? 'by');
  const [time, setTime] = useState(commute?.time ?? '09:30');
  const [priority, setPriority] = useState<Priority>(commute?.priority ?? 'all');
  const [day, setDay] = useState(() => (commute ? commuteDayOffset(commute.time) : 0));
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [showTime, setShowTime] = useState(false);
  const [more, setMore] = useState(false);

  // deep links: "Where to?" on Home, and "Plan from/to here" on a station
  useEffect(() => {
    if (params.from) setFrom(params.from);
    if (params.to) setTo(params.to);
    if (params.from || params.to) { setMode('after'); setTime(nowHHMM()); setDay(0); }
    if (params.pick === 'to') { setMode('after'); setTime(nowHHMM()); setDay(0); setPicking('to'); }
  }, [params.pick, params.from, params.to]);

  const req = useMemo<PlanRequest | null>(() => (from && to && from !== to
    ? { from, to, date: ymd(dayFromToday(day)), time, mode, priority, pace: prefs.pace, women: prefs.women } : null),
  [from, to, day, time, mode, priority, prefs]);
  const plan = usePlan(req);
  useEffect(() => { if (req) track('plan_search', { from: req.from, to: req.to, mode: req.mode, priority: req.priority, time: req.time }); }, [req]);
  useEffect(() => {
    if (plan.data && !plan.loading) track('plan_result', { options: plan.data.options.length, seat_all: !!plan.data.options[plan.data.best]?.seatAllTheWay, fallback: !!plan.data.fallback, error: plan.data.error ?? 'none' });
  }, [plan.data, plan.loading]);

  const isCommute = !!commute && commute.from === from && commute.to === to && commute.time === time && commute.mode === mode && commute.priority === priority;
  const options = plan.data?.options ?? [];
  const best = plan.data && plan.data.best >= 0 ? options[plan.data.best] : null;
  const ordered = best ? [best, ...options.filter((o) => o !== best).sort((a, b) => b.dep - a.dep)] : [];

  const onTime = (e: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS !== 'ios') setShowTime(false);
    if (e.type === 'set' && d) setTime(`${pad2(d.getHours())}:${pad2(d.getMinutes())}`);
  };
  const timeDate = (() => { const d = new Date(); const [h, m] = time.split(':').map(Number); d.setHours(h, m, 0, 0); return d; })();

  return (
    <>
      <Stack.Screen options={{ title: t('tab_plan') }} />
      <Screen>
        <Card padded={false}>
          <View style={s.od}>
            <View style={s.rail}>
              <View style={[s.ring, { borderColor: c.ink2 }]} />
              <View style={[s.dash, { borderColor: c.ink3 }]} />
              <View style={[s.sq, { backgroundColor: c.tint }]} />
            </View>
            <View style={{ flex: 1 }}>
              <Tap onPress={() => setPicking('from')} style={s.field}>
                <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{t('from')}</T>
                <T v="headline">{from ? stationName(tt, from, lang) : t('choose_station')}</T>
              </Tap>
              <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.sep }} />
              <Tap onPress={() => setPicking('to')} style={s.field}>
                <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{t('to')}</T>
                <T v="headline" color={to ? c.ink : c.ink3}>{to ? stationName(tt, to, lang) : t('choose_station')}</T>
              </Tap>
            </View>
            <Tap onPress={() => { setFrom(to || from); setTo(from); }} style={[s.swap, { backgroundColor: c.fill }]} accessibilityLabel="Swap">
              <T v="headline">⇅</T>
            </Tap>
          </View>

          <View style={[s.controls, { borderTopColor: c.sep }]}>
            <View style={{ flexDirection: 'row', gap: space.s }}>
              <View style={{ flex: 1 }}>
                <Segmented value={mode} onChange={setMode} options={[{ value: 'by', label: t('arr_lbl') }, { value: 'after', label: t('lv_lbl') }]} />
              </View>
              <Tap onPress={() => setShowTime((v) => !v)} style={[s.timeBtn, { backgroundColor: c.fill }]}>
                <T v="headline" style={type.time}>{time}</T>
              </Tap>
            </View>
            {showTime ? (
              <DateTimePicker value={timeDate} mode="time" display={Platform.OS === 'ios' ? 'spinner' : 'default'} onChange={onTime} minuteInterval={5} />
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
              {Array.from({ length: 7 }, (_, i) => {
                const d = dayFromToday(i), on = i === day;
                return (
                  <Tap key={i} onPress={() => setDay(i)} style={[s.day, { backgroundColor: on ? c.tint : c.fill }]}>
                    <T v="caption" color={on ? c.onTint : c.ink2}>{i === 0 ? t('today') : i === 1 ? t('tomorrow') : d.toLocaleDateString(locale, { weekday: 'short' })}</T>
                    <T v="headline" color={on ? c.onTint : c.ink}>{d.getDate()}</T>
                  </Tap>
                );
              })}
            </ScrollView>
            <Segmented value={priority} onChange={setPriority} options={[{ value: 'fast', label: t('fast') }, { value: 'long', label: t('pr_long') }, { value: 'all', label: t('all') }]} />
            <Tap onPress={() => setMore((v) => !v)} haptic={false}><T v="sub" color={c.tint} style={{ fontWeight: '600' }}>{t('more_opts')} {more ? '▴' : '▾'}</T></Tap>
            {more ? (
              <View style={{ gap: space.m }}>
                <T v="caption" color={c.ink2} style={{ fontWeight: '500' }}>{t('pace')}</T>
                <Segmented<Pace> value={prefs.pace} onChange={(p) => setPrefs({ pace: p })} options={[{ value: 'fast', label: t('p_fast') }, { value: 'normal', label: t('p_normal') }, { value: 'slow', label: t('p_slow') }]} />
                <View style={s.switchRow}>
                  <View style={{ flex: 1 }}><T v="body">{t('women_coach')}</T><T v="caption" color={c.ink2} style={{ fontWeight: '400' }}>{t('women_sub')}</T></View>
                  <Switch value={prefs.women} onValueChange={(v) => setPrefs({ women: v })} trackColor={{ true: c.ok }} />
                </View>
                <Button kind="plain" label={isCommute ? t('saved_s') : t('save_commute')} disabled={!req || isCommute}
                  onPress={() => { setCommute({ from, to, time, mode, priority }); track('commute_saved', { from, to, priority }); router.navigate('/(tabs)/(home)'); }} />
              </View>
            ) : null}
          </View>
        </Card>

        {!req ? null : plan.loading && !plan.data ? (
          <View style={{ gap: space.m }}>{[0, 1, 2].map((i) => <Card key={i} style={{ gap: space.m }}><Skeleton height={20} width="50%" /><Skeleton height={30} width="70%" /><Skeleton height={20} width="40%" /></Card>)}</View>
        ) : plan.error && !plan.data ? (
          <Card style={{ gap: space.m }}><T v="sub" color={c.ink2}>{t('err_net')}</T><Button kind="plain" label={t('retry')} onPress={plan.retry} /></Card>
        ) : plan.data?.error ? (
          <Notice tone="bad" text={plan.data.error === 'none-in-time' ? t('no_trains', { s: stationName(tt, to, lang), t: time, a: plan.data.earliestArrival ? fmt(plan.data.earliestArrival) : '—' }) : t('pick_two')} />
        ) : plan.data ? (
          <View style={{ gap: space.m }}>
            {plan.error ? <Notice text={t('offline')} /> : null}
            {plan.data.fallback ? (
              <Notice text={`${t(plan.data.fallback.achieved === 'fast' ? 'fb_fast' : 'fb_long', { when: mode === 'by' ? t('by_t', { t: time }) : t('in_2h') })}${plan.data.fallback.seatedArrival ? ' ' + t('seat_if_late', { t: fmt(plan.data.fallback.seatedArrival) }) : ''}`} />
            ) : null}
            {plan.data.tradeoff ? (
              <T v="sub" color={c.ink2} style={{ paddingHorizontal: space.xs }}>
                {plan.data.tradeoff.extraMinutes > 0 ? t(mode === 'by' ? 'trade_by' : 'trade_after', { e: plan.data.tradeoff.extraMinutes, s: plan.data.tradeoff.standingSaved }) : t('trade_free')}
              </T>
            ) : null}
            {ordered.map((o, i) => <OptionCard key={i} option={o} best={i === 0} onPress={() => router.push({ pathname: '/(tabs)/(plan)/trip', params: { id: putTrip(o, day) } })} />)}
          </View>
        ) : null}
      </Screen>
      <StationPicker visible={picking !== null} title={picking === 'from' ? t('from') : t('to')} onClose={() => setPicking(null)}
        onPick={(code) => { if (picking === 'from') setFrom(code); else setTo(code); setPicking(null); }} />
    </>
  );
}

function OptionCard({ option, best, onPress }: { option: PlanOption; best: boolean; onPress: () => void }) {
  const { t, tt, lang } = useApp();
  const { c } = useTheme();
  const seated = option.legs.filter((l) => l.seat >= 2);
  const summary = option.seatAllTheWay ? { seat: 2 as const, text: t('all') }
    : seated.length ? { seat: 2 as const, text: t('sum_some', { x: seated.map((l) => t(l.line === 'GREEN' ? 'G' : l.line === 'PURPLE' ? 'P' : 'Y')).join(', ') }) }
      : option.legs.some((l) => l.seat === 0) ? { seat: 0 as const, text: t('sum_none') } : { seat: 1 as const, text: t('maybe_seats') };
  const ch = option.changes[0];
  return (
    <Tap onPress={onPress}>
      <Card style={{ gap: space.m }}>
        <View style={s.optHead}>
          <T v="title" style={type.time}>{fmt(option.dep)} – {fmt(option.arr)}</T>
          {best ? <View style={[s.tag, { backgroundColor: c.tintBg }]}><T v="caption" color={c.tint}>{t('best')}</T></View> : <T v="sub" color={c.ink2}>{mins(option.arr - option.dep)} {t('min')}</T>}
        </View>
        <TrainChain legs={option.legs} arr={option.arr} />
        <View style={s.optFoot}>
          <SeatBadge seat={summary.seat} label={summary.text} />
          {ch && !option.trick ? <T v="caption" color={ch.tight ? c.bad : c.ink2} style={{ fontWeight: ch.tight ? '700' : '400' }}>{t('wait_at', { n: mins(ch.available), s: stationName(tt, ch.at, lang) })}</T> : null}
        </View>
        {option.trick ? (
          <View style={s.optFoot}>
            <View style={[s.tag, { backgroundColor: c.tintBg }]}><T v="caption" color={c.tint}>{t('trick')}</T></View>
            <T v="caption" style={{ flex: 1, fontWeight: '400' }}>{t(option.trick.kind === 'wait' ? 'trick_card_wait' : 'trick_card_rev', { s: stationName(tt, option.trick.at, lang) })}</T>
          </View>
        ) : null}
      </Card>
    </Tap>
  );
}

const nowHHMM = () => { const d = new Date(); const m = Math.ceil(d.getMinutes() / 5) * 5; d.setMinutes(m); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

const s = StyleSheet.create({
  od: { flexDirection: 'row', alignItems: 'center', paddingLeft: space.l, paddingRight: space.m, gap: space.m },
  rail: { alignItems: 'center', alignSelf: 'stretch', paddingVertical: 26 },
  ring: { width: 11, height: 11, borderRadius: 6, borderWidth: 2.5 },
  dash: { flex: 1, borderLeftWidth: 2, borderStyle: 'dashed', marginVertical: 3 },
  sq: { width: 11, height: 11, borderRadius: 3 },
  field: { paddingVertical: space.m, gap: 2 },
  swap: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  controls: { padding: space.l, gap: space.m, borderTopWidth: StyleSheet.hairlineWidth },
  timeBtn: { borderRadius: 10, paddingHorizontal: space.l, justifyContent: 'center' },
  day: { borderRadius: radius.m, paddingVertical: 8, paddingHorizontal: 12, alignItems: 'center', minWidth: 58 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.m },
  optHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  optFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.s },
  tag: { borderRadius: 6, paddingVertical: 3, paddingHorizontal: 8 },
});
