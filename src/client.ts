import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from './utils/logger.js';
import { fetchWithRateLimitRetry } from './rate-limit.js';
import type { FetchFn } from './rate-limit.js';
import { PrtgApiError, PrtgAuthError, PrtgRateLimitError } from './types.js';
import type { PrtgConfig, PrtgTable } from './types.js';

/** Largest response body read, in characters. */
const MAX_RESPONSE_CHARS = 25_000_000;
/** Wait reported for a 429 that does not say how long. */
const DEFAULT_RETRY_AFTER_SECONDS = 60;
/** Largest page asked of table.json. */
export const MAX_PAGE = 500;

const TOKEN_HINT =
  ' Check PRTG_API_TOKEN: an API key of an enabled PRTG user (PRTG: Setup > Account Settings > My Account > API Keys), copied whole.';
const DNS_HINT =
  ' The host name in PRTG_URL does not resolve. If it is pinned in /etc/hosts or a container extra_hosts entry, write it there in lower case: Node looks the name up in lower case and that lookup can be case-sensitive.';
const TLS_HINT =
  ' If the PRTG certificate is self-signed or issued for another name, set PRTG_ACCEPT_SELF_SIGNED=true.';
const NOT_JSON_HINT =
  ' PRTG_URL must be the PRTG web interface address (the one in a browser, e.g. https://prtg.example.local), not the API v2 Application Server on port 1616; an HTML answer is often the login page, which PRTG shows when the token is not accepted.';

// Request-scoped configuration, for tests and embedding. The MCP host uses the
// process environment (the service's env file).
const configStore = new AsyncLocalStorage<PrtgConfig>();

export function runWithConfig<T>(config: PrtgConfig, fn: () => T): T {
  return configStore.run(config, fn);
}

/** Thrown when PRTG_URL or PRTG_TIME_ZONE is set but not usable. */
export class ConfigError extends Error {}

const truthy = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v?.trim() ?? '');

/**
 * scheme://host[:port][/prefix] from PRTG_URL; a trailing /api, /index.htm or /
 * is dropped. https only, unless `allowHttp` (the token travels in the query string).
 */
export function parsePrtgUrl(raw: string, allowHttp = false): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ConfigError('PRTG_URL is not a valid URL (example: https://prtg.example.local).');
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new ConfigError(
      'PRTG_URL must start with https:// (the API token is sent with every request). Set PRTG_ALLOW_HTTP=true only for a trusted network path.'
    );
  }
  if (url.username || url.password) throw new ConfigError('PRTG_URL must not contain a user name or password.');
  if (url.search || url.hash) throw new ConfigError('PRTG_URL must not have a query string or fragment.');
  let path = url.pathname.replace(/\/+$/, '');
  path = path.replace(/\/(api|index\.htm|welcome\.htm|home)$/i, '');
  if (path !== '' && !/^(\/[A-Za-z0-9._-]+)+$/.test(path)) {
    throw new ConfigError('PRTG_URL must be the PRTG web interface address only, e.g. https://prtg.example.local.');
  }
  return `${url.origin}${path}`;
}

export function parseTimeZone(raw: string | undefined): string {
  const tz = raw?.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new ConfigError(`PRTG_TIME_ZONE "${tz.slice(0, 60)}" is not an IANA time zone (example: Australia/Sydney).`);
  }
  return tz;
}

export function getConfig(): PrtgConfig | null {
  const scoped = configStore.getStore();
  if (scoped?.base && scoped.token) return scoped;
  const rawUrl = process.env.PRTG_URL?.trim();
  const token = process.env.PRTG_API_TOKEN?.trim();
  if (!rawUrl || !token) {
    logger.warn('Missing configuration', { hasUrl: Boolean(rawUrl), hasToken: Boolean(token) });
    return null;
  }
  return {
    base: parsePrtgUrl(rawUrl, truthy(process.env.PRTG_ALLOW_HTTP)),
    token,
    acceptSelfSigned: truthy(process.env.PRTG_ACCEPT_SELF_SIGNED),
    timeZone: parseTimeZone(process.env.PRTG_TIME_ZONE),
  };
}

