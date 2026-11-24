/**
 * Paessler PRTG Network Monitor, classic HTTP API (/api/*.json). Works on every
 * on-premises PRTG version since 22.1 (API tokens); the PRTG 25+ API v2 is a
 * separate service (the Application Server) and is not used here.
 *
 * Authentication is an API token (PRTG: Setup > Account Settings > API Keys,
 * or the user's "My Account" page), sent as the `apitoken` query parameter on
 * every request. The token has the rights of its PRTG user: make that user
 * read-only.
 */
export interface PrtgConfig {
  /** scheme://host[:port], plus a path prefix when PRTG is served under one (no trailing slash). */
  base: string;
  token: string;
  /** Skip certificate verification (self-signed, or a certificate for another name). */
  acceptSelfSigned: boolean;
  /** IANA time zone of the PRTG core server; PRTG reads and writes historic-data times in it. */
  timeZone: string;
}

/** PRTG refused the token (401) or its user may not read this (403). */
export class PrtgAuthError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
  }
}

/** PRTG (or a proxy in front of it) rate-limited the request (HTTP 429, or 503 with Retry-After). */
export class PrtgRateLimitError extends Error {
  readonly code = 'rate_limited';
  constructor(message: string, readonly retryAfterSeconds: number) {
    super(message);
  }
}

/** Any other failure: a non-2xx response, a network error, an unreadable body. */
export class PrtgApiError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
  }
}

/** A table.json answer: `treesize` (total matches) plus one array named after the content. */
export interface PrtgTable {
  'prtg-version'?: string;
  treesize?: number;
  [content: string]: unknown;
}
