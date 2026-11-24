import type { Api, Params } from '../client.js';
import {
  ALARM_ORDER,
  CHANNEL_COLUMNS,
  channelRow,
  DEVICE_COLUMNS,
  GROUP_COLUMNS,
  PROBE_COLUMNS,
  SENSOR_COLUMNS,
  STATUS_FILTER_NAMES,
  deviceRow,
  groupRow,
  paged,
  probeRow,
  sensorRow,
  stateOf,
  statusParams,
  subFilter,
} from './format.js';
import { AVERAGES, MAX_RANGE_HOURS, MAX_ROWS, sensorHistory } from './history.js';
import type { HistoryArgs } from './history.js';
import { InputError, clean, compact, num } from './shared.js';
import type { ParamSpec, ToolSpec } from './spec.js';

// --- Common parameters ---------------------------------------------------------------------

const limit = (dflt: number, max = 500): ParamSpec => ({
  type: 'int',
  description: `Rows to return (1-${max}).`,
  min: 1,
  max,
  default: dflt,
});
const offset: ParamSpec = {
  type: 'int',
  description: 'Rows to skip, for the next page (use nextOffset from the previous result).',
  min: 0,
  max: 1_000_000,
  default: 0,
};
const nameFilter = (what: string): ParamSpec => ({
  type: 'string',
  description: `Only ${what} whose name contains this text.`,
  maxLength: 100,
});
const parentId = (what: string): ParamSpec => ({
  type: 'int',
  description: `Only ${what} below this PRTG object (a probe, group or device ID), at any depth. 0 is the root group.`,
  min: 0,
});

const str = (v: unknown) => v as string | undefined;
const int = (v: unknown) => v as number | undefined;

// --- Status ---------------------------------------------------------------------------------

/**
 * status.json answers with lower-case field names (alarms, upsens, version); getstatus.htm and
 * some versions use PascalCase (Alarms, UpSens, Version). Fields are read ignoring case, so both work.
 */
export function statusFields(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
  return out;
}

async function status(api: Api) {
  const s = statusFields(await api.get('status.json'));
  const pick = (k: string) => s[k.toLowerCase()];
  const n = (k: string) => num(pick(k)) ?? 0;
  const has = (k: string) => pick(k) !== undefined;
  const yes = (k: string) => {
    const v = pick(k);
    return typeof v === 'boolean' ? v : /^(true|1|yes)$/i.test(String(v ?? ''));
  };
  return compact({
    version: clean(pick('Version'), 60),
    serverClock: clean(pick('Clock'), 60),
    sensors: {
      down: n('Alarms'),
      downPartial: n('PartialAlarms'),
      downAcknowledged: n('AckAlarms'),
      warning: n('WarnSens'),
      unusual: n('UnusualSens'),
      paused: n('PausedSens'),
      up: n('UpSens'),
      unknown: n('UnknownSens'),
    },
    newAlarms: n('NewAlarms'),
    newLogEntries: n('NewMessages'),
    tokenUser: compact({
      readOnly: has('ReadOnlyUser') ? yes('ReadOnlyUser') : undefined,
      administrator: has('IsAdminUser') ? yes('IsAdminUser') : undefined,
    }),
    updateAvailable: has('PRTGUpdateAvailable') ? yes('PRTGUpdateAvailable') : undefined,
    maintenanceExpiresInDays: num(pick('MaintExpiryDays')),
    cluster: has('IsCluster') ? yes('IsCluster') : undefined,
  });
}

// --- Sensors and alarms -----------------------------------------------------------------------

/**
 * Alarms worst first, paged over the whole set. PRTG pages a table by object ID, and sorting by
 * status would not give severity order (warning 4 < down 5 < unusual 10 < acknowledged 13 <
 * partial 14), so each state is read on its own, in ALARM_ORDER, and the caller's offset and
 * limit are applied across them: one table read per state (a one-row read for a state only
 * counted). The total is the sum of the states' totals.
 */
async function listAlarms(args: Record<string, unknown>, api: Api) {
  const include = new Set([5, 14]);
  if (args.include_acknowledged) include.add(13);
  if (args.include_warnings) include.add(4);
  if (args.include_unusual) include.add(10);
  const codes = ALARM_ORDER.filter((c) => include.has(c));
  const limit = int(args.limit) ?? 100;
  const offset = int(args.offset) ?? 0;
  const id = int(args.parent_id);
  const name = subFilter('name', str(args.name), 'name');

  const countsP = id === undefined ? status(api).then((s) => s.sensors).catch(() => undefined) : Promise.resolve(undefined);
  const items: Record<string, unknown>[] = [];
  let before = 0; // alarms in the states already read
  for (const code of codes) {
    const need = limit - items.length;
    const start = Math.max(0, offset - before);
    const params: Params = [['filter_status', code], ...name];
    const p = await api.table('sensors', {
      columns: SENSOR_COLUMNS,
      id,
      params,
      limit: need > 0 ? need : 1,
      offset: need > 0 ? start : 0,
    });
    if (need > 0) items.push(...p.items.slice(0, need));
    before += p.total;
  }
  const counts = await countsP;
  return compact({ wholeServer: counts, ...paged({ total: before, offset, items }, sensorRow) });
}

