/**
 * Turns raw phone motion (10 readings a second) into what the train is doing.
 *
 * A train speeds up and brakes smoothly, for 15-25 s, along the track (level with the ground),
 * and stands very still at stations. A hand moves in quick jerks, in every direction, and turns
 * the phone. So each second we:
 *   1. average the readings: quick hand jitter mostly cancels out, the train's steady push stays;
 *   2. use gravity to find "down" and keep only the level part of that push (h, m/s^2);
 *   3. note how much the phone shook (j) and turned (r) inside that second: high means hand or walking.
 * From that we guess the train's state and estimate its speed by adding up the push between two
 * stops (speed is reset to 0 at every stop, so the error can't build up across a whole ride).
 *
 * The raw per-second numbers are also saved, so the server can redo this with better methods later.
 */

export type TrainState = 'unknown' | 'hand' | 'stopped' | 'starting' | 'cruising' | 'braking';

export interface MotionSecond {
  t: number;
  /** average push without gravity, phone axes, m/s^2 */
  a: [number, number, number];
  /** average gravity, phone axes, m/s^2 */
  g: [number, number, number];
  /** level (along the ground) push, m/s^2 */
  h: number;
  /** up/down push, m/s^2 */
  v: number;
  /** shake inside the second (spread of the push), m/s^2 */
  j: number;
  /** turning, deg/s */
  r: number;
  state: TrainState;
  /** probably standing at a station (looser than state 'stopped'; for counting stops) */
  dwell: boolean;
  /** push along the train's forward direction, m/s^2 (+ speeding up, - braking; null until a stop has been seen) */
  along: number | null;
  /** estimated speed from motion, km/h (null when unknown) */
  kmh: number | null;
}

export interface Reading {
  t: number;
  ax: number; ay: number; az: number;   // push without gravity
  gx: number; gy: number; gz: number;   // gravity
  rot: number;                          // turning speed, deg/s
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.sqrt(dot(a, a));
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

/** Tuning. Metro trains speed up and brake at roughly 0.8-1.1 m/s^2. */
export const MOTION = {
  handTurn: 20,        // deg/s: turning faster than this = phone in hand
  handShake: 0.8,      // m/s^2: shaking more than this = hand or walking
  stillShake: 0.06,    // m/s^2: phone resting and train standing (strict: resets the speed estimate)
  stillSeconds: 4,
  // "Probably at a station" for counting stops, tuned on real rides with the phone in hand (6 Oct 2026,
  // checked against door taps and GPS): almost no level push, little turning, moderate shake.
  // Looser, so it can also fire while cruising smoothly; the live tracker ignores stops that don't line up
  // with a station's time, so it is used only for counting stations, never for speed.
  dwellShake: 0.3,     // m/s^2
  dwellPush: 0.1,      // m/s^2
  dwellTurn: 12,       // deg/s
  dwellSeconds: 6,
  push: 0.3,           // m/s^2: steady level push above this = speeding up or braking
  pushSeconds: 3,
  maxKmh: 90,
};

export class MotionTracker {
  private buf: Reading[] = [];
  private recent: { h: V3; j: number; r: number }[] = [];
  private state: TrainState = 'unknown';
  /** level direction of the push when the train last pulled away (phone axes); braking is the opposite */
  private forward: V3 | null = null;
  private speed: number | null = null; // m/s
  /** true from a stop until the phone is handled (so "forward" can be learned from the next push) */
  private atStop = false;
  private lastT = 0;

  push(r: Reading) { this.buf.push(r); }

