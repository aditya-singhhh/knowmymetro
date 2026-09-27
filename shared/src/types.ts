/** Shapes of data/timetable.json (built by scripts/build-timetable.mjs). */
export type LineId = 'PURPLE' | 'GREEN' | 'YELLOW' | (string & {});
export type ServiceId = 'weekday' | 'monday' | 'sunday' | 'holiday' | (string & {});

export interface Station {
  en: string;      // short display name
  full: string;    // official name
  kn?: string;     // Kannada name from the feed
  lat: number;
  lon: number;
}

export interface Line {
  name: string;
  color: string;
  stations: string[]; // station codes in line order
}

/** A group of trips that stop at the same stations with the same running times. */
export interface Pattern {
  line: LineId;
  stops: string[];
  arr: number[];            // seconds after the trip's first departure
  dep: number[];
  pf: (string | null)[];    // platform at each stop
}

export interface Timetable {
  version: string;
  generatedAt: string;
  feed: { version: string; start: string; end: string };
  lines: Record<string, Line>;
  stations: Record<string, Station>;
  patterns: Pattern[];
  /** per service: [patternIndex, first departure in seconds after midnight] */
  departures: Record<string, [number, number][]>;
  services: { id: ServiceId; days: boolean[]; start: string; end: string }[];
  exceptions: { service: ServiceId; date: string; type: number }[];
  peak: { service: ServiceId; from: number; to: number }[];
  fares: { codes: string[]; token: number[][] };
}

/** One ride on one train. */
export interface Leg {
  line: LineId;
  from: string;
  to: string;
  dep: number;        // seconds after midnight
  arr: number;
  origin: string;     // where this train starts
  terminus: string;   // where this train ends
  before: number;     // stops the train has made before you board
  stops: number;      // stops you ride
  frac: number;       // how far into its run the train is when you board (0..1)
  work: boolean;      // working-day timetable
  dir: number;        // +1 / -1 along the line's station order
  platform: string | null;
}

export type SeatClass = 0 | 1 | 2 | 3; // 0 likely full, 1 maybe, 2 likely seat, 3 train starts here
