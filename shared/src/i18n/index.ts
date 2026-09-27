import { en, hi, kn, ta, te, type Lang, type StringKey } from './strings';

export * from './strings';

const TABLES: Record<Lang, Partial<Record<StringKey, string>>> = { en, kn, hi, ta, te };

/** Translate a key, filling `{name}` placeholders. Falls back to English. */
export function translate(lang: Lang, key: StringKey, vars?: Record<string, string | number>): string {
  let s = TABLES[lang]?.[key] ?? en[key] ?? key;
  if (vars) for (const k in vars) s = s.split(`{${k}}`).join(String(vars[k]));
  return s;
}