/** Removes the API token from any text that leaves this module. */
export function scrub(text: string, config: Pick<PrtgConfig, 'token'>): string {
  let out = text;
  if (config.token.length >= 4) {
    out = out.split(config.token).join('[REDACTED]');
    const encoded = encodeURIComponent(config.token);
    if (encoded !== config.token) out = out.split(encoded).join('[REDACTED]');
  }
  return out.replace(/(apitoken|passhash|password)=[^&\s"']+/gi, '$1=[REDACTED]');
}

// --- HTTP ------------------------------------------------------------------------------------

let insecureAgent: Agent | undefined;
let fetchOverride: FetchFn | undefined;

/** Tests replace the network with a fake fetch. */
export function setFetchForTests(fn?: FetchFn): void {
  fetchOverride = fn;
}

function fetchFor(config: PrtgConfig): FetchFn {
  if (fetchOverride) return fetchOverride;
  if (!config.acceptSelfSigned) return undiciFetch as unknown as FetchFn;
  insecureAgent ??= new Agent({ connect: { rejectUnauthorized: false } });
  const agent = insecureAgent;
  return (url, init) => undiciFetch(url, { ...(init as object), dispatcher: agent } as never) as unknown as Promise<Response>;
}

/** Query parameters in order; a name may repeat (PRTG ORs repeated filter_status). */
export type Params = [string, string | number][];

const ENDPOINTS = new Set(['table.json', 'status.json', 'getsensordetails.json', 'historicdata.json']);

/** Builds <base>/api/<endpoint>?params&apitoken=... */
export function buildUrl(config: Pick<PrtgConfig, 'base' | 'token'>, endpoint: string, params: Params = []): string {
  if (!ENDPOINTS.has(endpoint)) throw new Error(`Bad API endpoint: ${endpoint}`);
  const url = new URL(`${config.base}/api/${endpoint}`);
  for (const [k, v] of params) url.searchParams.append(k, String(v));
  url.searchParams.set('apitoken', config.token);
  return url.toString();
}

function describeNetworkError(err: unknown, config: PrtgConfig): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e.name === 'TimeoutError') return 'timed out';
  const code = e.cause?.code ?? '';
  const detail = scrub(`${e.cause?.message ?? e.message}`, config).slice(0, 200);
  const tls = /CERT|SELF_SIGNED|ALTNAME|UNABLE_TO_VERIFY|TLS|SSL/i.test(`${code} ${detail}`);
  const dns = /ENOTFOUND|EAI_AGAIN/.test(code);
  return `failed (${code || e.name}: ${detail}).${tls ? TLS_HINT : ''}${dns ? DNS_HINT : ''}`;
}

/** PRTG's JSON error body is {"prtg-version": "...", "error": "..."}. */
function errorDetail(body: string, config: PrtgConfig): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed?.error === 'string' && parsed.error) {
      return scrub(parsed.error, config).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    }
  } catch {
    // not JSON
  }
  return scrub(body, config).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Parses PRTG's JSON. Some PRTG versions put raw control characters (a tab or
 * line break from a sensor message) inside strings, which JSON.parse rejects;
 * those are turned into spaces and the parse is tried once more.
 */
export function parsePrtgJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // eslint-disable-next-line no-control-regex
    return JSON.parse(text.replace(/[\u0000-\u001f]/g, ' '));
  }
}

/**
 * One GET to the classic API; returns the parsed JSON object. Retried once
 * after a short 429. Errors carry the endpoint, status and PRTG's message,
 * never the token.
 */