// --- Sensor details ---------------------------------------------------------------------------

async function getSensor(args: Record<string, unknown>, api: Api) {
  const id = args.sensor_id as number;
  const [details, channels] = await Promise.all([
    api.get('getsensordetails.json', [['id', id]]),
    api.table('channels', { columns: CHANNEL_COLUMNS, id, limit: 200, keepRepeats: true }),
  ]);
  const d = (details.sensordata ?? {}) as Record<string, unknown>;
  if (!clean(d.name)) throw new InputError(`PRTG has no sensor ${id} that this token can read`);
  return compact({
    id,
    name: clean(d.name, 200),
    type: clean(d.sensortype, 100),
    device: clean(d.parentdevicename, 200),
    deviceId: num(d.parentdeviceid),
    group: clean(d.parentgroupname, 200),
    probe: clean(d.probename, 200),
    state: stateOf(d.statusid),
    status: clean(d.statustext, 60),
    message: clean(d.lastmessage, 500),
    lastValue: clean(d.lastvalue, 100),
    interval: clean(d.interval, 60),
    lastCheck: clean(d.lastcheck, 80),
    lastUp: clean(d.lastup, 80),
    lastDown: clean(d.lastdown, 80),
    uptime: clean(d.uptime, 40),
    uptimeFor: clean(d.uptimetime, 80),
    downtime: clean(d.downtime, 40),
    downtimeFor: clean(d.downtimetime, 80),
    statsSince: clean(d.updownsince, 80),
    channels: channels.items.map(channelRow),
  });
}

// --- Devices --------------------------------------------------------------------------------

async function getDevice(args: Record<string, unknown>, api: Api) {
  const id = args.device_id as number;
  const [dev, sensors] = await Promise.all([
    api.table('devices', { columns: DEVICE_COLUMNS, params: [['filter_objid', id]], limit: 1 }),
    api.table('sensors', { columns: SENSOR_COLUMNS, id, limit: int(args.sensor_limit) }),
  ]);
  if (dev.items.length === 0) throw new InputError(`PRTG has no device ${id} that this token can read`);
  const rows = sensors.items.map(sensorRow);
  const notUp = rows.filter((r) => r.state !== 'up');
  return compact({
    ...deviceRow(dev.items[0]),
    sensorList: compact({
      total: sensors.total,
      listed: rows.length,
      note: sensors.total > rows.length ? `listed ${rows.length} of ${sensors.total} sensors; raise sensor_limit or use prtg_list_sensors with parent_id` : undefined,
      notUp,
      up: rows.filter((r) => r.state === 'up').map((r) => compact({ id: r.id, name: r.name, lastValue: r.lastValue })),
    }),
  });
}

// --- Logs -----------------------------------------------------------------------------------

export const LOG_PERIODS = ['today', 'yesterday', '7days', '30days', '6months', '12months'] as const;

async function listLogs(args: Record<string, unknown>, api: Api) {
  const params: Params = [['filter_drel', args.period as string]];
  const page = await api.table('messages', {
    columns: ['objid', 'datetime', 'parent', 'type', 'name', 'status', 'message'],
    id: int(args.object_id),
    params,
    limit: int(args.limit),
    offset: int(args.offset),
  });
  return paged(page, (r) =>
    compact({
      time: clean(r.datetime, 40),
      objectId: num(r.objid_raw) ?? num(r.objid),
      object: clean(r.name, 200),
      parent: clean(r.parent, 200),
      objectType: clean(r.type, 40),
      event: clean(r.status, 60),
      message: clean(r.message_raw, 400) ?? clean(r.message, 400),
    })
  );
}

// --- Search -----------------------------------------------------------------------------------

const SEARCH_KINDS = ['groups', 'devices', 'sensors'] as const;

