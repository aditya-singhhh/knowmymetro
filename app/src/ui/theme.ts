import { Platform, useColorScheme } from 'react-native';

const light = {
  bg: '#F2F2F7',
  card: '#FFFFFF',
  fill: '#EEEEF3',
  sep: '#E3E3E8',
  ink: '#101014',
  ink2: '#6B6B72',
  ink3: '#A1A1A8',
  tint: '#7B2268',
  tintBg: '#F4E6F0',
  onTint: '#FFFFFF',
  ok: '#128A4A', okBg: '#E3F5EA',
  meh: '#9A6A00', mehBg: '#FCF1D6',
  bad: '#C4401A', badBg: '#FDE8E1',
  shadow: 'rgba(16,16,20,0.06)',
};
const dark: typeof light = {
  bg: '#000000',
  card: '#1C1C1F',
  fill: '#2A2A2E',
  sep: '#2E2E33',
  ink: '#F4F4F6',
  ink2: '#9C9CA4',
  ink3: '#66666E',
  tint: '#E08BCF',
  tintBg: '#3A1A33',
  onTint: '#1A0716',
  ok: '#4ED487', okBg: '#12301F',
  meh: '#F2C85A', mehBg: '#342A10',
  bad: '#FF8A66', badBg: '#3A1C14',
  shadow: 'rgba(0,0,0,0)',
};
export type Palette = typeof light;

export const LINE_COLORS: Record<string, { light: string; dark: string; text: string }> = {
  PURPLE: { light: '#8C2877', dark: '#C766B4', text: '#FFFFFF' },
  GREEN: { light: '#00953A', dark: '#34C46A', text: '#FFFFFF' },
  YELLOW: { light: '#F2C200', dark: '#F2CB4E', text: '#2A2200' },
};

export function useTheme() {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';
  const c = isDark ? dark : light;
  const line = (id: string) => (LINE_COLORS[id] ? LINE_COLORS[id][isDark ? 'dark' : 'light'] : c.ink2);
  const lineText = (id: string) => LINE_COLORS[id]?.text ?? '#FFFFFF';
  return { c, isDark, line, lineText };
}

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 22, xxl: 32 };
export const radius = { s: 8, m: 12, l: 18, xl: 22 };

export const type = {
  large: { fontSize: 32, fontWeight: '700' as const, letterSpacing: -0.6 },
  title: { fontSize: 20, fontWeight: '700' as const, letterSpacing: -0.2 },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 16 },
  sub: { fontSize: 14 },
  caption: { fontSize: 12, fontWeight: '600' as const },
  clock: { fontSize: 52, fontWeight: '700' as const, letterSpacing: -2, fontVariant: ['tabular-nums' as const] },
  time: { fontVariant: ['tabular-nums' as const] },
};

export const cardShadow = Platform.select({
  ios: { shadowColor: '#101014', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
  android: { elevation: 1 },
  default: {},
});
