/** Web preview: browser storage (may be unavailable in private windows; the app then keeps state in memory). */
const mem = new Map<string, string>();
const get = (k: string) => { try { return localStorage.getItem(k); } catch { return mem.get(k) ?? null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { mem.set(k, v); } };

export function load<T>(key: string, fallback: T): T {
  try { const raw = get(key); return raw == null ? fallback : (JSON.parse(raw) as T); } catch { return fallback; }
}
export function save<T>(key: string, value: T): void { set(key, JSON.stringify(value)); }
export function remove(key: string): void { try { localStorage.removeItem(key); } catch { mem.delete(key); } }
