import { Share, StyleSheet, View } from 'react-native';
import { fmt, mins, stationName, type PlanOption } from '@kmm/shared';
import { useApp } from '@/core/app-state';
import { Button, Card, CoachStrip, SeatBadge, T } from './components';
import { space, type, useTheme } from './theme';

const LINE_KEY: Record<string, 'G' | 'P' | 'Y'> = { GREEN: 'G', PURPLE: 'P', YELLOW: 'Y' };

/** Step-by-step view of one trip: board, ride, change, arrive. */
export function TripView({ option }: { option: PlanOption }) {
  const { tt, lang, t } = useApp();
  const th = useTheme();
  const { c } = th;
  const nm = (code: string) => stationName(tt, code, lang);
  const lineName = (L: string) => t(LINE_KEY[L] ?? 'G');

  return (
    <Card padded={false} style={{ paddingVertical: space.s }}>
      {option.legs.map((l, i) => {
        const ch = option.changes[i];
        const col = th.line(l.line);
        const next = option.legs[i + 1];
        return (
          <View key={i}>
            <Step time={fmt(l.dep)} color={col} solidBelow icon>
              <T v="headline">{nm(l.from)}</T>
              <T v="sub" color={c.ink2}>{t('board', { line: lineName(l.line), s: nm(l.terminus) })}{l.platform ? ` · ${t('platform', { p: l.platform })}` : ''}</T>
              <SeatBadge seat={l.seat} />
              <T v="sub" color={c.ink2}>{t(l.stops === 1 ? 'stops_ride1' : 'stops_ride', { n: l.stops, m: mins(l.arr - l.dep) })}</T>
              {ch?.kind === 'line' && ch.coaches.length ? (
                <View style={[s.coachBox, { backgroundColor: c.fill }]}>
                  <CoachStrip coaches={ch.coaches} line={l.line} large />
                  <T v="sub"><T v="sub" style={{ fontWeight: '700' }}>{t('board_coach', { c: coachWords(ch.coaches, t('or'), t) })}</T>{ch.known ? '' : ` (${t('likely')})`}{', '}{t(ch.tight ? 'tight_change' : 'quick_change', { s: nm(l.to) }).toLowerCase()}</T>
                </View>
              ) : null}
            </Step>
            {ch && next ? (
              <Step time={fmt(l.arr)} color={col} dashedBelow hollow>
                <T v="headline">{nm(l.to)}</T>
                <T v="sub" color={c.ink2}>
                  {ch.kind === 'line'
                    ? `${t('change_to', { line: lineName(next.line) })}. ${t('walk_wait', { w: mins(ch.walk), p: Math.max(0, mins(ch.available) - mins(ch.walk)) })}`
                    : `${t(ch.kind === 'wait' ? 'trick_wait' : 'trick_rev', { s: nm(l.to) })} ${t('wait_n', { n: mins(ch.available) })}.`}
                </T>
                {ch.tight ? <View style={[s.tag, { backgroundColor: c.badBg }]}><T v="caption" color={c.bad}>{t('tight_change', { s: nm(l.to) })}</T></View> : null}
                {ch.kind !== 'line' ? <View style={[s.tag, { backgroundColor: c.tintBg }]}><T v="caption" color={c.tint}>{t('trick')}</T></View> : null}
              </Step>
            ) : null}
          </View>
        );
      })}
      <Step time={fmt(option.arr)} color={c.tint} icon last>
        <T v="headline">{nm(option.legs[option.legs.length - 1].to)}</T>
        <T v="sub" color={c.ink2}>{t('metro_min', { n: mins(option.arr - option.dep) })}{option.fare ? ` · ${t('fare', { n: option.fare })}` : ''}</T>
      </Step>
    </Card>
  );
}

export function coachWords(coaches: number[], or: string, t: ReturnType<typeof useApp>['t']) {
  const n = coaches.length === 1 ? String(coaches[0]) : `${coaches.slice(0, -1).join(', ')} ${or} ${coaches[coaches.length - 1]}`;
  return t('coach', { n });
}

function Step({ time, color, children, solidBelow, dashedBelow, hollow, icon, last }: {
  time: string; color: string; children: React.ReactNode; solidBelow?: boolean; dashedBelow?: boolean; hollow?: boolean; icon?: boolean; last?: boolean;
}) {
  const { c } = useTheme();
  return (
    <View style={s.step}>
      <T v="sub" style={[type.time, s.time]}>{time}</T>
      <View style={s.axis}>
        <View style={[hollow ? s.dotHollow : s.dot, hollow ? { borderColor: color, backgroundColor: c.card } : { backgroundColor: color }, icon && s.dotLg]} />
        {!last ? <View style={[s.rail, solidBelow ? { backgroundColor: color, width: 5 } : { borderLeftWidth: 2, borderColor: c.ink3, borderStyle: dashedBelow ? 'dashed' : 'solid', width: 0 }]} /> : null}
      </View>
      <View style={s.body}>{children}</View>
    </View>
  );
}

/** Native share sheet with a short, readable plan (works with WhatsApp). */
export function sharePlan(option: PlanOption, ctx: ReturnType<typeof useApp>) {
  const { tt, lang, t } = ctx;
  const nm = (code: string) => stationName(tt, code, lang);
  const lines = option.legs.map((l, i) => {
    const ch = option.changes[i];
    const coach = ch?.kind === 'line' && ch.coaches.length ? ` · ${t('board_coach', { c: coachWords(ch.coaches, t('or'), t) })}` : '';
    return `${fmt(l.dep)} ${nm(l.from)} → ${nm(l.to)} (${t(LINE_KEY[l.line] ?? 'G')})${coach}`;
  });
  const message = [`🚇 ${nm(option.legs[0].from)} → ${nm(option.legs[option.legs.length - 1].to)}`, ...lines, `${t('reach')} ${fmt(option.arr)}`, '', 'KnowMyMetro · knowmymetro.com'].join('\n');
  return Share.share({ message });
}

export function ShareButton({ option }: { option: PlanOption }) {
  const app = useApp();
  return <Button label={app.t('share_plan')} kind="plain" onPress={() => { sharePlan(option, app).catch(() => undefined); }} />;
}

const s = StyleSheet.create({
  step: { flexDirection: 'row', paddingRight: space.l, paddingLeft: space.s },
  time: { width: 52, textAlign: 'right', fontWeight: '700', paddingTop: 12 },
  axis: { width: 30, alignItems: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, marginTop: 14 },
  dotLg: { width: 22, height: 22, borderRadius: 11, marginTop: 10 },
  dotHollow: { width: 16, height: 16, borderRadius: 8, borderWidth: 3, marginTop: 13 },
  rail: { flex: 1, minHeight: 16, borderRadius: 3, marginVertical: 2 },
  body: { flex: 1, gap: 6, paddingTop: 11, paddingBottom: space.l, marginLeft: space.s },
  coachBox: { borderRadius: 12, padding: space.m, gap: space.s },
  tag: { alignSelf: 'flex-start', borderRadius: 6, paddingVertical: 3, paddingHorizontal: 7 },
});
