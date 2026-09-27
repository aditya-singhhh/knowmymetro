import * as Haptics from 'expo-haptics';
import { useEffect, useRef, type ReactNode } from 'react';
import {
  AccessibilityInfo, Animated, Pressable, ScrollView, StyleSheet, Text, View,
  type PressableProps, type StyleProp, type TextProps, type TextStyle, type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fmt, type SeatClass, type StringKey } from '@kmm/shared';
import { useApp } from '@/core/app-state';
import { cardShadow, radius, space, type, useTheme } from './theme';

/* ---------------- text ---------------- */
type Variant = keyof typeof type;
export function T({ v = 'body', color, style, ...rest }: TextProps & { v?: Variant; color?: string }) {
  const { c } = useTheme();
  return <Text {...rest} style={[type[v] as TextStyle, { color: color ?? c.ink }, style]} />;
}

/* ---------------- layout ---------------- */
export function Screen({ children, scroll = true, refresh }: { children: ReactNode; scroll?: boolean; refresh?: ReactNode }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const inner = <View style={{ gap: space.xl, paddingHorizontal: space.l, paddingBottom: insets.bottom + 90 }}>{children}</View>;
  if (!scroll) return <View style={{ flex: 1, backgroundColor: c.bg }}>{inner}</View>;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentInsetAdjustmentBehavior="automatic" keyboardShouldPersistTaps="handled">
      {refresh}
      {inner}
    </ScrollView>
  );
}

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
  const { c } = useTheme();
  return <View style={[{ backgroundColor: c.card, borderRadius: radius.l, borderCurve: 'continuous', padding: padded ? space.l : 0 }, cardShadow, style]}>{children}</View>;
}

/** Pressable with a light press animation and a selection haptic. */
export function Tap({ children, style, haptic = true, onPress, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean; children: ReactNode }) {
  return (
    <Pressable
      {...rest}
      onPress={(e) => { if (haptic) Haptics.selectionAsync().catch(() => undefined); onPress?.(e); }}
      style={({ pressed }) => [style, pressed && { opacity: 0.85, transform: [{ scale: 0.985 }] }]}
    >
      {children}
    </Pressable>
  );
}

export function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  const { c } = useTheme();
  return (
    <View style={s.section}>
      <T v="title">{title}</T>
      {action ? <Tap onPress={onAction} hitSlop={10}><T v="sub" color={c.tint} style={{ fontWeight: '600' }}>{action}</T></Tap> : null}
    </View>
  );
}

export function Segmented<V extends string>({ options, value, onChange }: { options: { value: V; label: string }[]; value: V; onChange: (v: V) => void }) {
  const { c } = useTheme();
  return (
    <View style={[s.seg, { backgroundColor: c.fill }]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Tap key={o.value} onPress={() => onChange(o.value)} style={[s.segBtn, on && { backgroundColor: c.card, ...cardShadow }]} accessibilityRole="tab" accessibilityState={{ selected: on }}>
            <T v="sub" style={{ fontWeight: '600', textAlign: 'center' }} color={on ? c.ink : c.ink2}>{o.label}</T>
          </Tap>
        );
      })}
    </View>
  );
}

export function Button({ label, onPress, kind = 'primary', disabled }: { label: string; onPress: () => void; kind?: 'primary' | 'plain'; disabled?: boolean }) {
  const { c } = useTheme();
  const primary = kind === 'primary';
  return (
    <Tap onPress={onPress} disabled={disabled} style={[s.btn, { backgroundColor: primary ? c.tint : c.fill, opacity: disabled ? 0.4 : 1 }]} accessibilityRole="button">
      <T v="headline" color={primary ? c.onTint : c.ink}>{label}</T>
    </Tap>
  );
}

export const Chevron = ({ color }: { color?: string }) => {
  const { c } = useTheme();
  return <T v="headline" color={color ?? c.ink3} style={{ fontSize: 20, marginTop: -2 }}>›</T>;
};

/* ---------------- metro bits ---------------- */
export function LinePill({ line, label }: { line: string; label: string }) {
  const th = useTheme();
  return (
    <View style={[s.pill, { backgroundColor: th.line(line) }]}>
      <View style={[s.pillDot, { borderColor: th.lineText(line) }]} />
      <T v="sub" color={th.lineText(line)} style={[type.time, { fontWeight: '700' }]}>{label}</T>
    </View>
  );
}

