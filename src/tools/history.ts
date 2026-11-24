import type { Api } from '../client.js';
import { InputError, clean, compact, num } from './shared.js';

/** Longest range one call may ask for, in hours (31 days). */
export const MAX_RANGE_HOURS = 31 * 24;
/** Averaging intervals PRTG offers for historic data, in seconds (0 = raw values). */
export const AVERAGES = [0, 60, 300, 900, 3600, 21600, 86400] as const;
/** Raw values (average 0) only for ranges up to this many hours. */
export const MAX_RAW_HOURS = 24;
/** Target number of intervals when the average is chosen automatically. */
const TARGET_ROWS = 300;
/** Most rows a result lists (summaries always cover every row). */
export const MAX_ROWS = 500;

const PRTG_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "YYYY-MM-DD-HH-mm-ss" for `date` as a wall-clock time in `timeZone`. */
export function prtgTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}-${get('minute')}-${get('second')}`;
}

/** A caller's "YYYY-MM-DD HH:MM[:SS]" (PRTG server local time): PRTG's form, plus a comparable value. */
export function parseLocal(value: string, key: string): { prtg: string; ms: number } {
  const m = PRTG_TIME.exec(value.trim());
  if (!m) throw new InputError(`${key} must look like 2026-11-24 08:00 (PRTG server local time)`);
  const [, y, mo, d, h, mi, s = '00'] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const check = new Date(ms);
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59) {
    throw new InputError(`${key} is not a real date and time`);
  }
  return { prtg: `${y}-${mo}-${d}-${h}-${mi}-${s}`, ms };
}

/** The smallest PRTG average that keeps the range near TARGET_ROWS intervals. */
export function chooseAverage(rangeHours: number): number {
  const seconds = rangeHours * 3600;
  return AVERAGES.find((a) => a > 0 && seconds / a <= TARGET_ROWS) ?? 86400;
}

export interface HistoryArgs {
  sensor_id: number;
  hours?: number;
  start?: string;
  end?: string;
  average_seconds?: number;
  channels?: string[];
  max_rows: number;
}

export function resolveRange(args: HistoryArgs, timeZone: string, now = Date.now()) {
  let sdate: string;
  let edate: string;
  let rangeHours: number;
  if (args.start !== undefined || args.end !== undefined) {
    if (args.hours !== undefined) throw new InputError('give either hours or start/end, not both');
    if (args.start === undefined) throw new InputError('start is required with end');
    const start = parseLocal(args.start, 'start');
    const end = args.end !== undefined ? parseLocal(args.end, 'end') : parseLocal(prtgTime(new Date(now), timeZone).replace(/^(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-(\d{2})$/, '$1 $2:$3:$4'), 'end');
    if (end.ms <= start.ms) throw new InputError('end must be after start');
    rangeHours = (end.ms - start.ms) / 3_600_000;
    sdate = start.prtg;
    edate = end.prtg;
  } else {
    rangeHours = args.hours ?? 24;
    sdate = prtgTime(new Date(now - rangeHours * 3_600_000), timeZone);
    edate = prtgTime(new Date(now), timeZone);
  }
  if (rangeHours > MAX_RANGE_HOURS) {
    throw new InputError(`the range is ${Math.round(rangeHours)} hours; at most ${MAX_RANGE_HOURS} (31 days) per call`);
  }
  let avg = args.average_seconds ?? chooseAverage(rangeHours);
  if (!(AVERAGES as readonly number[]).includes(avg)) throw new InputError(`average_seconds must be one of ${AVERAGES.join(', ')}`);
  if (avg === 0 && rangeHours > MAX_RAW_HOURS) {
    throw new InputError(`raw values (average_seconds 0) only for ranges up to ${MAX_RAW_HOURS} hours`);
  }
  if (avg > 0 && (rangeHours * 3600) / avg > 20_000) {
    throw new InputError('that average gives too many intervals for the range; use a larger average_seconds');
  }
  return { sdate, edate, avg, rangeHours };
}

interface ChannelValue {
  channel: string;
  value?: number;
  text?: string;
}

/** Channel values of one histdata row. Handles both JSON shapes PRTG versions use. */
export function rowValues(row: Record<string, unknown>): ChannelValue[] {
  const out: ChannelValue[] = [];
  if (Array.isArray(row.value)) {
    for (const v of row.value as Record<string, unknown>[]) {
      const channel = clean(v?.channel, 120);
      if (!channel) continue;
      out.push({ channel, value: num(v.value_raw) ?? leadingNumber(v.value), text: clean(v.value, 60) });
    }
    return out;
  }
  const skip = new Set(['datetime', 'datetime_raw', 'coverage', 'coverage_raw', 'value']);
  for (const [key, v] of Object.entries(row)) {
    if (skip.has(key) || /_raw$|\(raw\)$/i.test(key)) continue;
    const raw = row[`${key}_raw`] ?? row[`${key}(RAW)`] ?? row[`${key} (RAW)`];
    const channel = clean(key, 120);
    if (!channel) continue;
    out.push({ channel, value: num(raw) ?? leadingNumber(v), text: clean(v, 60) });
  }
  return out;
}

function leadingNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(v);
  return m ? Number(m[1].replace(',', '.')) : undefined;
}

interface Summary {
  min?: number;
  max?: number;
  mean?: number;
  last?: number;
  samples: number;
  /** The unit of the formatted text, while every formatted value matches its raw value's scale. */
  unit?: string;
  /** false once a formatted value is in another scale or unit than the raw numbers. */
  unitOk: boolean;
  /** A raw value and how PRTG showed it, kept when the scales differ. */
  example?: { raw: number; shown: string };
}

/** The unit part of PRTG's formatted value ("1,5 kbit/s" -> "kbit/s"), or undefined. */
export function unitOf(text: string): string | undefined {
  const unit = text.replace(/^\s*-?[\d.,\s]+/, '').trim();
  return unit && unit.length <= 20 ? unit : undefined;
}

/**
 * The numbers a formatted value could mean: PRTG formats with the server's locale, so "1,234"
 * may be 1.234 or 1234, and "1.234,5" is 1234.5.
 */
export function shownNumbers(text: string): number[] {
  const m = /^\s*(-?[\d][\d.,\s]*)/.exec(text);
  if (!m) return [];
  const s = m[1].replace(/\s+/g, '').replace(/[.,]$/, '');
  const candidates = [
    s.replace(/,/g, ''), // comma thousands
    s.replace(/\./g, '').replace(',', '.'), // dot thousands, comma decimal
    s.replace(',', '.'), // comma decimal
  ];
  return [...new Set(candidates.map(Number).filter((n) => Number.isFinite(n)))];
}

/** Whether a formatted value shows the raw number at the same scale (allowing for rounding). */
export function sameScale(text: string, raw: number): boolean {
  return shownNumbers(text).some((n) => Math.abs(n - raw) <= Math.max(0.02 * Math.abs(raw), 0.51));
}

/** Evenly spaced picks from `rows`, always keeping the first and the last. */
export function sample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  if (max <= 1) return rows.slice(-1);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
  return out;
}

export async function sensorHistory(args: HistoryArgs, api: Api, now = Date.now()) {
  const { sdate, edate, avg, rangeHours } = resolveRange(args, api.config.timeZone, now);
  const body = await api.get('historicdata.json', [
    ['id', args.sensor_id],
    ['avg', avg],
    ['sdate', sdate],
    ['edate', edate],
    ['usecaption', 1],
  ]);
  const hist = Array.isArray(body.histdata) ? (body.histdata as Record<string, unknown>[]) : [];
  const wanted = args.channels?.map((c) => c.toLowerCase());
  const keep = (name: string) => !wanted || wanted.some((w) => name.toLowerCase().includes(w));

  const sums = new Map<string, Summary & { total: number }>();
  const rows: Record<string, unknown>[] = [];
  for (const row of hist) {
    const values = rowValues(row).filter((v) => keep(v.channel));
    const entry: Record<string, unknown> = { time: clean(row.datetime, 80) };
    const coverage = clean(row.coverage, 10);
    if (coverage && coverage !== '100 %') entry.coverage = coverage;
    for (const v of values) {
      entry[v.channel] = v.value ?? v.text ?? null;
      if (v.value === undefined) continue;
      const s = sums.get(v.channel) ?? { samples: 0, total: 0, unitOk: true };
      s.min = s.min === undefined ? v.value : Math.min(s.min, v.value);
      s.max = s.max === undefined ? v.value : Math.max(s.max, v.value);
      s.total += v.value;
      s.samples += 1;
      s.last = v.value;
      // A unit is given only while every formatted value shows the raw number in that unit:
      // raw values can be in another scale (1500 shown as "1,5 kbit/s"), and PRTG may switch
      // units between intervals (MByte, GByte).
      if (v.text && s.unitOk) {
        const unit = unitOf(v.text);
        if (!sameScale(v.text, v.value) || (unit && s.unit && unit !== s.unit)) {
          s.unitOk = false;
          s.example = { raw: v.value, shown: v.text };
        } else if (unit) {
          s.unit ??= unit;
        }
      }
      sums.set(v.channel, s);
    }
    rows.push(entry);
  }
  const channels: Record<string, unknown> = {};
  for (const [name, s] of sums) {
    channels[name] = compact({
      unit: s.unitOk ? s.unit : undefined,
      rawScale: s.unitOk
        ? undefined
        : `PRTG raw values, not in the displayed unit: ${s.example!.raw} was shown as "${s.example!.shown}"`,
      min: s.min,
      max: s.max,
      mean: s.samples ? Math.round((s.total / s.samples) * 1000) / 1000 : undefined,
      last: s.last,
      samples: s.samples,
    });
  }
  const shown = sample(rows, args.max_rows);
  return compact({
    sensorId: args.sensor_id,
    from: sdate,
    to: edate,
    timeZone: api.config.timeZone,
    averageSeconds: avg,
    rangeHours: Math.round(rangeHours * 100) / 100,
    intervals: rows.length,
    channels,
    note:
      shown.length < rows.length
        ? `rows shows ${shown.length} of ${rows.length} intervals, evenly spaced; channels summarises every interval. Narrow the range or raise average_seconds for detail.`
        : rows.length === 0
          ? 'PRTG returned no data for this range (a new or paused sensor, or a range outside its history).'
          : undefined,
    rows: shown,
  });
}
