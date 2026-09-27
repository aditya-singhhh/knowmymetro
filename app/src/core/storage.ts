/**
 * Small synchronous key-value store (SQLite-backed). Synchronous reads mean the first
 * screen renders with saved data straight away, with no loading flash.
 */
import Storage from 'expo-sqlite/kv-store';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = Storage.getItemSync(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save<T>(key: string, value: T): void {
  try {
    Storage.setItemSync(key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: the app keeps working with in-memory state
  }
}

export function remove(key: string): void {
  try { Storage.removeItemSync(key); } catch { /* ignore */ }
}
