import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ConfigError, getConfig, makeApi, scrub } from '../client.js';
import type { Api } from '../client.js';
import { PrtgAuthError, PrtgRateLimitError } from '../types.js';
import type { CallToolResult } from './types.js';
import { InputError, errorResult, missingConfigResult, redactSecrets, textResult, untrustedResult } from './shared.js';

/**
 * Every tool is a row in a table: a name, typed parameters, and a `run`
 * function that calls fixed PRTG endpoints with fixed columns. No tool takes
 * a free-form endpoint, column or filter; every value is validated first.
 * Every tool is read-only (GET).
 */

export type ParamType = 'string' | 'int' | 'boolean' | 'string_list';

export interface ParamSpec {
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  maxItems?: number;
  maxLength?: number;
  /** Used when the caller leaves the parameter out. */
  default?: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  params: Record<string, ParamSpec>;
  /**
   * The result carries text from monitored devices (names, messages, logs) and
   * is wrapped as untrusted data. Default true; only results built from PRTG's
   * own counters set it false.
   */
  untrusted?: boolean;
  run: (args: Record<string, unknown>, api: Api) => Promise<unknown>;
}

function jsonSchemaFor(p: ParamSpec): Record<string, unknown> {
  const description = p.description;
  const dflt = p.default !== undefined ? { default: p.default } : {};
  switch (p.type) {
    case 'boolean':
      return { type: 'boolean', description, ...dflt };
    case 'int':
      return {
        type: 'integer',
        description,
        ...(p.min !== undefined ? { minimum: p.min } : {}),
        ...(p.max !== undefined ? { maximum: p.max } : {}),
        ...dflt,
      };
    case 'string_list':
      return {
        type: 'array',
        items: { type: 'string', ...(p.enum ? { enum: [...p.enum] } : {}) },
        description,
        ...(p.maxItems !== undefined ? { maxItems: p.maxItems } : {}),
        ...dflt,
      };
    default:
      return {
        type: 'string',
        description,
        ...(p.enum ? { enum: [...p.enum] } : {}),
        ...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {}),
        ...dflt,
      };
  }
}

export function buildTool(spec: ToolSpec): Tool {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, p] of Object.entries(spec.params)) {
    properties[key] = jsonSchemaFor(p);
    if (p.required) required.push(key);
  }
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  };
}

function convert(key: string, p: ParamSpec, value: unknown): unknown {
  switch (p.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new InputError(`${key} must be true or false`);
      return value;
    case 'int': {
      const n = typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isSafeInteger(n)) throw new InputError(`${key} must be a whole number`);
      if (p.min !== undefined && n < p.min) throw new InputError(`${key} must be at least ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new InputError(`${key} must be at most ${p.max}`);
      return n;
    }
    case 'string_list': {
      const list = typeof value === 'string' ? [value] : value;
      if (!Array.isArray(list) || list.length === 0) throw new InputError(`${key} must be a non-empty list`);
      if (p.maxItems !== undefined && list.length > p.maxItems) throw new InputError(`${key} can have at most ${p.maxItems} entries`);
      const out = list.map((v, i) => {
        if (typeof v !== 'string' || v.trim() === '') throw new InputError(`${key}[${i}] must be text`);
        const s = v.trim();
        if (p.enum) {
          const match = p.enum.find((e) => e.toLowerCase() === s.toLowerCase());
          if (!match) throw new InputError(`${key}[${i}] must be one of: ${p.enum.join(', ')}`);
          return match;
        }
        if (p.maxLength !== undefined && s.length > p.maxLength) throw new InputError(`${key}[${i}] is longer than ${p.maxLength} characters`);
        return s;
      });
      return [...new Set(out)];
    }
    default: {
      if (typeof value !== 'string') throw new InputError(`${key} must be text`);
      const s = value.trim();
      if (s === '') throw new InputError(`${key} must not be empty`);
      if (p.enum) {
        const match = p.enum.find((e) => e.toLowerCase() === s.toLowerCase());
        if (!match) throw new InputError(`${key} must be one of: ${p.enum.join(', ')}`);
        return match;
      }
      if (p.maxLength !== undefined && s.length > p.maxLength) throw new InputError(`${key} is longer than ${p.maxLength} characters`);
      return s;
    }
  }
}

/** Validates the arguments; returns them converted, with defaults filled in. Exported for tests. */
export function validateArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(args)) {
    if (!(key in spec.params)) throw new InputError(`Unknown parameter: ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    const given = args[key];
    const raw = given === undefined || given === null ? p.default : given;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
      if (p.required) throw new InputError(`${key} is required`);
      continue;
    }
    out[key] = convert(key, p, raw);
  }
  return out;
}

export async function runSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<CallToolResult> {
  let config;
  try {
    config = getConfig();
  } catch (err) {
    if (err instanceof ConfigError) return errorResult(err.message);
    throw err;
  }
  if (!config) return missingConfigResult();
  try {
    const valid = validateArgs(spec, args);
    const out = redactSecrets(await spec.run(valid, makeApi(config)));
    return spec.untrusted === false ? textResult(out) : untrustedResult(out);
  } catch (err) {
    const message = scrub((err as Error).message, config);
    if (err instanceof PrtgRateLimitError) {
      // Structured, so the MCP host's 429 cooldown and Claude can both read the wait.
      return errorResult(message, { error: 'rate_limited', retryAfterSeconds: err.retryAfterSeconds });
    }
    if (err instanceof PrtgAuthError) return errorResult(message, { error: 'auth_failed', httpStatus: err.httpStatus });
    return errorResult(message);
  }
}
