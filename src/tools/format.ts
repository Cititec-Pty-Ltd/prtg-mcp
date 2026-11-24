import type { Page, Params } from '../client.js';
import { InputError, clean, compact, num } from './shared.js';

/** PRTG status codes (status_raw), named. */
export const STATE_BY_CODE: Record<number, string> = {
  1: 'unknown',
  2: 'collecting',
  3: 'up',
  4: 'warning',
  5: 'down',
  6: 'no_probe',
  7: 'paused_by_user',
  8: 'paused_by_dependency',
  9: 'paused_by_schedule',
  10: 'unusual',
  11: 'paused_by_license',
  12: 'paused_until',
  13: 'down_acknowledged',
  14: 'down_partial',
};

/** The status filter a caller may ask for, and the PRTG codes each one means. */
export const STATUS_FILTERS: Record<string, number[]> = {
  down: [5],
  down_partial: [14],
  down_acknowledged: [13],
  warning: [4],
  unusual: [10],
  paused: [7, 8, 9, 11, 12],
  up: [3],
  unknown: [1, 2, 6],
};
export const STATUS_FILTER_NAMES = Object.keys(STATUS_FILTERS);

/** Alarm states, worst first: the order alarms are listed in. */
export const ALARM_ORDER = [5, 14, 13, 4, 10];

export function stateOf(raw: unknown): string | undefined {
  const n = num(raw);
  return n === undefined ? undefined : (STATE_BY_CODE[n] ?? `code_${n}`);
}

/** filter_status parameters (PRTG ORs repeats) for the named filters. */
export function statusParams(names: readonly string[] | undefined): Params {
  if (!names) return [];
  const codes = [...new Set(names.flatMap((n) => STATUS_FILTERS[n] ?? []))];
  return codes.map((c) => ['filter_status', c] as [string, number]);
}

/**
 * A substring filter for a name or host. PRTG's filter syntax is @sub(text);
 * a parenthesis in the text would end it early, so those are refused.
 */
export function subFilter(column: string, text: string | undefined, key: string): Params {
  if (text === undefined) return [];
  if (/[()]/.test(text)) throw new InputError(`${key} cannot contain ( or )`);
  return [[`filter_${column}`, `@sub(${text})`]];
}

/** Sensor counts of a probe, group or device. */
export function sensorCounts(r: Record<string, unknown>): Record<string, unknown> {
  const n = (k: string) => num(r[`${k}_raw`]) ?? num(r[k]);
  return compact({
    total: n('totalsens'),
    down: n('downsens'),
    downPartial: n('partialdownsens'),
    downAcknowledged: n('downacksens'),
    warning: n('warnsens'),
    unusual: n('unusualsens'),
    paused: n('pausedsens'),
    up: n('upsens'),
  });
}

export const COUNT_COLUMNS = [
  'totalsens',
  'downsens',
  'partialdownsens',
  'downacksens',
  'warnsens',
  'unusualsens',
  'pausedsens',
  'upsens',
] as const;

export function message(r: Record<string, unknown>, max = 300): string | undefined {
  return clean(r.message_raw, max) ?? clean(r.message, max);
}

export const SENSOR_COLUMNS = [
  'objid',
  'name',
  'type',
  'device',
  'group',
  'probe',
  'parentid',
  'status',
  'message',
  'lastvalue',
  'downtimesince',
] as const;

export function sensorRow(r: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: num(r.objid_raw) ?? num(r.objid),
    name: clean(r.name, 200),
    type: clean(r.type, 100),
    device: clean(r.device, 200),
    deviceId: num(r.parentid_raw) ?? num(r.parentid),
    group: clean(r.group, 200),
    probe: clean(r.probe, 200),
    state: stateOf(r.status_raw),
    status: clean(r.status, 60),
    message: message(r),
    lastValue: clean(r.lastvalue, 100),
    downFor: clean(r.downtimesince, 60),
  });
}

export const DEVICE_COLUMNS = ['objid', 'name', 'host', 'group', 'probe', 'parentid', 'status', 'message', ...COUNT_COLUMNS] as const;

export function deviceRow(r: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: num(r.objid_raw) ?? num(r.objid),
    name: clean(r.name, 200),
    host: clean(r.host, 200),
    group: clean(r.group, 200),
    groupId: num(r.parentid_raw) ?? num(r.parentid),
    probe: clean(r.probe, 200),
    state: stateOf(r.status_raw),
    status: clean(r.status, 60),
    message: message(r, 200),
    sensors: sensorCounts(r),
  });
}

export const GROUP_COLUMNS = ['objid', 'name', 'probe', 'group', 'parentid', 'status', ...COUNT_COLUMNS] as const;

export function groupRow(r: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: num(r.objid_raw) ?? num(r.objid),
    name: clean(r.name, 200),
    parentGroup: clean(r.group, 200),
    parentId: num(r.parentid_raw) ?? num(r.parentid),
    probe: clean(r.probe, 200),
    state: stateOf(r.status_raw),
    status: clean(r.status, 60),
    sensors: sensorCounts(r),
  });
}

export const PROBE_COLUMNS = ['objid', 'name', 'status', 'message', 'condition', ...COUNT_COLUMNS] as const;

export function probeRow(r: Record<string, unknown>): Record<string, unknown> {
  return compact({
    id: num(r.objid_raw) ?? num(r.objid),
    name: clean(r.name, 200),
    state: stateOf(r.status_raw),
    status: clean(r.status, 60),
    connection: clean(r.condition, 60),
    message: message(r, 200),
    sensors: sensorCounts(r),
  });
}

/** A page of rows with what is needed to ask for the next one. */
export function paged<T>(p: Page<Record<string, unknown>>, map: (r: Record<string, unknown>) => T): Record<string, unknown> {
  const next = p.offset + p.items.length;
  return compact({
    total: p.total,
    offset: p.offset,
    count: p.items.length,
    nextOffset: p.items.length > 0 && next < p.total ? next : undefined,
    items: p.items.map(map),
  });
}