  /** Call once a second. Returns null if there were no readings. */
  second(t: number): MotionSecond | null {
    const n = this.buf.length;
    if (!n) return null;
    let a: V3 = [0, 0, 0], g: V3 = [0, 0, 0], rot = 0;
    for (const s of this.buf) { a = [a[0] + s.ax, a[1] + s.ay, a[2] + s.az]; g = [g[0] + s.gx, g[1] + s.gy, g[2] + s.gz]; rot += Math.abs(s.rot); }
    a = scale(a, 1 / n); g = scale(g, 1 / n); rot /= n;
    let spread = 0;
    for (const s of this.buf) spread += len(sub([s.ax, s.ay, s.az], a)) ** 2;
    const j = Math.sqrt(spread / n);
    this.buf = [];

    const gl = len(g) || 9.81;
    const down = scale(g, 1 / gl);
    const v = dot(a, down);
    const hv = sub(a, scale(down, v));        // level part of the push
    const h = len(hv);

    const dt = this.lastT ? Math.min(3, Math.max(0.2, (t - this.lastT) / 1000)) : 1;
    this.lastT = t;
    this.recent.push({ h: hv, j, r: rot });
    if (this.recent.length > 10) this.recent.shift();
    this.update(hv, j, rot, dt);

    return {
      t, a: r3(a), g: r3(g), h: round(h, 3), v: round(v, 3), j: round(j, 3), r: round(rot, 1),
      state: this.state, dwell: this.dwell(), along: this.forward ? round(dot(hv, this.forward), 3) : null, kmh: this.speed == null ? null : Math.round(this.speed * 3.6),
    };
  }

  private dwell(): boolean {
    const M = MOTION, w = this.recent.slice(-M.dwellSeconds);
    if (this.state === 'stopped') return true;
    return w.length >= M.dwellSeconds && w.every((s) => s.j < M.dwellShake && len(s.h) < M.dwellPush && s.r < M.dwellTurn);
  }

  private update(hv: V3, j: number, rot: number, dt: number) {
    const M = MOTION;
    const last = (k: number) => this.recent.slice(-k);

    // Phone in hand or walking: the phone's axes no longer line up with the train, so forget the direction.
    if (rot > M.handTurn || j > M.handShake) {
      this.state = 'hand';
      this.forward = null;
      this.atStop = false;
      this.speed = null;
      return;
    }

    // Standing still for a few seconds: at a station (or not on a train at all).
    const still = last(M.stillSeconds);
    if (still.length >= M.stillSeconds && still.every((s) => s.j < M.stillShake && len(s.h) < M.push * 0.6)) {
      this.state = 'stopped';
      this.speed = 0;
      this.forward = null;
      this.atStop = true;
      return;
    }

    // A steady level push in one direction for a few seconds.
    const run = last(M.pushSeconds);
    const avg: V3 = scale(run.reduce<V3>((s, x) => [s[0] + x.h[0], s[1] + x.h[1], s[2] + x.h[2]], [0, 0, 0]), 1 / Math.max(1, run.length));
    const steady = run.length >= M.pushSeconds && len(avg) > M.push
      && run.every((s) => len(s.h) > M.push * 0.5 && dot(s.h, avg) > 0);

    if (steady) {
      const dir = scale(avg, 1 / len(avg));
      if (!this.forward) {
        if (this.atStop) {
          // first steady push after a stop: the train pulling away. Count the seconds it took to be sure.
          this.forward = dir;
          this.state = 'starting';
          this.speed = len(avg) * run.length;
          return;
        }
        this.state = 'cruising'; // pushing, but we never saw which way is forward
      } else {
        this.state = dot(dir, this.forward) >= 0 ? 'starting' : 'braking';
      }
    } else if (this.state !== 'unknown') {
      this.state = 'cruising';
    }

    // Speed: add up the push along the forward direction (only known after a stop).
    if (this.forward && this.speed != null) {
      this.speed = Math.min(M.maxKmh / 3.6, Math.max(0, this.speed + dot(hv, this.forward) * dt));
    } else {
      this.speed = this.atStop ? 0 : null;
    }
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
const r3 = (v: V3): V3 => [round(v[0], 3), round(v[1], 3), round(v[2], 3)];

/* ---------------- distance from the metro line ---------------- */

/** Metres from a point to the nearest stretch of any metro line (straight lines between stations). */
export function metresFromLine(lines: { stations: string[] }[], stations: Record<string, { lat: number; lon: number }>, lat: number, lon: number): number {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180), ky = 110540;
  let best = Infinity;
  for (const line of lines) {
    for (let i = 0; i + 1 < line.stations.length; i++) {
      const A = stations[line.stations[i]], B = stations[line.stations[i + 1]];
      if (!A || !B) continue;
      const ax = (A.lon - lon) * kx, ay = (A.lat - lat) * ky, bx = (B.lon - lon) * kx, by = (B.lat - lat) * ky;
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      const u = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      const px = ax + u * dx, py = ay + u * dy;
      best = Math.min(best, Math.sqrt(px * px + py * py));
    }
  }
  return best;
}