async function search(args: Record<string, unknown>, api: Api) {
  const q = args.query as string;
  if (q.length < 2) throw new InputError('query must be at least 2 characters');
  const kinds = (args.kinds as string[] | undefined) ?? [...SEARCH_KINDS];
  const n = int(args.limit);
  const out: Record<string, unknown> = { query: q };
  const jobs: Promise<void>[] = [];
  if (kinds.includes('groups')) {
    jobs.push(
      api.table('groups', { columns: GROUP_COLUMNS, params: subFilter('name', q, 'query'), limit: n }).then((p) => {
        out.groups = paged(p, groupRow);
      })
    );
  }
  if (kinds.includes('devices')) {
    // A device matches on its name or its host (address); PRTG cannot OR two columns, so two reads.
    jobs.push(
      Promise.all([
        api.table('devices', { columns: DEVICE_COLUMNS, params: subFilter('name', q, 'query'), limit: n }),
        api.table('devices', { columns: DEVICE_COLUMNS, params: subFilter('host', q, 'query'), limit: n }),
      ]).then(([byName, byHost]) => {
        const seen = new Set<unknown>();
        const items = [...byName.items, ...byHost.items].filter((r) => {
          const id = num(r.objid_raw) ?? num(r.objid);
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        out.devices = compact({
          matchedByName: byName.total,
          matchedByHost: byHost.total,
          items: items.slice(0, n).map(deviceRow),
        });
      })
    );
  }
  if (kinds.includes('sensors')) {
    jobs.push(
      api.table('sensors', { columns: SENSOR_COLUMNS, params: subFilter('name', q, 'query'), limit: n }).then((p) => {
        out.sensors = paged(p, sensorRow);
      })
    );
  }
  await Promise.all(jobs);
  return out;
}

// --- Specs ----------------------------------------------------------------------------------

export const READ_SPECS: ToolSpec[] = [
  {
    name: 'prtg_status',
    description:
      'PRTG server status: version, server clock, sensor counts by state (down, partial down, acknowledged, warning, unusual, paused, up), new alarms and log entries, and whether the token user is read-only. Start here to check the connection.',
    params: {},
    untrusted: false,
    run: (_a, api) => status(api),
  },
  {
    name: 'prtg_list_probes',
    description: 'List PRTG probes (the local probe and remote probes, usually one per client site) with their connection state and sensor counts.',
    params: { name: nameFilter('probes'), limit: limit(100), offset },
    run: async (a, api) =>
      paged(
        await api.table('probenodes', {
          columns: PROBE_COLUMNS,
          params: [['filter_parentid', 0], ...subFilter('name', str(a.name), 'name')],
          limit: int(a.limit),
          offset: int(a.offset),
        }),
        probeRow
      ),
  },
  {
    name: 'prtg_list_groups',
    description: 'List PRTG groups (folders of devices, often one per client or site) with sensor counts by state. Filter by name or by a parent probe/group.',
    params: { name: nameFilter('groups'), parent_id: parentId('groups'), limit: limit(100), offset },
    run: async (a, api) =>
      paged(
        await api.table('groups', {
          columns: GROUP_COLUMNS,
          id: int(a.parent_id),
          params: subFilter('name', str(a.name), 'name'),
          limit: int(a.limit),
          offset: int(a.offset),
        }),
        groupRow
      ),
  },
  {
    name: 'prtg_list_devices',
    description:
      'List PRTG devices with host (address), group, probe, state and sensor counts. Filter by name, host, state, or a parent probe/group (parent_id, e.g. a client group).',
    params: {
      name: nameFilter('devices'),
      host: { type: 'string', description: 'Only devices whose host (IP address or DNS name) contains this text.', maxLength: 100 },
      status: {
        type: 'string_list',
        description: 'Only devices in these states.',
        enum: STATUS_FILTER_NAMES,
        maxItems: STATUS_FILTER_NAMES.length,
      },
      parent_id: parentId('devices'),
      limit: limit(100),
      offset,
    },
    run: async (a, api) =>
      paged(
        await api.table('devices', {
          columns: DEVICE_COLUMNS,
          id: int(a.parent_id),
          params: [...subFilter('name', str(a.name), 'name'), ...subFilter('host', str(a.host), 'host'), ...statusParams(a.status as string[] | undefined)],
          limit: int(a.limit),
          offset: int(a.offset),
        }),
        deviceRow
      ),
  },
  {
    name: 'prtg_get_device',
    description: "One PRTG device: host, group, probe, state, sensor counts, every sensor that is not up (with its message) and the names of the ones that are.",
    params: {
      device_id: { type: 'int', description: 'PRTG device ID.', required: true, min: 0 },
      sensor_limit: { type: 'int', description: 'Most sensors to list (1-500).', min: 1, max: 500, default: 200 },
    },
    run: getDevice,
  },
  {
    name: 'prtg_list_sensors',
    description:
      'List PRTG sensors with state, message and last value. Filter by state (down, warning, paused, unusual, ...), name, or a parent probe/group/device (parent_id).',
    params: {
      status: {
        type: 'string_list',
        description: 'Only sensors in these states. paused covers paused by user, dependency, schedule, licence and paused-until.',
        enum: STATUS_FILTER_NAMES,
        maxItems: STATUS_FILTER_NAMES.length,
      },
      name: nameFilter('sensors'),
      parent_id: parentId('sensors'),
      limit: limit(100),
      offset,
    },
    run: async (a, api) =>
      paged(
        await api.table('sensors', {
          columns: SENSOR_COLUMNS,
          id: int(a.parent_id),
          params: [...statusParams(a.status as string[] | undefined), ...subFilter('name', str(a.name), 'name')],
          limit: int(a.limit),
          offset: int(a.offset),
        }),
        sensorRow
      ),
  },
  {
    name: 'prtg_list_alarms',
    description:
      'Current PRTG alarms: sensors that are down or partially down, plus (by default) acknowledged, warning and unusual ones, worst first, with message and how long they have been down. Optionally only below a probe/group/device.',
    params: {
      parent_id: parentId('alarms'),
      name: nameFilter('sensors'),
      include_acknowledged: { type: 'boolean', description: 'Include down sensors someone acknowledged.', default: true },
      include_warnings: { type: 'boolean', description: 'Include sensors in warning.', default: true },
      include_unusual: { type: 'boolean', description: 'Include sensors flagged unusual.', default: true },
      limit: limit(100),
      offset,
    },
    run: listAlarms,
  },
  {
    name: 'prtg_get_sensor',
    description:
      "One PRTG sensor: type, device, state, last message and value, check interval, last up/down, uptime and downtime, and every channel's last value.",
    params: { sensor_id: { type: 'int', description: 'PRTG sensor ID.', required: true, min: 0 } },
    run: getSensor,
  },
  {
    name: 'prtg_get_sensor_history',
    description:
      `Historic data of one PRTG sensor over a time range (at most ${MAX_RANGE_HOURS / 24} days): per-channel min, max, mean and last over the whole range, plus up to max_rows averaged intervals. ` +
      'Give hours (back from now) or start/end in PRTG server local time. The average interval is picked automatically unless average_seconds is given.',
    params: {
      sensor_id: { type: 'int', description: 'PRTG sensor ID.', required: true, min: 0 },
      hours: { type: 'int', description: `Hours back from now (1-${MAX_RANGE_HOURS}). Default 24 when start is not given.`, min: 1, max: MAX_RANGE_HOURS },
      start: { type: 'string', description: 'Range start, "YYYY-MM-DD HH:MM", PRTG server local time.', maxLength: 19 },
      end: { type: 'string', description: 'Range end, "YYYY-MM-DD HH:MM", PRTG server local time. Default now.', maxLength: 19 },
      average_seconds: {
        type: 'int',
        description: `Averaging interval in seconds: one of ${AVERAGES.join(', ')} (0 = raw values, ranges up to 24 hours only).`,
        min: 0,
        max: 86400,
      },
      channels: { type: 'string_list', description: 'Only channels whose name contains one of these texts.', maxItems: 10, maxLength: 100 },
      max_rows: { type: 'int', description: `Most intervals to list (1-${MAX_ROWS}); summaries always cover all.`, min: 1, max: MAX_ROWS, default: 100 },
    },
    run: (a, api) => sensorHistory(a as unknown as HistoryArgs, api),
  },
  {
    name: 'prtg_list_logs',
    description:
      'Recent PRTG log entries (state changes, alarms, notifications, acknowledgements, configuration changes), newest first, for the whole server or one object and everything below it.',
    params: {
      object_id: { type: 'int', description: 'Only entries for this PRTG object (probe, group, device or sensor ID) and below.', min: 0 },
      period: { type: 'string', description: 'Time window.', enum: LOG_PERIODS, default: 'today' },
      limit: limit(50),
      offset,
    },
    run: listLogs,
  },
  {
    name: 'prtg_search',
    description:
      'Search PRTG by text: groups and sensors whose name contains it, devices whose name or host (address) contains it. Use it to find the ID of a client, site, device or sensor.',
    params: {
      query: { type: 'string', description: 'Text to look for (2-100 characters).', required: true, maxLength: 100 },
      kinds: { type: 'string_list', description: 'What to search (default all).', enum: SEARCH_KINDS, maxItems: 3 },
      limit: limit(20, 100),
    },
    run: search,
  },
];