const SEAT_KEYS: StringKey[] = ['likely_full', 'maybe_seats', 'seats_likely', 'starts_here'];
export function SeatBadge({ seat, label }: { seat: SeatClass; label?: string }) {
  const { c } = useTheme();
  const { t } = useApp();
  const fg = seat >= 2 ? c.ok : seat === 1 ? c.meh : c.bad;
  const bg = seat >= 2 ? c.okBg : seat === 1 ? c.mehBg : c.badBg;
  const fill = seat >= 2 ? 0.15 : seat === 1 ? 0.55 : 1;
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <View style={[s.coachIcon, { borderColor: fg }]}><View style={{ width: `${fill * 100}%`, height: '100%', backgroundColor: fg }} /></View>
      <T v="caption" color={fg} style={{ fontSize: 13 }}>{label ?? t(SEAT_KEYS[seat])}</T>
    </View>
  );
}

/** Six coaches; the ones to board are filled with the line colour. Coach 1 is at the front. */
export function CoachStrip({ coaches, line, large }: { coaches: number[]; line: string; large?: boolean }) {
  const th = useTheme();
  const lit = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (cancelled) return;
      if (reduce) lit.setValue(1);
      else Animated.timing(lit, { toValue: 1, duration: 450, delay: 150, useNativeDriver: true }).start();
    });
    return () => { cancelled = true; };
  }, [lit, coaches.join()]);
  return (
    <View style={{ flexDirection: 'row', gap: 3, flex: large ? 1 : undefined }} accessibilityLabel={`Coach ${coaches.join(', ')}`}>
      {[1, 2, 3, 4, 5, 6].map((n) => {
        const on = coaches.includes(n);
        return (
          <View key={n} style={[s.car, large ? s.carLg : null, n === 1 && { borderTopLeftRadius: large ? 12 : 8 }, { backgroundColor: th.c.fill }]}>
            {on ? <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: th.line(line), opacity: lit, borderRadius: 3, borderTopLeftRadius: n === 1 ? (large ? 12 : 8) : 3 }]} /> : null}
            {large ? <T v="caption" color={on ? th.lineText(line) : th.c.ink2}>{n}</T> : null}
          </View>
        );
      })}
    </View>
  );
}

export function TrainChain({ legs, arr }: { legs: { line: string; dep: number }[]; arr: number }) {
  const { c } = useTheme();
  return (
    <View style={s.chain}>
      {legs.map((l, i) => (
        <View key={i} style={s.chainItem}>
          {i > 0 ? <T color={c.ink3}>›</T> : null}
          <LinePill line={l.line} label={fmt(l.dep)} />
        </View>
      ))}
      <T color={c.ink3}>›</T>
      <T v="sub" color={c.ink2} style={[type.time, { fontWeight: '600' }]}>{fmt(arr)}</T>
    </View>
  );
}

/* ---------------- loading ---------------- */
export function Skeleton({ height, width = '100%', style }: { height: number; width?: number | `${number}%`; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.5, duration: 650, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return <Animated.View style={[{ height, width, borderRadius: radius.s, backgroundColor: c.fill, opacity: pulse }, style]} />;
}

export function Notice({ text, tone = 'meh' }: { text: string; tone?: 'meh' | 'bad' | 'ok' }) {
  const { c } = useTheme();
  const fg = tone === 'ok' ? c.ok : tone === 'bad' ? c.bad : c.meh;
  const bg = tone === 'ok' ? c.okBg : tone === 'bad' ? c.badBg : c.mehBg;
  return <View style={[s.notice, { backgroundColor: bg }]}><T v="sub" color={fg} style={{ fontWeight: '500' }}>{text}</T></View>;
}

const s = StyleSheet.create({
  section: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: -space.s, paddingHorizontal: space.xs },
  seg: { flexDirection: 'row', borderRadius: 10, padding: 2 },
  segBtn: { flex: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 4, justifyContent: 'center' },
  btn: { height: 50, borderRadius: radius.m, alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 30, paddingHorizontal: 10, borderRadius: 8, borderCurve: 'continuous' },
  pillDot: { width: 9, height: 9, borderRadius: 3, borderWidth: 2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 3, paddingHorizontal: 7, borderRadius: 6 },
  coachIcon: { width: 18, height: 10, borderWidth: 1.6, borderRadius: 2, borderBottomLeftRadius: 5, overflow: 'hidden' },
  car: { width: 20, height: 13, borderRadius: 3, overflow: 'hidden' },
  carLg: { flex: 1, width: undefined, height: 28, alignItems: 'center', justifyContent: 'center' },
  chain: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  chainItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  notice: { borderRadius: radius.m, padding: space.m },
});