export async function request<T = Record<string, unknown>>(
  config: PrtgConfig,
  endpoint: string,
  params: Params = [],
  timeoutMs = 60_000
): Promise<T> {
  const url = buildUrl(config, endpoint, params);
  const label = `GET /api/${endpoint}`;
  let result;
  try {
    result = await fetchWithRateLimitRetry(fetchFor(config), url, label, true, () => ({
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    }));
  } catch (err) {
    throw new PrtgApiError(`PRTG ${label} ${describeNetworkError(err, config)}`);
  }
  const { res } = result;

  if (res.status === 429 || (res.status === 503 && result.retryAfterMs !== undefined)) {
    const wait = result.retryAfterMs !== undefined ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : DEFAULT_RETRY_AFTER_SECONDS;
    throw new PrtgRateLimitError(`PRTG rate-limited the request (HTTP ${res.status}): ${label}. Try again in ${wait} s.`, wait);
  }

  const length = Number(res.headers.get('content-length') ?? '0');
  if (length > MAX_RESPONSE_CHARS) {
    await res.body?.cancel().catch(() => undefined);
    throw new PrtgApiError(`PRTG ${label}: response too large (${length} bytes)`, res.status);
  }
  const text = result.body ?? (await res.text());
  if (text.length > MAX_RESPONSE_CHARS) throw new PrtgApiError(`PRTG ${label}: response too large`, res.status);

  if (res.status === 401 || res.status === 403) {
    const message = errorDetail(text, config);
    throw new PrtgAuthError(
      `PRTG refused the request (HTTP ${res.status}): ${label}${message ? ` - ${message}` : ''}.${res.status === 401 ? TOKEN_HINT : " The token's user may not have access to this object."}`,
      res.status
    );
  }
  if (!res.ok) {
    const message = errorDetail(text, config);
    throw new PrtgApiError(`PRTG ${label} failed: HTTP ${res.status}${message ? ` - ${message}` : ''}`, res.status);
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<')) {
    throw new PrtgApiError(`PRTG ${label}: the answer is HTML, not JSON.${NOT_JSON_HINT}`, res.status);
  }
  let parsed: unknown;
  try {
    parsed = parsePrtgJson(text);
  } catch {
    throw new PrtgApiError(`PRTG ${label}: the response is not JSON.${NOT_JSON_HINT}`, res.status);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PrtgApiError(`PRTG ${label}: unexpected response`, res.status);
  }
  const err = (parsed as { error?: unknown }).error;
  if (typeof err === 'string' && err) {
    throw new PrtgApiError(`PRTG ${label}: ${errorDetail(JSON.stringify({ error: err }), config)}`, res.status);
  }
  return parsed as T;
}

// --- Tables -----------------------------------------------------------------------------------

export interface Page<T> {
  total: number;
  offset: number;
  items: T[];
}

/** table.json content types used here, and the key PRTG answers each under. */
export type Content = 'probenodes' | 'groups' | 'devices' | 'sensors' | 'channels' | 'messages';

export interface TableQuery {
  columns: readonly string[];
  /** Start object (a probe, group or device): limits the table to what is below it. */
  id?: number;
  /** Extra filter_*, sortby and similar parameters. */
  params?: Params;
  limit?: number;
  offset?: number;
}

/** The read-only API handed to tools. Every call is a GET. */
export interface Api {
  readonly config: Pick<PrtgConfig, 'timeZone'>;
  get<T = Record<string, unknown>>(endpoint: string, params?: Params): Promise<T>;
  table<T = Record<string, unknown>>(content: Content, query: TableQuery): Promise<Page<T>>;
}

export function makeApi(config: PrtgConfig): Api {
  return {
    config: { timeZone: config.timeZone },
    get: (endpoint, params = []) => request(config, endpoint, params),
    async table<T>(content: Content, q: TableQuery): Promise<Page<T>> {
      const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_PAGE);
      const offset = Math.max(q.offset ?? 0, 0);
      const params: Params = [
        ['content', content],
        ['columns', q.columns.join(',')],
        ['count', limit],
        ['start', offset],
        ...(q.id !== undefined ? ([['id', q.id]] as Params) : []),
        ...(q.params ?? []),
      ];
      const body = await request<PrtgTable>(config, 'table.json', params);
      const rows = body[content];
      const items = (Array.isArray(rows) ? rows : []) as T[];
      const total = typeof body.treesize === 'number' ? body.treesize : offset + items.length;
      return { total, offset, items };
    },
  };
}
