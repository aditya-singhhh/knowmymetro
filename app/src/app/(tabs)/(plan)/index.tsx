import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { fmt, mins, pad2, secondsNow, stationName, ymd, type Pace, type PlanOption, type PlanRequest, type Priority, type TimeMode } from '@kmm/shared';
import { track } from '@/core/analytics';
import { useApp, useNow } from '@/core/app-state';
import { commuteDayOffset, dayFromToday } from '@/core/days';
import { getTrainDelay } from '@/core/firebase';
import { stationHere } from '@/core/here';
import { usePlan } from '@/core/planner';
import { load, save } from '@/core/storage';
import { putTrip } from '@/core/trip-store';
import { Button, Card, CoachStrip, Notice, Screen, SeatBadge, Segmented, Skeleton, T, Tap, TrainChain } from '@/ui/components';
import { coachWords } from '@/ui/trip-view';
import { StationPicker } from '@/ui/station-picker';
import { radius, space, type, useTheme } from '@/ui/theme';

type Mode = 'now' | TimeMode;
interface Recent { from: string; to: string }
const RECENT_KEY = 'recentTrips';

export default function Plan() {
  const app = useApp();
  const { t, tt, lang, commute, prefs, setPrefs, homeStation, setCommute, locale } = app;
  const { c } = useTheme();
  const params = useLocalSearchParams<{ pick?: string; from?: string; to?: string; edit?: string; at?: string }>();
  const clock = useNow(30000);

  // Opening Plan is usually "I want to go somewhere now": start from where you are, leaving now.
  const [recent, setRecent] = useState<Recent[]>(() => load<Recent[]>(RECENT_KEY, []));
  const [from, setFrom] = useState(() => recent[0]?.from ?? homeStation ?? commute?.from ?? 'KGWA');
  const [to, setTo] = useState('');
  const [mode, setModeState] = useState<Mode>('now');
  const [time, setTime] = useState(nowHHMM);
  const [priority, setPriority] = useState<Priority>(commute?.priority ?? 'fast');
  const [day, setDay] = useState(0);
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [showTime, setShowTime] = useState(false);
  const [more, setMore] = useState(false);
  const fromTouched = useRef(false);

  const useHere = useCallback(() => {
    stationHere(tt).then((code) => { if (code && !fromTouched.current) setFrom((f) => (code === to ? f : code)); });
  }, [tt, to]);

  // "Now" means now: refresh the time whenever the screen is shown
  const [nowTime, setNowTime] = useState(nowFloor);
  useFocusEffect(useCallback(() => { setNowTime(nowFloor()); useHere(); }, [useHere]));
  useEffect(() => { setNowTime(nowFloor()); }, [from, to, mode]);

  const setMode = (m: Mode) => {
    setModeState(m);
    if (m === 'now') { setDay(0); setShowTime(false); return; }
    // picking a time: start from a sensible one and open the picker straight away
    setTime(m === 'after' ? nowHHMM() : nowHHMM(60));
    setShowTime(true);
  };

  // deep links: "Where to?" on Home, "Plan from/to here" on a station, "Edit" on the commute card
  useEffect(() => {
    if (params.edit === 'commute' && commute) {
      fromTouched.current = true;
      setFrom(commute.from); setTo(commute.to); setModeState(commute.mode); setTime(commute.time);
      setPriority(commute.priority); setDay(commuteDayOffset(commute.time)); setMore(true);
      return;
    }
    if (params.from) { fromTouched.current = true; setFrom(params.from); }
    if (params.to) setTo(params.to);
    if (params.from || params.to || params.pick) { setModeState('now'); setDay(0); setShowTime(false); }
    if (params.pick === 'to') { if (!params.from) { fromTouched.current = false; useHere(); } setTo(''); setPicking('to'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.pick, params.from, params.to, params.edit, params.at]);

  const reqMode: TimeMode = mode === 'now' ? 'after' : mode;
  const reqTime = mode === 'now' ? nowTime : time;
  const reqDay = mode === 'now' ? 0 : day;
  const req = useMemo<PlanRequest | null>(() => (from && to && from !== to
    ? { from, to, date: ymd(dayFromToday(reqDay)), time: reqTime, mode: reqMode, priority, pace: prefs.pace, women: prefs.women } : null),
  [from, to, reqDay, reqTime, reqMode, priority, prefs]);
  const plan = usePlan(req);
  useEffect(() => { if (req) track('plan_search', { from: req.from, to: req.to, mode: mode, priority: req.priority, time: req.time }); }, [req, mode]);
  useEffect(() => {
    if (plan.data && !plan.loading) track('plan_result', { options: plan.data.options.length, seat_all: !!plan.data.options[plan.data.best]?.seatAllTheWay, fallback: !!plan.data.fallback, error: plan.data.error ?? 'none' });
  }, [plan.data, plan.loading]);

  // remember trips the rider actually opened, for one-tap repeats
  const remember = () => {
    if (!req) return;
    setRecent((list) => {
      const next = [{ from: req.from, to: req.to }, ...list.filter((r) => !(r.from === req.from && r.to === req.to))].slice(0, 5);
      save(RECENT_KEY, next);
      return next;
    });
  };

  const isCommute = !!commute && commute.from === from && commute.to === to && commute.time === reqTime && commute.mode === reqMode && commute.priority === priority;
  const nowSec = secondsNow(clock);
  const live = reqDay === 0 && reqMode === 'after';
  // in "now" mode, hide trains that have already left since the plan was made
  const options = (plan.data?.options ?? []).filter((o) => !(mode === 'now' && o.dep < nowSec - 30));
  const best = plan.data && plan.data.best >= 0 && options.includes(plan.data.options[plan.data.best]) ? plan.data.options[plan.data.best] : options[0] ?? null;
  const ordered = best ? [best, ...options.filter((o) => o !== best).sort((a, b) => (reqMode === 'by' ? b.dep - a.dep : a.dep - b.dep))] : [];
  const recentChips = recent.filter((r) => !(r.from === from && r.to === to)).slice(0, 4);

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
            <Tap onPress={() => { fromTouched.current = true; setFrom(to || from); setTo(from); }} style={[s.swap, { backgroundColor: c.fill }]} accessibilityLabel="Swap">
              <T v="headline">⇅</T>
            </Tap>
          </View>

          <View style={[s.controls, { borderTopColor: c.sep }]}>
            <View style={{ flexDirection: 'row', gap: space.s }}>
              <View style={{ flex: 1 }}>
                <Segmented<Mode> value={mode} onChange={setMode} options={[{ value: 'now', label: t('lv_now') }, { value: 'after', label: t('lv_at') }, { value: 'by', label: t('arr_lbl') }]} />
              </View>
              {mode !== 'now' ? (
                <Tap onPress={() => setShowTime((v) => !v)} style={[s.timeBtn, { backgroundColor: c.fill }]}>
                  <T v="headline" style={type.time}>{time}</T>
                </Tap>
              ) : null}
            </View>
            {showTime && mode !== 'now' ? (
              <DateTimePicker value={timeDate} mode="time" display={Platform.OS === 'ios' ? 'spinner' : 'default'} onChange={onTime} minuteInterval={5} />
            ) : null}
            {mode !== 'now' ? (
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
            ) : null}
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
                  onPress={() => { setCommute({ from, to, time: reqTime, mode: reqMode, priority }); track('commute_saved', { from, to, priority }); router.navigate('/(tabs)/(home)'); }} />
              </View>
            ) : null}
          </View>
        </Card>

        {recentChips.length ? (
          <View style={{ gap: space.s }}>
            <T v="caption" color={c.ink2} style={{ fontWeight: '500', paddingHorizontal: space.xs }}>{t('recent')}</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.s }}>
              {recentChips.map((r) => (
                <Tap key={r.from + r.to} onPress={() => { fromTouched.current = true; setFrom(r.from); setTo(r.to); setModeState('now'); setDay(0); setShowTime(false); }}
                  style={[s.chip, { backgroundColor: c.card }]}>
                  <T v="sub" style={{ fontWeight: '600' }}>{stationName(tt, r.from, lang)} → {stationName(tt, r.to, lang)}</T>
                </Tap>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {!req ? null : plan.loading && !plan.data ? (
          <View style={{ gap: space.m }}>{[0, 1, 2].map((i) => <Card key={i} style={{ gap: space.m }}><Skeleton height={20} width="50%" /><Skeleton height={30} width="70%" /><Skeleton height={20} width="40%" /></Card>)}</View>
        ) : plan.error && !plan.data ? (
          <Card style={{ gap: space.m }}><T v="sub" color={c.ink2}>{t('err_net')}</T><Button kind="plain" label={t('retry')} onPress={plan.retry} /></Card>
        ) : plan.data?.error ? (
          <Notice tone="bad" text={plan.data.error === 'none-in-time' ? t('no_trains', { s: stationName(tt, to, lang), t: reqTime, a: plan.data.earliestArrival ? fmt(plan.data.earliestArrival) : '—' }) : t('pick_two')} />
        ) : plan.data ? (
          <View style={{ gap: space.m }}>
            {plan.error ? <Notice text={t('offline')} /> : null}
            {plan.data.fallback ? (
              <Notice text={`${t(plan.data.fallback.achieved === 'fast' ? 'fb_fast' : 'fb_long', { when: mode === 'by' ? t('by_t', { t: time }) : t('in_2h') })}${plan.data.fallback.seatedArrival ? ' ' + t('seat_if_late', { t: fmt(plan.data.fallback.seatedArrival) }) : ''}`} />
            ) : null}
            {plan.data.last && mode !== 'by' ? (
              <Notice tone={plan.data.last.dep - nowSec < 30 * 60 ? 'bad' : 'meh'} text={t('last_train', { s: stationName(tt, from, lang), t: fmt(plan.data.last.dep) })} />
            ) : null}
            {plan.data.tradeoff ? (
              <T v="sub" color={c.ink2} style={{ paddingHorizontal: space.xs }}>
                {plan.data.tradeoff.extraMinutes > 0 ? t(mode === 'by' ? 'trade_by' : 'trade_after', { e: plan.data.tradeoff.extraMinutes, s: plan.data.tradeoff.standingSaved }) : t('trade_free')}
              </T>
            ) : null}
            {ordered.map((o, i) => <OptionCard key={i} option={o} best={i === 0} last={!!plan.data?.last && o.dep === plan.data.last.dep && o.arr === plan.data.last.arr} nowSec={live ? nowSec : null} onPress={() => { remember(); router.push({ pathname: '/(tabs)/(plan)/trip', params: { id: putTrip(o, reqDay) } }); }} />)}
          </View>
        ) : null}
      </Screen>
      <StationPicker visible={picking !== null} title={picking === 'from' ? t('from') : t('to')} onClose={() => setPicking(null)}
        onPick={(code) => { if (picking === 'from') { fromTouched.current = true; setFrom(code); } else setTo(code); setPicking(null); }} />
    </>
  );
}

function OptionCard({ option, best, last, nowSec, onPress }: { option: PlanOption; best: boolean; last: boolean; nowSec: number | null; onPress: () => void }) {
  const { t, tt, lang } = useApp();
  const { c } = useTheme();
  const seated = option.legs.filter((l) => l.seat >= 2);
  const summary = option.seatAllTheWay ? { seat: 2 as const, text: t('all') }
    : seated.length ? { seat: 2 as const, text: t('sum_some', { x: seated.map((l) => t(l.line === 'GREEN' ? 'G' : l.line === 'PURPLE' ? 'P' : 'Y')).join(', ') }) }
      : option.legs.some((l) => l.seat === 0) ? { seat: 0 as const, text: t('sum_none') } : { seat: 1 as const, text: t('maybe_seats') };
  const ch = option.changes[0];
  // a rider on this train shared how late it is (today only)
  const [late, setLate] = useState<number | null>(null);
  const first = option.legs[0];
  useEffect(() => {
    if (nowSec == null) return;
    getTrainDelay(ymd(new Date()), first.origin, first.start - (first.held ?? 0)).then((d) => setLate(d ? Math.round(d.delay / 60) : null)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [first.origin, first.start, nowSec == null]);
  return (
    <Tap onPress={onPress}>
      <Card style={{ gap: space.m }}>
        <View style={s.optHead}>
          <T v="title" style={type.time}>{fmt(option.dep)} – {fmt(option.arr)}</T>
          {last ? <View style={[s.tag, { backgroundColor: c.badBg }]}><T v="caption" color={c.bad}>{t('last_tag')}</T></View>
            : best ? <View style={[s.tag, { backgroundColor: c.tintBg }]}><T v="caption" color={c.tint}>{t('best')}</T></View> : <T v="sub" color={c.ink2}>{mins(option.arr - option.dep)} {t('min')}</T>}
        </View>
        {nowSec != null && option.dep - nowSec < 90 * 60 ? (
          <T v="sub" color={option.dep - nowSec < 0 ? c.bad : c.tint} style={{ fontWeight: '600', marginTop: -space.s }}>
            {option.dep - nowSec < 0 ? t('gone', { n: Math.round((nowSec - option.dep) / 60) }) : option.dep - nowSec < 60 ? t('leaves_now') : t('leaves_in', { n: Math.floor((option.dep - nowSec) / 60) })}
            {best ? ` · ${mins(option.arr - option.dep)} ${t('min')}` : ''}
            {late != null ? ` · ${late >= 1 ? t('rider_late', { n: late }) : t('rider_ontime')}` : ''}
          </T>
        ) : null}
        <TrainChain legs={option.legs} arr={option.arr} />
        <View style={s.optFoot}>
          <SeatBadge seat={summary.seat} label={summary.text} />
          {ch && !option.trick ? <T v="caption" color={ch.tight ? c.bad : c.ink2} style={{ fontWeight: ch.tight ? '700' : '400' }}>{t('wait_at', { n: mins(ch.available), s: stationName(tt, ch.at, lang) })}</T> : null}
        </View>
        {(() => {
          const ci = option.changes.findIndex((x) => x.kind === 'line' && x.coaches.length);
          if (ci < 0) return null;
          const x = option.changes[ci];
          return (
            <View style={[s.optFoot, { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.sep, paddingTop: space.m }]}>
              <View style={{ flex: 1 }}>
                <T v="sub" style={{ fontWeight: '600' }}>{t('board_coach', { c: coachWords(x.coaches, t('or'), t) })}{x.known ? '' : ` (${t('likely')})`}</T>
                <T v="caption" color={x.tight ? c.bad : c.ink2} style={{ fontWeight: '400' }}>{x.held ? t('held_wait') : t(x.tight ? 'tight_change' : 'quick_change', { s: stationName(tt, x.at, lang) })}</T>
              </View>
              <CoachStrip coaches={x.coaches} line={option.legs[ci].line} />
            </View>
          );
        })()}
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

/** Now (plus an offset), rounded up to 5 minutes: a starting value for the time picker. */
const nowHHMM = (plus = 0) => { const d = new Date(Date.now() + plus * 60000); d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
/** The current minute, for "leave now". */
const nowFloor = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };

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
  chip: { borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14 },
});
